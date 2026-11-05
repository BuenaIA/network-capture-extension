// Streaming ZIP writer (STORE method, no compression).
// Exposes globalThis.NCPZip = { writeTo(files, sink), crc32 }
//   files: iterable of { name: string, parts: iterable of string | Uint8Array }
//   sink:  object with write(bytes: Uint8Array), receives the archive in order
// Each file is written as its parts are produced. Its CRC and sizes go into a data
// descriptor after the data, so the archive never has to exist as one buffer.
// Zip64 records are written when there are more than 65,534 entries or the archive is
// larger than 4 GiB. A single file must still be smaller than 4 GiB.
(function () {
  const enc = new TextEncoder();
  const U16_MAX = 0xffff;
  const U32_MAX = 0xffffffff;

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    return table;
  })();

  // Running CRC: start with 0xFFFFFFFF, finish by inverting
  function crcUpdate(crc, bytes) {
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return crc;
  }

  function crc32(bytes) {
    return (crcUpdate(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
  }

  function dosTimeDate(d) {
    const t = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1F);
    const dd = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
    return { t: t & 0xFFFF, d: dd & 0xFFFF };
  }

  // Flag 0x0808: names are UTF-8, and sizes and CRC follow the data in a descriptor
  const FLAGS = 0x0808;
  const VERSION = 45;  // 4.5, needed for zip64

  function localHeader(name, dosT, dosD) {
    const header = new Uint8Array(30 + name.length);
    const v = new DataView(header.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, VERSION, true);
    v.setUint16(6, FLAGS, true);
    v.setUint16(8, 0, true);        // method: store
    v.setUint16(10, dosT, true);
    v.setUint16(12, dosD, true);
    v.setUint32(14, 0, true);       // crc: in the descriptor
    v.setUint32(18, 0, true);       // compressed size: in the descriptor
    v.setUint32(22, 0, true);       // size: in the descriptor
    v.setUint16(26, name.length, true);
    v.setUint16(28, 0, true);
    header.set(name, 30);
    return header;
  }

  function dataDescriptor(crc, size) {
    const d = new Uint8Array(16);
    const v = new DataView(d.buffer);
    v.setUint32(0, 0x08074b50, true);
    v.setUint32(4, crc, true);
    v.setUint32(8, size, true);
    v.setUint32(12, size, true);
    return d;
  }

  function centralHeader(name, dosT, dosD, crc, size, offset) {
    const zip64Offset = offset > U32_MAX;
    const extra = zip64Offset ? 12 : 0;  // id (2) + data size (2) + offset (8)
    const header = new Uint8Array(46 + name.length + extra);
    const v = new DataView(header.buffer);
    v.setUint32(0, 0x02014b50, true);
    v.setUint16(4, VERSION, true);  // version made by
    v.setUint16(6, VERSION, true);  // version needed
    v.setUint16(8, FLAGS, true);
    v.setUint16(10, 0, true);
    v.setUint16(12, dosT, true);
    v.setUint16(14, dosD, true);
    v.setUint32(16, crc, true);
    v.setUint32(20, size, true);
    v.setUint32(24, size, true);
    v.setUint16(28, name.length, true);
    v.setUint16(30, extra, true);
    v.setUint16(32, 0, true);       // comment length
    v.setUint16(34, 0, true);       // disk number
    v.setUint16(36, 0, true);       // internal attributes
    v.setUint32(38, 0, true);       // external attributes
    v.setUint32(42, zip64Offset ? U32_MAX : offset, true);
    header.set(name, 46);
    if (zip64Offset) {
      v.setUint16(46 + name.length, 0x0001, true);
      v.setUint16(48 + name.length, 8, true);
      v.setUint32(50 + name.length, offset % 0x100000000, true);
      v.setUint32(54 + name.length, Math.floor(offset / 0x100000000), true);
    }
    return header;
  }

  // End of central directory, preceded by zip64 records when the archive needs them
  function endRecords(count, centralSize, centralOffset) {
    const zip64 = count > U16_MAX - 1 || centralSize > U32_MAX || centralOffset > U32_MAX;
    const parts = [];
    if (zip64) {
      const eocd64Offset = centralOffset + centralSize;
      const rec = new Uint8Array(56);
      const r = new DataView(rec.buffer);
      r.setUint32(0, 0x06064b50, true);
      r.setBigUint64(4, 44n, true);   // size of the rest of this record
      r.setUint16(12, VERSION, true);
      r.setUint16(14, VERSION, true);
      r.setUint32(16, 0, true);
      r.setUint32(20, 0, true);
      r.setBigUint64(24, BigInt(count), true);
      r.setBigUint64(32, BigInt(count), true);
      r.setBigUint64(40, BigInt(centralSize), true);
      r.setBigUint64(48, BigInt(centralOffset), true);
      const locator = new Uint8Array(20);
      const l = new DataView(locator.buffer);
      l.setUint32(0, 0x07064b50, true);
      l.setUint32(4, 0, true);
      l.setBigUint64(8, BigInt(eocd64Offset), true);
      l.setUint32(16, 1, true);
      parts.push(rec, locator);
    }
    const eocd = new Uint8Array(22);
    const e = new DataView(eocd.buffer);
    e.setUint32(0, 0x06054b50, true);
    e.setUint16(4, 0, true);
    e.setUint16(6, 0, true);
    e.setUint16(8, Math.min(count, U16_MAX), true);
    e.setUint16(10, Math.min(count, U16_MAX), true);
    e.setUint32(12, Math.min(centralSize, U32_MAX), true);
    e.setUint32(16, Math.min(centralOffset, U32_MAX), true);
    e.setUint16(20, 0, true);
    parts.push(eocd);
    return parts;
  }

  function writeTo(files, sink) {
    const { t: dosT, d: dosD } = dosTimeDate(new Date());
    const central = [];
    let offset = 0;
    const write = bytes => { sink.write(bytes); offset += bytes.length; };

    for (const file of files) {
      const name = enc.encode(file.name);
      const localOffset = offset;
      write(localHeader(name, dosT, dosD));
      let crc = 0xffffffff, size = 0;
      for (const part of file.parts) {
        const bytes = typeof part === 'string' ? enc.encode(part) : part;
        crc = crcUpdate(crc, bytes);
        size += bytes.length;
        write(bytes);
      }
      crc = (crc ^ 0xffffffff) >>> 0;
      write(dataDescriptor(crc, size));
      central.push(centralHeader(name, dosT, dosD, crc, size, localOffset));
    }

    const centralOffset = offset;
    for (const record of central) write(record);
    const centralSize = offset - centralOffset;
    for (const part of endRecords(central.length, centralSize, centralOffset)) write(part);
  }

  globalThis.NCPZip = { writeTo, crc32 };
})();

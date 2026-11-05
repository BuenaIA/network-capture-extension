// Helpers shared by the service worker (importScripts) and the offscreen document (<script>).
// Exposes globalThis.NCP = { compact, summarize }.
(function () {
  function isEmpty(value) {
    if (value === undefined || value === null || value === '' || value === false) return true;
    if (Array.isArray(value)) return value.length === 0;
    return typeof value === 'object' && Object.keys(value).length === 0;
  }

  // Copy of `obj` without empty values (undefined, null, '', false, [] and {}), so a record
  // only carries what was actually captured. Zero is kept: it is a real value.
  function compact(obj) {
    const out = {};
    for (const [key, value] of Object.entries(obj)) if (!isEmpty(value)) out[key] = value;
    return out;
  }

  // Fields the list rows and the sort need. Full records are too big to send for every row.
  const SUMMARY_FIELDS = ['id', 'seq', 'capturedAt', 'method', 'url', 'hostname', 'pathname', 'search',
    'resourceType', 'responseStatus', 'responseMimeType', 'encodedDataLength', 'duration', 'failed', 'incomplete'];

  function summarize(entry) {
    const summary = {};
    for (const key of SUMMARY_FIELDS) if (entry[key] !== undefined) summary[key] = entry[key];
    return summary;
  }

  globalThis.NCP = { compact, summarize };
})();

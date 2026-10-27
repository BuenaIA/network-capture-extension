# 📥 Installation

The extension is not published in the Chrome Web Store yet, so you install it by loading it manually into Chrome. There are two ways to get the files:

- **A. Download the ZIP** from the latest release (recommended for users).
- **B. Clone the repository** (recommended for developers).

Both end with the same step: loading the folder as an unpacked extension.

## 🅐 From the release ZIP (recommended)

1. Go to [Releases](https://github.com/BuenaIA/network-capture-extension/releases) and download `network-capture-extension-v1.0.0.zip` from the latest release.
2. **Unzip it** into a permanent folder, for example `Documents/network-capture-extension`. Chrome cannot load the `.zip` file directly. Keep the folder where it is: if you delete or move it, the extension stops working.
3. Open Chrome and visit `chrome://extensions`.
4. Toggle **Developer mode** (top-right corner).
5. Click **Load unpacked** and select the unzipped folder, the one that contains `manifest.json` (not a subfolder inside it).
6. Pin the extension to your toolbar (puzzle icon → 📌).

You're done. Click the icon to open the popup.

### Updating from the ZIP

Download the new ZIP, replace the contents of the folder with the new files, then click the ↻ refresh icon on the extension's card in `chrome://extensions`.

## 🅑 From source (for developers)

```bash
git clone https://github.com/BuenaIA/network-capture-extension.git
```

1. Open Chrome and visit `chrome://extensions`
2. Toggle **Developer mode** (top-right corner)
3. Click **Load unpacked**
4. Pick the cloned folder
5. Pin the extension to your toolbar (puzzle icon → 📌)

You're done. Click the icon to open the popup.

> ✅ **Tip** — when you `git pull` updates, click the ↻ refresh icon on the extension's card to reload the service worker, otherwise you'll be running a mix of old and new code.

> ⚠️ **Developer mode warning** — Chrome shows "Disable developer mode extensions" when it starts. This is expected for manually loaded extensions. Click **Cancel** to keep the extension running.

## 🛒 From the Chrome Web Store

_Coming soon_ — submission in progress. Once published, the link will appear here and in the README.

## 🧪 Verifying your install

Open the popup. You should see:

- The current **version badge** (`v1.0.0`) next to the name
- A **● Start** button (green when idle)
- A **Target site** row showing your current tab's URL

If the version badge is missing, the popup couldn't reach the service worker — see [[Troubleshooting]].

## 🧰 Requirements

- **Chrome 116** or newer (uses the offscreen-documents `BLOBS` reason and CDP `1.3`)
- **~5 MB** of free `chrome.storage.local` quota
- **Permission to attach the debugger** to a tab — Chrome will show a yellow notice bar when capture is running. This is required and unavoidable; it's a security feature, not a bug.

## 🌐 Other Chromium browsers

The extension is pure MV3 with no Chrome-only APIs apart from `chrome.debugger`, so it should also work on **Edge**, **Brave**, **Vivaldi**, **Opera** and **Arc**. The steps are the same: open the browser's extensions page (`edge://extensions`, `brave://extensions`, etc.), enable developer mode and load the unzipped folder. Reports welcome — please open an issue if you try one of these.

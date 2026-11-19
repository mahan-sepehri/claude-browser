// Which Chromium the engine runs.
//
// The engine brings its own browser: a "Chrome for Testing" build downloaded
// once into ~/.claude-browser/chromium. A browser installed on the machine
// (Chrome, Edge, Brave, Chromium) is only a stand-in while that download runs,
// or when the download is impossible.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = process.env.CLAUDE_BROWSER_HOME || path.join(os.homedir(), ".claude-browser");
const CACHE_DIR = process.env.CLAUDE_BROWSER_CHROMIUM_DIR || path.join(os.homedir(), ".claude-browser", "chromium");
// Tried in order; the mirror helps where Google's storage is slow or blocked.
const DOWNLOAD_BASES = [undefined, "https://cdn.npmmirror.com/binaries/chrome-for-testing"];

function lib() {
  return require("@puppeteer/browsers");
}

function systemBrowsers() {
  const home = os.homedir();
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    path.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  return candidates.filter(p => fs.existsSync(p));
}

const cmpVersion = (a, b) => {
  const x = String(a).split(".").map(Number);
  const y = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};

// Newest installed managed build, or null.
async function managedBrowser() {
  try {
    if (!fs.existsSync(CACHE_DIR)) return null;
    const { getInstalledBrowsers, Browser } = lib();
    const all = (await getInstalledBrowsers({ cacheDir: CACHE_DIR })).filter(b => b.browser === Browser.CHROME && fs.existsSync(b.executablePath));
    if (!all.length) return null;
    all.sort((a, b) => cmpVersion(b.buildId, a.buildId));
    return { executablePath: all[0].executablePath, version: all[0].buildId, kind: "managed" };
  } catch {
    return null;
  }
}

let installing = null;

// Downloads the current stable Chrome for Testing. onProgress(fraction 0..1).
function installManaged(onProgress) {
  if (installing) return installing;
  installing = (async () => {
    const { install, resolveBuildId, detectBrowserPlatform, Browser, uninstall, getInstalledBrowsers } = lib();
    const platform = detectBrowserPlatform();
    if (!platform) throw new Error(`unsupported platform ${process.platform}/${process.arch}`);
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const buildId = await resolveBuildId(Browser.CHROME, platform, "stable");
    let lastError;
    for (const baseUrl of DOWNLOAD_BASES) {
      try {
        let last = -1;
        await install({
          browser: Browser.CHROME,
          buildId,
          platform,
          cacheDir: CACHE_DIR,
          ...(baseUrl ? { baseUrl } : {}),
          downloadProgressCallback: (done, total) => {
            const f = total ? done / total : 0;
            if (onProgress && f - last >= 0.01) {
              last = f;
              onProgress(f);
            }
          },
        });
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
      }
    }
    if (lastError) throw lastError;
    // Keep only the build just installed.
    for (const b of await getInstalledBrowsers({ cacheDir: CACHE_DIR })) {
      if (b.browser === Browser.CHROME && b.buildId !== buildId) await uninstall({ browser: b.browser, buildId: b.buildId, platform: b.platform, cacheDir: CACHE_DIR }).catch(() => {});
    }
    const found = await managedBrowser();
    if (!found) throw new Error("browser download finished but no executable was found");
    return found;
  })().finally(() => {
    installing = null;
  });
  return installing;
}

/**
 * Picks the browser to launch right now.
 * mode: "auto" (own build, system as stand-in), "system", or an executable path.
 * Returns { executablePath, version?, kind: "managed"|"system"|"custom", needsInstall }.
 */
async function pickBrowser(mode) {
  const custom = process.env.CLAUDE_BROWSER_CHROME || (mode && mode !== "auto" && mode !== "system" ? mode : "");
  if (custom) {
    if (!fs.existsSync(custom)) throw new Error(`Browser not found at ${custom}`);
    return { executablePath: custom, kind: "custom", needsInstall: false };
  }
  const system = systemBrowsers()[0];
  if (mode === "system") {
    if (!system) throw new Error("No Chrome, Edge, Brave or Chromium is installed (set claudeBrowser.browser to \"auto\" to download one).");
    return { executablePath: system, kind: "system", needsInstall: false };
  }
  const managed = await managedBrowser();
  if (managed) return { ...managed, needsInstall: false };
  if (system) return { executablePath: system, kind: "system", needsInstall: true };
  return { executablePath: null, kind: "managed", needsInstall: true };
}

module.exports = { pickBrowser, installManaged, managedBrowser, systemBrowsers, cmpVersion, CACHE_DIR, HOME };

if (require.main === module) {
  // `node daemon/chromium.js install` — fetch the browser ahead of time.
  (async () => {
    if (process.argv[2] === "install") {
      let shown = -1;
      const b = await installManaged(f => {
        const pct = Math.floor(f * 100);
        if (pct >= shown + 5) {
          shown = pct;
          process.stdout.write(`downloading ${pct}%\n`);
        }
      });
      console.log("installed", b.version, b.executablePath);
    } else {
      console.log(await pickBrowser(process.argv[2] || "auto"));
    }
  })().catch(e => {
    console.error(e.message);
    process.exit(1);
  });
}

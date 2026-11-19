#!/usr/bin/env node
// Claude Browser engine: one headless Chrome tab shared by every viewer panel
// (WebSocket, live screencast + input) and by Claude (HTTP tool API used by
// the MCP server). Started on demand by the editor extension or the MCP server.
"use strict";

const http = require("http");
const { resolveMarkers, resolveLocation } = require("./sourcemap");
const fs = require("fs");
const os = require("os");
const { qrSvg } = require("./qr.js");
const path = require("path");
const crypto = require("crypto");
const { execSync, execFileSync } = require("child_process");
const { WebSocketServer } = require("ws");
const puppeteer = require("puppeteer-core");

const chromium = require("./chromium");

const VERSION = require("../package.json").version;
const PORT = Number(process.env.CLAUDE_BROWSER_PORT || 47321);
const HOME = process.env.CLAUDE_BROWSER_HOME || path.join(os.homedir(), ".claude-browser");
const PROFILE = path.join(HOME, "profile");
const TOKEN_FILE = path.join(HOME, "token");
const PID_FILE = path.join(HOME, "engine.pid");
const SESSION_FILE = path.join(HOME, "session.json");
const SHOTS_DIR = path.join(HOME, "screenshots");
const INPAGE = fs.readFileSync(path.join(__dirname, "inpage.js"), "utf8");
// Window mode: the toolbar shown in the page, and the side-by-side page.
const UI_SCRIPT = fs.readFileSync(path.join(__dirname, "fill.js"), "utf8") + "\n" + fs.readFileSync(path.join(__dirname, "ui.js"), "utf8");
const SHELL_HTML = fs.readFileSync(path.join(__dirname, "shell.html"), "utf8");
const MEDIA_DIR = path.join(__dirname, "..", "media");
// Settings written by the editor extension (the MCP server can start us too).
const CONFIG = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(HOME, "config.json"), "utf8")) || {};
  } catch {
    return {};
  }
})();
const START_URL = `http://127.0.0.1:${PORT}/start`;
const HOME_URL = process.env.CLAUDE_BROWSER_HOME_URL || CONFIG.homeUrl || START_URL;
const BROWSER_MODE = process.env.CLAUDE_BROWSER_ENGINE || CONFIG.browser || "auto";
const IDLE_EXIT_MS = 45 * 60 * 1000;
// "window": Chrome runs as a normal visible window next to the editor (drawn
// natively: sharp, no streaming). "panel" (default): headless, streamed into
// the editor panel.
// "cursor": no Chrome of our own. The engine attaches over CDP to Cursor's
// built-in Browser Tab (Cursor started with --remote-debugging-port), so the
// page is drawn natively inside the editor. Everything else is window mode.
const CURSOR_MODE = (process.env.CLAUDE_BROWSER_MODE || CONFIG.mode) === "cursor";
const CURSOR_PORT = Number(process.env.CLAUDE_BROWSER_CURSOR_PORT || CONFIG.cursorPort) || 9333;
// Cursor's docked DevTools for a Browser Tab is a webview target too: never a tab.
const isDevtoolsUrl = url => /^(devtools|chrome-devtools):/.test(url || "");
const WINDOW_MODE = CURSOR_MODE || (process.env.CLAUDE_BROWSER_MODE || CONFIG.mode) === "window";
const DEFAULT_VIEWPORT = { width: 1280, height: 800, dpr: 1 };
const DOWNLOAD_DIR = process.env.CLAUDE_BROWSER_DOWNLOADS || path.join(os.homedir(), "Downloads");
const DOWNLOAD_TMP = path.join(HOME, "downloads-tmp");
const PERMS_FILE = path.join(HOME, "permissions.json");
const HISTORY_FILE = path.join(HOME, "history.json");
const HISTORY_MAX = 3000;
// Live frames trade a little sharpness for speed; once the page stops moving
// a crisp still replaces the last one.
const STREAM_QUALITY = Math.min(95, Math.max(30, Number(CONFIG.streamQuality) || 72));
const SHARP_AFTER_MS = 160;
// Headless Chrome's screencast ignores the emulated deviceScaleFactor and
// always sends frames at the scale Chrome was started with (1x unless forced),
// which a retina panel then stretches 2x. So Chrome starts at the scale the
// panel last reported (saved in display.json). The emulated scale must never
// be lower than that start scale: Chrome then reports frame sizes divided by
// it after a scroll, and the panel shows the page shrunk.
const DISPLAY_FILE = path.join(HOME, "display.json");
function readRenderScale() {
  let v = Number(process.env.CLAUDE_BROWSER_RENDER_SCALE || CONFIG.renderScale);
  if (!v) {
    try {
      v = Math.round(Number(JSON.parse(fs.readFileSync(DISPLAY_FILE, "utf8")).dpr));
    } catch {}
  }
  return Math.min(3, Math.max(1, v || 1));
}
let RENDER_SCALE = readRenderScale();
// Stills up to this many device pixels are lossless PNG, larger ones JPEG 96.
const PNG_STILL_MAX_PIXELS = 12e6;
const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

// Side-by-side view: the widest selected device is the shared tab itself,
// the others are extra pages that follow its address and scroll position.
const DEVICES = {
  mobile: { key: "mobile", label: "Mobile", width: 393, height: 852, mobile: true },
  tablet: { key: "tablet", label: "Tablet", width: 820, height: 1180, mobile: true },
  desktop: { key: "desktop", label: "Desktop", width: 1280, height: 800, mobile: false },
};
const DEVICE_ORDER = ["mobile", "tablet", "desktop"];
// User agents the phone and tablet panes of the window-mode side-by-side view
// report while they emulate touch (Android: the same engine as the window,
// and no iOS-only code paths in a desktop browser).
const TOUCH_UA = {
  mobile: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36",
  tablet: "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
};

const isStartUrl = u => typeof u === "string" && u.split(/[?#]/)[0] === START_URL;

// "    at fn (http://host/file.js:12:34)" lines of an Error.stack.
function parseStack(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const m = /^\s*at (?:(.*?) \()?((?:https?|file):\/\/[^\s)]+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (m) out.push({ fn: m[1] || "", url: m[2], line: +m[3], col: +m[4] });
  }
  return out;
}

// Generated-code frames → original file:line:col (frames inside packages are dropped).
async function mapFrames(frames, limit = 8) {
  const out = [];
  for (const f of frames.slice(0, 30)) {
    const src = await resolveLocation(f.url, f.line, f.col).catch(() => null);
    if (src) out.push({ name: f.fn || "(anonymous)", src });
    if (out.length >= limit) break;
  }
  return out;
}

// Replaces every "http://…/file.js:12:34" in a text with its source location,
// leaving the ones that cannot be mapped as they are.
async function mapUrlsInText(text) {
  const re = /((?:https?|file):\/\/[^\s)'"]+?):(\d+):(\d+)/g;
  const found = new Map();
  for (const m of String(text).matchAll(re)) found.set(m[0], m);
  if (!found.size) return text;
  await Promise.all([...found].slice(0, 40).map(async ([key, m]) => found.set(key, (await resolveLocation(m[1], +m[2], +m[3]).catch(() => null)) || key)));
  return String(text).replace(re, k => (typeof found.get(k) === "string" ? found.get(k) : k));
}

// Rejects when a CDP call does not answer: a hung Chrome must never hang us.
function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what || "browser call"} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Dev servers get camera/mic without asking; everything else asks in the panel.
function isLocalOrigin(origin) {
  try {
    const h = new URL(origin).hostname;
    return /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(h) || h.endsWith(".local") || h.endsWith(".localhost");
  } catch {
    return false;
  }
}

fs.mkdirSync(HOME, { recursive: true });

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a => (a instanceof Error ? a.stack : typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
  process.stdout.write(line);
}

function getToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (t.length >= 32) return t;
  } catch {}
  const t = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  return t;
}
const TOKEN = getToken();

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- URL history (address bar suggestions) ----------
// Own small store (Chrome's History DB is locked while it runs).
const history = {
  items: new Map(), // url -> { url, title, visits, last }
  saveTimer: null,
  load() {
    try {
      for (const it of JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"))) if (it && it.url) this.items.set(it.url, it);
    } catch {}
  },
  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify([...this.items.values()]));
      } catch (e) {
        log("history save", e.message);
      }
    }, 1000);
  },
  record(url, title) {
    if (!/^(https?|file):/i.test(url || "") || isStartUrl(url)) return;
    const it = this.items.get(url);
    const now = Date.now();
    if (it) {
      // One visit per page load, not per title/SPA refresh of the same URL.
      if (now - it.last > 3000) it.visits++;
      it.last = now;
      if (title) it.title = title;
    } else {
      this.items.set(url, { url, title: title || "", visits: 1, last: now });
      if (this.items.size > HISTORY_MAX) {
        const oldest = [...this.items.values()].sort((a, b) => a.last - b.last).slice(0, this.items.size - HISTORY_MAX);
        for (const o of oldest) this.items.delete(o.url);
      }
    }
    this.save();
  },
  suggest(q, limit = 8) {
    const query = String(q || "").trim().toLowerCase();
    if (!query) return [];
    const bare = u => u.replace(/^[a-z]+:\/\/(www\.)?/i, "");
    const now = Date.now();
    const frecency = it => it.visits * (1 / (1 + (now - it.last) / (3 * 86400000)));
    // Each origin also counts as an entry of its own, scored by all its pages,
    // so typing "loc" completes to "localhost:5174/" before deep links.
    const pool = new Map();
    for (const it of this.items.values()) {
      pool.set(it.url, { url: it.url, title: it.title, score: frecency(it) });
      let origin;
      try {
        const u = new URL(it.url);
        origin = u.protocol === "file:" ? null : u.origin + "/";
      } catch {}
      if (origin && origin !== it.url) {
        const o = pool.get(origin) || { url: origin, title: "", score: 0, synthetic: true };
        o.score += frecency(it) * 0.9;
        pool.set(origin, o);
      }
    }
    const out = [];
    for (const it of pool.values()) {
      const b = bare(it.url).toLowerCase();
      const full = it.url.toLowerCase();
      let rank;
      if (b.startsWith(query) || full.startsWith(query)) rank = 3;
      else if (b.includes(query)) rank = 2;
      else if ((it.title || "").toLowerCase().includes(query)) rank = 1;
      else continue;
      out.push({ ...it, rank, prefix: rank === 3 });
    }
    out.sort((a, b) => b.rank - a.rank || b.score - a.score || a.url.length - b.url.length);
    return out.slice(0, limit).map(({ url, title, prefix }) => ({ url, title, prefix }));
  },
  remove(url) {
    if (this.items.delete(url)) this.save();
  },
  top(limit = 8) {
    const now = Date.now();
    return [...this.items.values()]
      .map(it => ({ url: it.url, title: it.title, score: it.visits * (1 / (1 + (now - it.last) / (3 * 86400000))) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ url, title }) => ({ url, title }));
  },
};
history.load();

// ---------- start page: local dev servers + recent pages ----------
function probeServer(port) {
  return new Promise(resolve => {
    const req = http.get({ host: "localhost", port, path: "/", timeout: 900, headers: { accept: "text/html" } }, res => {
      const type = String(res.headers["content-type"] || "");
      const redirect = res.statusCode >= 300 && res.statusCode < 400;
      if (!redirect && !/text\/html/i.test(type)) {
        res.destroy();
        return resolve(null);
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", c => {
        body += c;
        if (body.length > 20000) res.destroy();
      });
      const done = () => {
        const m = /<title[^>]*>([^<]{0,120})/i.exec(body);
        resolve({ url: `http://localhost:${port}/`, title: m ? m[1].trim() : "" });
      };
      res.on("end", done);
      res.on("close", done);
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

let serversCache = { at: 0, list: [] };
async function localServers(chromePort) {
  if (Date.now() - serversCache.at < 3000) return serversCache.list;
  let ports = [];
  try {
    const { execFile } = require("child_process");
    const out = await new Promise(res => execFile("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], { timeout: 3000 }, (_e, stdout) => res(stdout || "")));
    let cmd = "";
    const seen = new Map();
    for (const line of out.split("\n")) {
      if (line[0] === "c") cmd = line.slice(1);
      else if (line[0] === "n") {
        const m = /:(\d+)$/.exec(line);
        const port = m && Number(m[1]);
        if (!port || port === PORT || port === chromePort || port < 1024) continue;
        // Editors and browsers listen on plenty of ports that are not sites.
        if (/^(Cursor|Code|Electron|Google|Chrome|Brave|Microsoft|Slack|Discord|Spotify|rapportd|ControlCe|sharingd|AirPlay|figma|Figma|com\.docker\.backend|adb)/i.test(cmd)) continue;
        if (!seen.has(port)) seen.set(port, cmd);
      }
    }
    ports = [...seen].slice(0, 40);
  } catch {}
  const found = await Promise.all(ports.map(async ([port, cmd]) => {
    const s = await probeServer(port);
    return s && { ...s, port, cmd };
  }));
  const list = found.filter(Boolean).sort((a, b) => a.port - b.port);
  serversCache = { at: Date.now(), list };
  return list;
}

const START_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>New Tab</title>
<style>
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--card:#fff;--line:#e7e5e4;--accent:#d97757}
@media (prefers-color-scheme:dark){:root{--bg:#1b1b1a;--fg:#e7e5e4;--muted:#a8a29e;--card:#262624;--line:#3a3936}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:56px 24px}
h1{font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:32px 0 10px}
h1:first-child{margin-top:0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
a{display:block;padding:12px 14px;background:var(--card);border:1px solid var(--line);border-radius:10px;color:inherit;text-decoration:none;min-width:0}
a:hover,a:focus-visible{border-color:var(--accent);outline:none}
.t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.u{color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:ltr;text-align:left}
.port{color:var(--accent);font-variant-numeric:tabular-nums}
.empty{color:var(--muted);padding:6px 0}
</style></head><body><main>
<h1>Running on this machine</h1><div id="servers" class="grid"><div class="empty">Looking for local servers…</div></div>
<h1>Recent</h1><div id="recent" class="grid"></div>
</main><script>
const card=(title,sub)=>{const a=document.createElement("a");const t=document.createElement("div");t.className="t";t.append(...[].concat(title));const u=document.createElement("div");u.className="u";u.textContent=sub;a.append(t,u);return a};
async function load(){
  let d;try{d=await (await fetch("/start/data")).json()}catch{return}
  const s=document.getElementById("servers");s.textContent="";
  if(!d.servers.length){const e=document.createElement("div");e.className="empty";e.textContent="No local web servers found. Start your dev server and it will show up here.";s.append(e)}
  for(const x of d.servers){const p=document.createElement("span");p.className="port";p.textContent=":"+x.port+" ";const a=card([p,x.title||x.cmd||"Local server"],x.url);a.href=x.url;s.append(a)}
  const r=document.getElementById("recent");r.textContent="";
  for(const x of d.recent){const a=card(x.title||x.url,x.url.replace(/^https?:\\/\\//,""));a.href=x.url;r.append(a)}
  if(!d.recent.length){const e=document.createElement("div");e.className="empty";e.textContent="Pages you visit will be listed here.";r.append(e)}
}
load();setInterval(load,4000);
</script></body></html>`;

// Picks carry ⟦url:line:col⟧ markers (React 19 _debugStack, generated code):
// map them to original file:line:col and rewrite the chain part of the report.
const CHAIN_HEADER = "Component chain (innermost first, file:line = where it is used):";
// Picks: which usage site in the chain is "the place" to edit. A usage inside a
// widely shared component (a design-system Typography, Dialog, Button…) is the
// same code for every screen, so walk outward past those to the first usage in
// a file that few others import: for a dialog's title that's the specific
// dialog that passes the title in, not the shared Dialog. (Cursor's agent gets
// there by searching for the element's text and props; this does it up front.)
const SHARED_IMPORTERS = 10;
const importerCache = new Map(); // file -> number of files importing it (-1 unknown)

function srcFile(src) {
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(src || "");
  return m && path.isAbsolute(m[1]) && !/node_modules/.test(m[1]) ? m[1] : null;
}

function importerCount(file) {
  if (importerCache.has(file)) return Promise.resolve(importerCache.get(file));
  const { execFile } = require("child_process");
  const run = (args, cwd) => new Promise(res => execFile("git", args, { cwd, timeout: 4000, maxBuffer: 32 << 20 }, (err, out) => res({ err, out: String(out || "") })));
  return (async () => {
    let n = -1;
    const top = await run(["rev-parse", "--show-toplevel"], path.dirname(file));
    if (!top.err) {
      let base = path.basename(file).replace(/\.[cm]?[jt]sx?$/, "");
      if (base === "index") base = path.basename(path.dirname(file));
      const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const r = await run(["grep", "-l", "-E", `[/"']${esc}["']`, "--", "*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.vue", "*.svelte"], top.out.trim());
      // git grep exits 1 when nothing matches
      n = !r.err ? r.out.split("\n").filter(Boolean).length : r.err.code === 1 ? 0 : -1;
    }
    importerCache.set(file, n);
    return n;
  })();
}

async function pickTarget(chain) {
  const cands = chain.map((c, i) => ({ i, file: srcFile(c.src) })).filter(c => c.file && fs.existsSync(c.file));
  if (!cands.length) return -1;
  for (const c of cands) {
    const n = await importerCount(c.file).catch(() => -1);
    if (n < 0 || n < SHARED_IMPORTERS) return c.i;
  }
  return cands[cands.length - 1].i;
}

// Maps a pick's chain to source and marks the place to edit (▶).
async function resolveChain(raw) {
  raw = Array.isArray(raw) ? raw : [];
  let chain = raw;
  if (raw.some(c => c.src && c.src.includes("⟦"))) {
    const resolved = await Promise.all(raw.map(async c => ({ name: c.name, src: c.src ? await resolveMarkers(c.src) : "" })));
    chain = resolved.some(c => c.src) ? resolved.filter(c => c.src) : resolved;
    chain = chain.filter((c, i) => i === 0 || c.src !== chain[i - 1].src);
  }
  const target = await pickTarget(chain).catch(() => -1);
  return { chain, target };
}

function chainLines(chain, target) {
  if (!chain.length || !chain.some(c => c.src)) return ["No source locations on this page (not a dev build, or the framework doesn't record them)."];
  const width = Math.max(0, ...chain.map(c => c.name.length));
  const lines = [CHAIN_HEADER, ...chain.map((c, i) => `${i === target ? "▶ " : "  "}${i === 0 ? "  " : "← "}${c.name.padEnd(width)}  ${c.src || "(no source info)"}`)];
  if (target > 0) lines.push("▶ = the usage for THIS element; the entries inside it are shared components (change them only for a change everywhere).");
  return lines;
}

// The few lines that go into the prompt for a pick.
// browser_verify: what changed about an element between two snapshots.
function snapDiff(b, a) {
  const out = [];
  const r = v => Math.round(v);
  if (r(b.rect.width) !== r(a.rect.width) || r(b.rect.height) !== r(a.rect.height)) out.push(`size: ${r(b.rect.width)}×${r(b.rect.height)} → ${r(a.rect.width)}×${r(a.rect.height)}`);
  const bx = b.rect.x + b.scroll.x, by = b.rect.y + b.scroll.y, ax = a.rect.x + a.scroll.x, ay = a.rect.y + a.scroll.y;
  if (Math.abs(bx - ax) > 1 || Math.abs(by - ay) > 1) out.push(`position on the page: (${r(bx)}, ${r(by)}) → (${r(ax)}, ${r(ay)})`);
  if (b.text !== a.text) out.push(`text: ${JSON.stringify(b.text)} → ${JSON.stringify(a.text)}`);
  if (b.cls !== a.cls) {
    const bs = new Set(b.cls.split(/\s+/).filter(Boolean));
    const as = new Set(a.cls.split(/\s+/).filter(Boolean));
    const ch = [...[...as].filter(c => !bs.has(c)).map(c => "+" + c), ...[...bs].filter(c => !as.has(c)).map(c => "−" + c)];
    if (ch.length) out.push(`class: ${ch.slice(0, 16).join(" ")}${ch.length > 16 ? " …" : ""}`);
  }
  const keys = [...new Set([...Object.keys(b.styles), ...Object.keys(a.styles)])];
  const st = keys.filter(k => b.styles[k] !== a.styles[k]).map(k => `${k}: ${String(b.styles[k] ?? "(default)").slice(0, 80)} → ${String(a.styles[k] ?? "(default)").slice(0, 80)}`);
  out.push(...st.slice(0, 16));
  if (st.length > 16) out.push(`… ${st.length - 16} more style changes (browser_inspect aspect "styles" has them all)`);
  if (b.kids !== a.kids) out.push(`child elements: ${b.kids} → ${a.kids}`);
  if (b.visible !== a.visible) out.push(a.visible ? "now visible" : "no longer visible");
  return out;
}

// Size sweep (window mode toolbar): from the window's size down through
// common devices to the first iPhone SE, by emulating the page's size. Three
// groups, widest first. Within a group width and height only shrink; the
// height grows only on stepping to the next group (laptops → the largest
// tablet → the largest phone). Each group's first and last device are always
// on the path; one in between is left out if it is taller than the one before
// it or would make the group's last device need a taller step.
const SWEEP_GROUPS = [
  [
    [2560, 1440, "QHD"],
    [1920, 1080, "Full HD"],
    [1440, 900, "MacBook Air"],
    [1280, 800, "Laptop"],
    [1024, 768, "Small laptop"],
  ],
  [
    [1024, 1366, "iPad Pro 13″"],
    [834, 1194, "iPad Pro 11″"],
    [820, 1180, "iPad Air"],
    [768, 1024, "iPad"],
    [744, 1133, "iPad mini"],
  ],
  [
    [440, 956, "iPhone 16 Pro Max"],
    [430, 932, "iPhone 15 Plus"],
    [412, 915, "Pixel 8"],
    [393, 852, "iPhone 15 / 16"],
    [390, 844, "iPhone 14"],
    [375, 812, "iPhone 13 mini"],
    [360, 800, "Galaxy S"],
    [320, 568, "iPhone SE (1st gen)"],
  ],
];

// The path from the window's size: per group, the devices narrower than
// where the path is, shrinking only after the group's first step.
function sweepPath(w0, h0) {
  const pts = [{ w: w0, h: h0, label: "" }];
  SWEEP_GROUPS.forEach((group, gi) => {
    const last = group[group.length - 1];
    // The window counts as the first laptop: that group never grows.
    let first = gi > 0;
    for (const [w, h, label] of group) {
      const prev = pts[pts.length - 1];
      const isLast = w === last[0] && h === last[1];
      if (first) {
        // The group's way in: its widest device not wider than the path, at its own height.
        if (w > prev.w) continue;
        pts.push({ w, h, label });
        first = false;
        continue;
      }
      if (w >= prev.w - (pts.length === 1 ? 4 : 0)) continue; // (a device just under the window size adds nothing)
      // Laptops: all of them (the list already shrinks); others only if they don't grow.
      if (gi === 0 || isLast || (h <= prev.h && h >= last[1])) pts.push({ w, h, label });
    }
  });
  return pts;
}

const SWEEP_BASE = 400; // CSS px of the path per second at 1×
const SWEEP_DWELL = 250; // ms held at each device at 1×
const SWEEP_SPEEDS = [0.25, 0.5, 1, 2, 4];

// Tools that change the page: browser_verify looks for code changes after the last of these.
const ACTING_TOOLS = new Set(["navigate", "click", "type", "press", "scroll", "select", "upload", "hover", "viewport", "tabs", "restart"]);

const INSPECT_ASPECTS = ["styles", "rules", "layout", "animation", "events", "html", "react", "source"];
function pickCard(p) {
  const c = p.card || {};
  const lines = [`[Picked in the browser — pick ${p.id}] ${c.what || "element"}`];
  if (c.where) lines.push(`In: ${c.where}`);
  lines.push(`Page: ${p.title ? p.title.slice(0, 60) + " — " : ""}${String(p.url || "").split("#")[0]}${c.pane ? ` (${c.pane} pane)` : ""}`);
  const at = p.target >= 0 ? p.chain[p.target] : (p.chain || []).find(x => x.src);
  const code = at && at.src ? `${at.name.startsWith("<") ? `${at.name} written` : `<${at.name}> used`} at ${at.src}` : "";
  const sameComponent = at && at.src && (at.name === c.component || path.basename(at.src.split(":")[0]).replace(/\.\w+$/, "") === c.component);
  if (c.component || code) lines.push([c.component && !sameComponent ? `Component: <${c.component}>` : "", code ? `Code: ${code}` : ""].filter(Boolean).join(" · "));
  lines.push(`More only if needed: browser_inspect({pick: ${p.id}, aspect: ${INSPECT_ASPECTS.join("|")}})`);
  return lines.join("\n");
}

async function formatReact(res, args) {
  const out = [];
  for (const [i, c] of res.components.entries()) {
    const src = c.src ? await resolveMarkers(c.src).catch(() => "") : "";
    out.push(`${args.component ? `#${i + 1} ` : i ? "↑ " : ""}<${c.name}>${c.key ? ` key=${c.key}` : ""}${src ? `  used at ${src}` : ""}`);
    out.push(`  props: ${c.props || "(none)"}`);
    if (c.children) out.push(`  children: ${c.children}`);
    for (const h of c.hooks) out.push(`  ${h}`);
    for (const h of c.contexts) out.push(`  context ${h}`);
  }
  if (res.tree) out.push("", "Component tree below it:", ...res.tree.map(l => "  " + l));
  return out.join("\n") || "No React components found.";
}

// Object ids belong to the CDP session that made them: Puppeteer's own for
// handles, not the tab's extra session.
function sessionOf(handle, t) {
  return handle.client || (handle.handle && handle.handle.client) || t.tab.cdp;
}

function normalizeUrl(raw) {
  const u = String(raw || "").trim();
  if (!u) return "about:blank";
  if (/^(localhost|127\.|0\.0\.0\.0|\[::1\]|[\w.-]+:\d+)/i.test(u)) return "http://" + u;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) || /^(about|data|file|chrome|view-source|javascript|blob):/i.test(u)) return u;
  if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(u)) return "https://" + u;
  return "https://www.google.com/search?q=" + encodeURIComponent(u);
}

const blankNav = () => ({ url: "about:blank", title: "", canGoBack: false, canGoForward: false, loading: false });

class Engine {
  constructor() {
    this.browser = null;
    this.browserCdp = null;
    this.launching = null;
    this.tabs = []; // [{ id, page, cdp, nav, lastFrame, pageScale, mainFrameId, screencasting, pendingChooser }]
    this.active = null;
    this.clients = new Map(); // id -> { ws, viewport }
    this.activeClient = null; // whose size drives the viewport
    this.override = null; // { width, height, mobile } fixed device size
    this.effective = { ...DEFAULT_VIEWPORT, mobile: false };
    this.logs = [];
    this.logSeq = 0;
    this.picks = [];
    this.pickSeq = 0;
    this.pickRequester = null;
    this.downloads = []; // newest first
    this.lastUserInput = { at: 0, client: null };
    this.recentInput = [];
    this.lastActivity = Date.now();
    this.cursor = "default";
    this.permPending = new Map(); // id -> { tab, pageId, origin, kinds }
    this.permSeq = 0;
    this.frameSeq = 0;
    this.pendingAcks = new Map(); // frame seq -> ack to Chrome
    this.zoom = 1;
    this.colorScheme = ""; // "" (system) | "light" | "dark"
    this.browserInfo = null; // { kind, version, executablePath }
    this.expectedStop = false; // we closed the browser ourselves
    this.recovering = null;
    this.pingFails = 0;
    this.status = null; // last { state, text, progress } shown to viewers
    this.restore = null; // { urls, active } to reopen after a (re)launch
    this.errorSeq = 0;
    this.net = []; // network log entries, oldest first
    this.netSeq = 0;
    this.devEvents = []; // dev server updates seen on the page's HMR socket: { kind, files, error, at, seq, tab }
    this.lastAct = { at: Date.now() - 60000, seq: 0 }; // end of the last tool call that acted on the page
    this.busyTools = 0;
    this.verifyBases = new Map(); // browser_verify target (ref/selector/text) -> its last snapshot
    this.mirrors = []; // extra pages of the side-by-side view (not tabs)
    this.multi = null; // { keys: [...], prevOverride }
    // Scale the side-by-side panes are shown at in the panel (≤ 1). The panes
    // render at it, so Chrome rasterizes text at the size you see instead of
    // the panel shrinking a full-size picture.
    this.multiViewScale = 1;
    this.sizes = {}; // device key -> { width, height, name } chosen instead of the default
    this.uiPrefs = {}; // window mode toolbar: { pos: { fx, fy }, collapsed }
    this.multiScaleMode = "fit"; // window mode side-by-side: "fit" | "0.5" | "0.75" | "1"
    this.touchPanes = true; // window mode side-by-side: phone and tablet panes act as touch devices
    try {
      const sess = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8")) || {};
      const kept = sess.sizes || {};
      for (const k of Object.keys(DEVICES)) if (kept[k] && kept[k].width > 0 && kept[k].height > 0) this.sizes[k] = { width: kept[k].width, height: kept[k].height, name: String(kept[k].name || "") };
      if (sess.uiPrefs && typeof sess.uiPrefs === "object") this.uiPrefs = sess.uiPrefs;
      if (sess.multiScale) this.multiScaleMode = String(sess.multiScale);
      if (sess.touchPanes === false) this.touchPanes = false;
    } catch {}
    this.lastInputTab = null; // pane the user last touched: it leads scroll sync
    try {
      this.permDecisions = JSON.parse(fs.readFileSync(PERMS_FILE, "utf8"));
    } catch {
      this.permDecisions = {}; // origin -> "allow" | "block"
    }
  }

  // The active tab's state, used everywhere the engine talks about "the page".
  get page() {
    return this.active ? this.active.page : null;
  }
  get cdp() {
    return this.active ? this.active.cdp : null;
  }
  get nav() {
    return this.active ? this.active.nav : blankNav();
  }
  get lastFrame() {
    return this.active ? this.active.lastFrame : null;
  }
  get pageScale() {
    return (this.active && this.active.pageScale) || 1;
  }
  get targetId() {
    return this.active ? this.active.id : null;
  }

  touch() {
    this.lastActivity = Date.now();
  }

  // ---------- lifecycle ----------
  async ensure() {
    if (this.page && !this.page.isClosed() && this.browser && this.browser.connected) return this.page;
    // Cursor mode: between a view being torn down and rebuilt there is no tab
    // for a moment. Wait for it rather than opening another Browser Tab.
    if (CURSOR_MODE && this.browser && this.browser.connected && !this.launching) {
      const t = await this.waitCursorReplacement();
      if (t) return t.page;
    }
    if (!this.launching) {
      this.launching = (this.browser && this.browser.connected ? this.newTab(START_URL) : this.launch()).finally(() => {
        this.launching = null;
      });
    }
    await this.launching;
    return this.page;
  }

  setStatus(state, text, progress) {
    this.status = state === "ok" ? null : { state, text, progress };
    this.broadcast({ t: "status", state, text: text || "", progress });
  }

  killChrome() {
    if (CURSOR_MODE) return; // the browser is Cursor itself: never kill it
    try {
      execSync(`pkill -9 -f -- "--user-data-dir=${PROFILE}"`, { stdio: "ignore" });
    } catch {}
  }

  // Decides which Chromium to run, downloading our own build when there is
  // nothing else to start with.
  async chooseBrowser() {
    let pick = await chromium.pickBrowser(BROWSER_MODE);
    if (pick.needsInstall && !pick.executablePath) {
      this.setStatus("downloading", "Downloading the browser (one time, about 200 MB)…", 0);
      try {
        const b = await chromium.installManaged(f => this.setStatus("downloading", "Downloading the browser (one time, about 200 MB)…", f));
        pick = { ...b, needsInstall: false };
      } catch (e) {
        throw new Error(`Could not download a browser (${e.message.split("\n")[0]}), and no Chrome, Edge or Brave is installed.`);
      }
    } else if (pick.needsInstall && !this.installStarted) {
      // Usable right now with the installed browser; fetch our own for next time.
      this.installStarted = true;
      chromium
        .installManaged(() => {})
        .then(b => {
          log("own browser installed", b.version);
          this.toast("Claude Browser's own Chromium is installed. It takes over at the next browser restart (⋯ menu).");
        })
        .catch(e => {
          this.installStarted = false;
          log("browser download failed", e.message);
        });
    }
    return pick;
  }

  async launch() {
    if (CURSOR_MODE) return this.connectCursor();
    this.killChrome();
    await sleep(300);
    try {
      fs.rmSync(path.join(PROFILE, "SingletonLock"), { force: true });
    } catch {}
    const pick = await this.chooseBrowser();
    const executablePath = pick.executablePath;
    this.executablePath = executablePath;
    this.browserInfo = pick;
    this.setStatus("starting", "Starting the browser…");
    log("launching", pick.kind, pick.version || "", executablePath);
    this.tabs = [];
    this.active = null;
    this.mirrors = [];
    this.expectedStop = false;
    const args = WINDOW_MODE
      ? [
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-features=Translate,MediaRouter",
          "--autoplay-policy=no-user-gesture-required",
          "--disable-infobars",
          "--window-size=1440,1000",
        ]
      : [
          "--no-first-run",
          "--no-default-browser-check",
          "--hide-scrollbars",
          "--disable-features=Translate,MediaRouter",
          "--autoplay-policy=no-user-gesture-required",
          // Headless has no permission UI; the page script gates access instead.
          "--auto-accept-camera-and-microphone-capture",
          // Our own build has no Google API keys and would nag about them.
          "--disable-infobars",
          `--window-size=${DEFAULT_VIEWPORT.width},${DEFAULT_VIEWPORT.height}`,
          `--force-device-scale-factor=${(RENDER_SCALE = readRenderScale())}`,
        ];
    let browser = null;
    if (process.platform === "darwin" && /\.app\//.test(executablePath)) {
      try {
        browser = await this.launchViaLaunchServices(executablePath, args);
      } catch (e) {
        log("LaunchServices start failed, falling back to a child process:", e.message);
        this.killChrome();
      }
    }
    if (!browser) {
      browser = await puppeteer.launch({
        executablePath,
        headless: !WINDOW_MODE,
        userDataDir: PROFILE,
        // Puppeteer mutes headless audio by default; we want to hear the page.
        ignoreDefaultArgs: ["--mute-audio"],
        defaultViewport: null,
        protocolTimeout: 60000,
        args,
      });
    }
    this.browser = browser;
    this.pingFails = 0;
    try {
      this.chromePort = Number(new URL(browser.wsEndpoint()).port) || null;
    } catch {
      this.chromePort = null;
    }
    browser.on("disconnected", () => this.onBrowserGone(browser));
    browser.on("targetcreated", t => this.onTargetCreated(t).catch(e => log("targetcreated", e)));
    if (WINDOW_MODE) {
      browser.on("targetdestroyed", () => {
        const tab = this.active;
        if (tab && tab.devtoolsId) this.devtoolsAlive(tab).then(alive => !alive && this.pushUi(tab), () => {});
      });
    }
    await this.setupDownloads();

    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());
    for (const extra of pages.slice(1)) await extra.close().catch(() => {});
    const tab = await this.addTab(page);
    await this.activate(tab);

    // Reopen what was open before (a crash, a restart, or the last run).
    const restore = this.restore || this.readSession();
    this.restore = null;
    const urls = restore && restore.urls && restore.urls.length ? restore.urls : [HOME_URL];
    const open = (p, url) => {
      if (!url || url === "about:blank") return Promise.resolve();
      return p.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(e => log("open", url, e.message.split("\n")[0]));
    };
    const firstLoad = open(page, urls[0]);
    for (const url of urls.slice(1, 12)) {
      try {
        const t = await this.newTab(null, { background: true });
        open(t.page, url);
      } catch (e) {
        log("restore tab", e.message);
      }
    }
    const wanted = this.tabs[Math.min(this.tabs.length - 1, Math.max(0, (restore && restore.active) || 0))];
    if (wanted && wanted !== this.active) await this.activate(wanted);
    if (this.multi && WINDOW_MODE) {
      // The side-by-side page wraps the page that was open: wait for it.
      const keys = this.multi.keys;
      this.override = this.multi.prevOverride;
      this.multi = null;
      firstLoad.then(() => this.setMulti(keys)).catch(e => log("multi restore", e.message));
    } else if (this.multi) {
      const keys = this.multi.keys;
      this.override = this.multi.prevOverride;
      this.multi = null;
      // The shared tab first (unless it has finished loading already).
      const first = this.active;
      if (first) this.loadInTurn(first, () => first.page.evaluate(() => document.readyState !== "complete" && location.href !== "about:blank").catch(() => true));
      this.setMulti(keys).catch(e => log("multi restore", e.message));
    }
    this.setStatus("ok");
    return page;
  }

  // Cursor mode: attach to the Browser Tabs of a Cursor started with
  // --remote-debugging-port. Only `webview` targets are touched (Cursor's own
  // windows and extension webviews are other types), and nothing is ever
  // closed or killed: Cursor owns the tabs, we only drive them.
  async connectCursor() {
    this.setStatus("starting", "Connecting to Cursor's browser…");
    this.tabs = [];
    this.active = null;
    this.mirrors = [];
    this.expectedStop = false;
    let version;
    try {
      version = await withTimeout(fetch(`http://127.0.0.1:${CURSOR_PORT}/json/version`).then(r => r.json()), 3000, "cursor");
    } catch {
      this.setStatus("stopped", "Cursor isn't running with browser control");
      throw new Error(`Cursor isn't reachable on port ${CURSOR_PORT}. Run “Claude Browser: Restart Cursor with Browser Control” from the command palette (it restarts Cursor with --remote-debugging-port=${CURSOR_PORT}).`);
    }
    const browser = await puppeteer.connect({
      browserWSEndpoint: version.webSocketDebuggerUrl,
      defaultViewport: null,
      protocolTimeout: 60000,
      // No targetFilter: webviews are attached through their Cursor window, so
      // filtering the window out hides them too. Only webviews become tabs.
    });
    this.browser = browser;
    this.browserInfo = { kind: "cursor", version: (version.Browser || "").replace("Chrome/", "Chromium ") };
    this.executablePath = null;
    this.pingFails = 0;
    this.chromePort = CURSOR_PORT;
    browser.on("disconnected", () => this.onBrowserGone(browser));
    browser.on("targetcreated", t => this.onTargetCreated(t).catch(e => log("targetcreated", e)));
    // A webview that turns into Cursor's DevTools (at any point) is no tab of ours.
    browser.on("targetchanged", t => {
      if (t.type() !== "webview" || !isDevtoolsUrl(t.url())) return;
      const tab = this.tabs.find(x => x.page && x.page.target() === t);
      if (tab) {
        log("dropping DevTools webview from tabs");
        this.onTabClosed(tab).catch(() => {});
      }
    });
    try {
      // For Browser.* calls only; downloads stay Cursor's business.
      this.browserCdp = await browser.target().createCDPSession();
    } catch (e) {
      log("cursor browser session", e.message);
    }
    log("connected to Cursor", version.Browser);
    const webviews = async () => (await Promise.all(browser.targets().filter(t => t.type() === "webview" && !isDevtoolsUrl(t.url())).map(t => t.page().catch(() => null)))).filter(Boolean);
    let pages = await webviews();
    if (!pages.length) {
      // No Browser Tab open yet: ask the editor (through the bridge) to open one.
      const page = await this.openCursorTab(HOME_URL === START_URL ? "" : HOME_URL).catch(e => (log("open cursor tab", e.message), null));
      pages = page ? [page] : await webviews();
    }
    if (!pages.length) {
      this.setStatus("stopped", "Open a Browser Tab in Cursor");
      throw new Error("No Browser Tab is open in Cursor. Open one (View: New Browser Tab, or the globe button in the editor title) and try again.");
    }
    for (const p of pages) await this.addTab(p).catch(e => log("adopt", e.message));
    if (this.tabs[0]) await this.activate(this.tabs[0]);
    this.setStatus("ok");
    return this.active && this.active.page;
  }

  // Cursor mode: a new Browser Tab is opened by Cursor's own command, run by
  // the extension. Resolves with its page once the webview target shows up.
  openCursorTab(url, opts = {}) {
    const last = this.clients.get(this.bridgeTarget());
    const bridge = last && last.bridge && last.ws.readyState === 1 ? last : [...this.clients.values()].find(c => c.bridge && c.ws.readyState === 1);
    if (!bridge || !this.browser) return Promise.reject(new Error("The Claude Browser extension in Cursor isn't connected"));
    return new Promise((resolve, reject) => {
      const done = page => {
        clearTimeout(timer);
        this.browser.off("targetcreated", onTarget);
        page ? resolve(page) : reject(new Error("Cursor didn't open a Browser Tab"));
      };
      const onTarget = t => t.type() === "webview" && t.page().then(done, () => {});
      const timer = setTimeout(() => done(null), 8000);
      this.browser.on("targetcreated", onTarget);
      bridge.ws.send(JSON.stringify({ t: "openCursorBrowser", url: url || undefined, background: !!opts.background }));
    });
  }

  // ---------- staying alive ----------
  sessionSnapshot() {
    const urls = this.tabs.map(t => t.failedUrl || t.nav.url).filter(u => u && !/^(about:|chrome-error:|chrome:)/.test(u));
    return { urls, active: Math.max(0, this.tabs.indexOf(this.active)), sizes: this.sizes, uiPrefs: this.uiPrefs, multiScale: this.multiScaleMode, touchPanes: this.touchPanes };
  }

  readSession() {
    try {
      const s = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
      return s && Array.isArray(s.urls) ? s : null;
    } catch {
      return null;
    }
  }

  saveSession() {
    clearTimeout(this.sessionTimer);
    this.sessionTimer = setTimeout(() => {
      if (!this.tabs.length) return;
      try {
        fs.writeFileSync(SESSION_FILE, JSON.stringify(this.sessionSnapshot()));
      } catch {}
    }, 800);
  }

  // Chrome went away. If nobody asked for that, bring it back.
  onBrowserGone(browser) {
    if (this.browser !== browser) return;
    const expected = this.expectedStop;
    log("browser disconnected", expected ? "(expected)" : "(unexpected)");
    if (!expected && !this.restore && this.tabs.length) this.restore = this.sessionSnapshot();
    this.browser = null;
    this.browserCdp = null;
    this.chromePort = null;
    this.tabs = [];
    this.active = null;
    this.flushAcks();
    this.broadcastTabs();
    if (expected || shuttingDown) return;
    // Quitting the visible Chrome is a choice: start it again only when needed.
    if (WINDOW_MODE) return this.setStatus("stopped", "Browser closed");
    if (this.clients.size) this.recover("the browser process exited");
    else this.setStatus("stopped", "Browser stopped");
  }

  // Kill whatever is left of Chrome and start again with the same tabs.
  recover(reason) {
    if (this.recovering) return this.recovering;
    log("recovering:", reason);
    this.recovering = (async () => {
      this.setStatus("restarting", `Restarting the browser (${reason})…`);
      if (!this.restore && this.tabs.length) this.restore = this.sessionSnapshot();
      const b = this.browser;
      this.expectedStop = true;
      this.browser = null;
      this.browserCdp = null;
      this.tabs = [];
      this.active = null;
      this.flushAcks();
      if (b) b.disconnect().catch(() => {});
      this.killChrome();
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await this.ensure();
          if (this.clients.size) await this.startScreencast();
          log("recovered");
          return;
        } catch (e) {
          log(`relaunch attempt ${attempt} failed:`, e.message);
          this.killChrome();
          await sleep(800 * attempt);
        }
      }
      this.setStatus("failed", "The browser could not be started. See ~/.claude-browser/engine.log");
    })().finally(() => {
      this.recovering = null;
    });
    return this.recovering;
  }

  // Runs every few seconds: notices a Chrome (or a page) that stopped answering.
  async watchdog() {
    // Cursor mode: Cursor's endpoint doesn't answer these pings the way Chrome
    // does, and a Browser Tab hidden behind another editor stops answering page
    // pings, so a "recovery" would just open new Cursor tabs. Cursor quitting
    // shows up as a disconnect anyway.
    if (CURSOR_MODE) return;
    if (!this.browser || this.launching || this.recovering) return;
    const cdp = this.browserCdp;
    if (!cdp) return;
    try {
      await withTimeout(cdp.send("Browser.getVersion"), 4000, "browser ping");
      this.pingFails = 0;
    } catch (e) {
      if (!this.browser || this.recovering) return;
      if (++this.pingFails >= 2) {
        this.pingFails = 0;
        this.recover("it stopped responding");
      }
      return;
    }
    const tab = this.active;
    if (!tab || !tab.cdp || tab.page.isClosed()) return;
    try {
      await withTimeout(tab.cdp.send("Runtime.evaluate", { expression: "1", returnByValue: true }), 5000, "page ping");
      tab.pingFails = 0;
      if (tab.hung) this.setHung(tab, false);
    } catch (e) {
      // Only silence counts: a navigation makes the call fail right away.
      if (!/timed out/.test(e.message) || tab !== this.active || !this.tabs.includes(tab)) return;
      tab.pingFails = (tab.pingFails || 0) + 1;
      if (tab.pingFails >= 2 && !tab.hung) this.setHung(tab, true);
    }
  }

  setHung(tab, on) {
    tab.hung = on;
    if (on) log("page not responding:", tab.nav.url);
    if (tab === this.active) this.broadcast({ t: "hung", on });
  }

  // A page stuck in a loop cannot be reloaded; replace its tab instead.
  // Reload a tab. In Cursor mode CDP's Page.reload makes Cursor tear down and
  // rebuild the whole Browser Tab view (a new target); a reload started inside
  // the page keeps the same view.
  reloadTab(tab, ignoreCache = false) {
    if (!tab || !tab.cdp) return Promise.resolve();
    if (CURSOR_MODE) return tab.cdp.send("Runtime.evaluate", { expression: "location.reload()" }).then(() => {}, () => {});
    return tab.cdp.send("Page.reload", { ignoreCache }).then(() => {}, () => {});
  }

  // Cursor mode: resolves once a webview tab is active again (after Cursor
  // rebuilt the view), or after a few seconds.
  waitCursorReplacement(ms = 5000) {
    if (this.active) return Promise.resolve(this.active);
    if (!this.cursorWait) {
      this.cursorWait = (async () => {
        for (let t = 0; t < ms && !this.active; t += 100) await sleep(100);
        this.cursorWait = null;
        if (!this.active) this.broadcastTabs();
        return this.active;
      })();
    }
    return this.cursorWait;
  }

  async replaceTab(tab) {
    if (!tab || !this.tabs.includes(tab)) return;
    const url = tab.failedUrl || tab.nav.url;
    const idx = this.tabs.indexOf(tab);
    const fresh = await this.newTab(null);
    if (this.browserCdp && tab.id) await withTimeout(this.browserCdp.send("Target.closeTarget", { targetId: tab.id }), 4000, "close tab").catch(() => {});
    else tab.page.close().catch(() => {});
    // Don't wait for a hung renderer to confirm it is gone.
    const at = this.tabs.indexOf(tab);
    if (at !== -1) this.tabs.splice(at, 1);
    const from = this.tabs.indexOf(fresh);
    if (from !== -1 && idx < this.tabs.length) {
      this.tabs.splice(from, 1);
      this.tabs.splice(Math.min(idx, this.tabs.length), 0, fresh);
    }
    this.broadcast({ t: "hung", on: false });
    this.broadcastTabs();
    if (url && !/^about:/.test(url)) fresh.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(e => this.toast(e.message.split("\n")[0]));
  }

  flushAcks() {
    for (const p of this.pendingAcks.values()) p();
    this.pendingAcks.clear();
  }

  // macOS gives a child process the camera/mic permissions of whatever app
  // launched it (Cursor, a terminal…), and an app without mic access gets pure
  // silence. Starting Chrome through LaunchServices makes it its own
  // "responsible" app, so it uses Google Chrome's own permissions.
  async launchViaLaunchServices(executablePath, args) {
    const appPath = executablePath.slice(0, executablePath.indexOf(".app/") + 4);
    const portFile = path.join(PROFILE, "DevToolsActivePort");
    fs.mkdirSync(PROFILE, { recursive: true });
    fs.rmSync(portFile, { force: true });
    if (this.browserInfo && this.browserInfo.kind === "managed") {
      // A windowless app is a candidate for App Nap, which can stall it for
      // minutes. Only for our own build: this must not touch the user's Chrome.
      try {
        execFileSync("/usr/bin/defaults", ["write", "com.google.chrome.for.testing", "NSAppSleepDisabled", "-bool", "YES"], { stdio: "ignore", timeout: 3000 });
      } catch {}
    }
    execFileSync("/usr/bin/open", [
      "-n",
      ...(WINDOW_MODE ? [] : ["-g"]),
      "-a",
      appPath,
      "--args",
      ...(WINDOW_MODE ? [] : ["--headless=new"]),
      `--user-data-dir=${PROFILE}`,
      "--remote-debugging-port=0",
      // Same as puppeteer's defaults, so saved logins and timers behave as before.
      "--use-mock-keychain",
      "--password-store=basic",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      ...args,
      "about:blank",
    ]);
    for (let i = 0; i < 150 && !fs.existsSync(portFile); i++) await sleep(100);
    if (!fs.existsSync(portFile)) throw new Error("Chrome did not report a DevTools port");
    const [port, wsPath] = fs.readFileSync(portFile, "utf8").trim().split("\n");
    log("chrome started via LaunchServices on port", port);
    return puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${port}${wsPath}`, defaultViewport: null, protocolTimeout: 60000 });
  }

  // ---------- tabs ----------
  async addTab(page, opts = {}) {
    const existing = this.tabs.find(t => t.page === page) || this.mirrors.find(t => t.page === page);
    if (existing) return existing;
    if (CURSOR_MODE) log("adopting webview", page.url().slice(0, 80));
    const tab = { id: null, page, cdp: null, nav: blankNav(), lastFrame: null, pageScale: 1, mainFrameId: null, screencasting: false, pendingChooser: null, viewportKey: "", failedUrl: null, picking: false, hung: false, errors: 0, mobile: false, mirror: opts.mirror || null };
    if (tab.mirror) this.mirrors.push(tab);
    else this.tabs.push(tab);
    const isActive = () => this.active === tab;
    const isShown = () => this.isShown(tab);

    const ua = (await this.browser.userAgent()).replace("HeadlessChrome", "Chrome");
    await page.setUserAgent(ua).catch(() => {});
    await page.exposeFunction("__cbEmit", json => this.onPageEmit(tab, json)).catch(() => {});
    if (WINDOW_MODE) {
      const flags = `window.__cbWindowMode = true;${CURSOR_MODE ? " window.__cbCursorMode = true;" : ""}`;
      await page.evaluateOnNewDocument(flags).catch(() => {});
      await page.evaluate(flags).catch(() => {});
    }
    await page.evaluateOnNewDocument(INPAGE).catch(() => {});
    await page.evaluate(INPAGE).catch(() => {});
    if (WINDOW_MODE) {
      await page.evaluateOnNewDocument(UI_SCRIPT).catch(() => {});
      await page.evaluate(UI_SCRIPT).catch(() => {});
    }

    const cdp = await page.createCDPSession();
    tab.cdp = cdp;
    try {
      tab.id = (await cdp.send("Target.getTargetInfo")).targetInfo.targetId;
    } catch {}
    await cdp.send("Page.enable").catch(() => {});
    this.watchNetwork(tab);
    // Pages behave as focused (carets, :focus, timers) whichever window is in front.
    // (Not in window mode: there the real focus and tab visibility matter.)
    if (!WINDOW_MODE) await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    // A visible window opens the real file dialog itself.
    if (!WINDOW_MODE) await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true }).catch(e => log("file chooser intercept", e.message));
    cdp.on("Page.screencastFrame", ({ data, sessionId, metadata }) => {
      const ack = () => cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      const image = Buffer.from(data, "base64");
      // Zoomed-out pages (mobile emulation without a meta viewport) render
      // smaller than layout px; viewer coords must be divided by this.
      tab.pageScale = (metadata && metadata.pageScaleFactor) || 1;
      // Side-by-side panes render below the browser's start scale, where
      // Chrome reports frame sizes wrongly: stamp the size we know instead.
      if (this.multi) metadata = { ...metadata, ...this.paneCssSize(tab) };
      // Taking a still makes Chrome emit one more stream frame of the same
      // picture. Showing it would swap the crisp still for a lossy copy, so
      // drop a frame that is byte-identical to the last one streamed.
      const echo = tab.lastFrame && tab.lastFrame.still && tab.lastStreamImage && image.equals(tab.lastStreamImage);
      tab.lastStreamImage = image;
      if (echo) return ack();
      // Side-by-side panes render below the start scale, where that extra
      // frame often comes at full size instead (not byte-identical). Drop what
      // arrives right after a still, then confirm with one more still so a
      // real change in that window is not lost.
      if (this.multi && tab.lastFrame && tab.lastFrame.still && Date.now() - (tab.sharpDoneAt || 0) < 150) {
        if (!tab.verifyTimer && !tab.verified) {
          tab.verifyTimer = setTimeout(() => {
            tab.verifyTimer = null;
            tab.verified = true;
            this.sendSharp(tab).catch(() => {});
          }, 250);
        }
        return ack();
      }
      tab.verified = false;
      const seq = ++this.frameSeq;
      const buf = this.packFrame(seq, metadata, image, 0, this.paneIndex(tab));
      tab.lastFrame = { buf, metadata, at: Date.now() };
      if (!isShown() || !this.clients.size) return ack();
      if (!tab.mirror) this.checkFrameSize(tab, metadata);
      let sent = 0;
      for (const c of this.clients.values()) {
        if (c.ws.readyState === 1 && c.ws.bufferedAmount < 4 * 1024 * 1024) {
          c.ws.send(buf, { binary: true });
          sent++;
        }
      }
      if (!sent) return ack();
      // Chrome only renders the next frame once this one is acknowledged, so
      // acknowledging when a viewer has drawn it keeps the stream exactly as
      // fast as the viewer, with no queue of stale frames in between.
      let done = false;
      const once = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pendingAcks.delete(seq);
        ack();
      };
      const timer = setTimeout(once, 250);
      this.pendingAcks.set(seq, once);
      this.scheduleSharp(tab);
    });
    cdp.on("Page.fileChooserOpened", ev => this.onFileChooser(tab, ev));
    // Window mode side-by-side: the tab's own document is replaced by the
    // side-by-side page (only while it is on; see setMultiWindow).
    if (WINDOW_MODE) cdp.on("Fetch.requestPaused", ev => this.onDocRequest(tab, ev));
    try {
      tab.mainFrameId = (await cdp.send("Page.getFrameTree")).frameTree.frame.id;
    } catch {}
    cdp.on("Page.frameNavigated", ({ frame }) => {
      if (frame.parentId) {
        // Side-by-side page: the pane Claude acts on loaded another page.
        if (frame.parentId === tab.mainFrameId && this.shellTab() === tab && String(frame.name || "").startsWith(`cb-pane-${this.primaryKey()}-`)) {
          tab.errorList = [];
          tab.navNetSeq = this.netSeq;
          tab.errors = 0;
          if (isActive()) this.pushUiSoon();
        }
        return;
      }
      tab.mainFrameId = frame.id;
      // An error page reports chrome-error://…; keep the address the user asked for.
      tab.failedUrl = frame.unreachableUrl || null;
      tab.errorList = [];
      tab.navNetSeq = this.netSeq;
      // A page loaded from scratch starts from the session as it is now.
      if (this.multi && !WINDOW_MODE && this.isShown(tab)) this.sessionPrint(tab).then(p => (tab.sessionPrint = p), () => {});
      this.onPaneNav(tab, frame.unreachableUrl || frame.url, false);
      if (tab.errors) {
        tab.errors = 0;
        if (isActive()) this.broadcast({ t: "errors", count: 0 });
        if (isActive()) this.pushUiSoon();
      }
    });
    if (this.colorScheme) await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: this.colorScheme }] }).catch(() => {});
    cdp.on("Page.navigatedWithinDocument", ({ frameId, url }) => {
      if (frameId === tab.mainFrameId) this.onPaneNav(tab, url, true);
    });
    cdp.on("Page.frameStartedLoading", ({ frameId }) => {
      if (frameId === tab.mainFrameId) this.setNav(tab, { loading: true });
    });
    cdp.on("Page.frameStoppedLoading", ({ frameId }) => {
      if (frameId === tab.mainFrameId) {
        this.setNav(tab, { loading: false });
        this.refreshNav(tab);
      }
    });

    page.on("framenavigated", f => {
      if (f !== page.mainFrame()) return;
      this.refreshNav(tab);
      if (!this.busyTools && !tab.mirror) this.noteDev(tab, { kind: "load", files: [] });
    });
    page.on("load", () => this.refreshNav(tab));
    page.on("console", msg => {
      // Already logged (with method + URL) by the response handler below.
      if (msg.type() === "error" && msg.text().startsWith("Failed to load resource")) return;
      // Side-by-side: every pane runs the same page, so one error shows up in each.
      if (this.paneEcho(tab, msg.type() + msg.text())) return;
      const loc = msg.location && msg.location();
      this.pushLog(msg.type(), msg.text(), loc && loc.url ? `${loc.url}:${loc.lineNumber ?? ""}` : "", tab);
      if (msg.type() === "error") {
        const frames = (msg.stackTrace ? msg.stackTrace() : []).map(f => ({ fn: "", url: f.url, line: (f.lineNumber || 0) + 1, col: (f.columnNumber || 0) + 1 }));
        // msg.text() prints objects as "[object Object]": read the real values.
        const plain = msg.text();
        const entry = this.noteError(tab, "console.error", plain, frames);
        if (entry && /\[object |JSHandle@/.test(plain)) {
          Promise.all(msg.args().map(a => withTimeout(a.jsonValue(), 1500, "arg").catch(() => String(a))))
            .then(vals => {
              entry.text = vals.map(v => (typeof v === "string" ? v : JSON.stringify(v))).join(" ").slice(0, 1500);
            })
            .catch(() => {});
        }
      }
    });
    page.on("pageerror", err => {
      const full = String((err && (err.stack || err.message)) || err);
      if (this.paneEcho(tab, "pageerror" + full.split("\n")[0])) return;
      this.pushLog("pageerror", full.split("\n").slice(0, 6).join("\n"), "", tab);
      this.noteError(tab, "exception", full.split("\n")[0], parseStack(full));
    });
    page.on("requestfailed", req => {
      const reason = req.failure() && req.failure().errorText;
      if (reason === "net::ERR_ABORTED") return;
      this.pushLog("network", `FAILED ${req.method()} ${req.url()} — ${reason}`, "", tab);
    });
    page.on("response", res => {
      if (res.status() >= 400) this.pushLog("network", `${res.status()} ${res.request().method()} ${res.url()}`, "", tab);
    });
    page.on("dialog", async d => {
      const type = d.type();
      this.pushLog("dialog", `${type}: ${d.message()}`, "", tab);
      this.toast(`${type}: ${d.message()}`.slice(0, 200));
      try {
        if (type === "prompt") await d.accept(d.defaultValue());
        else await d.accept();
      } catch {}
    });
    page.on("close", () => this.onTabClosed(tab).catch(e => log("tab close", e)));
    // Cursor mode: a webview that turns out to be DevTools stops being a tab.
    if (CURSOR_MODE) page.on("framenavigated", f => f === page.mainFrame() && isDevtoolsUrl(f.url()) && this.onTabClosed(tab).catch(() => {}));

    this.refreshNav(tab);
    this.broadcastTabs();
    return tab;
  }

  async activate(tab) {
    if (!tab || !this.tabs.includes(tab)) return;
    const prev = this.active;
    if (prev && prev !== tab && prev.sweep) await this.stopSweep(prev);
    if (prev && prev !== tab && prev.screencasting) {
      prev.screencasting = false;
      await prev.cdp.send("Page.stopScreencast").catch(() => {});
    }
    if (prev && prev !== tab && prev.picking) {
      prev.picking = false;
      prev.page.evaluate(() => window.__cb && window.__cb.isPicking() && window.__cb.setPick(false)).catch(() => {});
      this.broadcast({ t: "pickState", on: false });
    }
    this.active = tab;
    this.flushAcks();
    await withTimeout(tab.page.bringToFront(), 5000, "bringToFront").catch(() => {});
    tab.viewportKey = null; // re-apply: the panel may have changed size meanwhile
    await this.applyViewport();
    if (this.clients.size) await this.startScreencast();
    // Show the cached frame only if it already has the right size; a stale,
    // smaller one would sit there until the page repaints.
    if (tab.lastFrame && this.frameFits(tab.lastFrame.metadata)) for (const c of this.clients.values()) if (c.ws.readyState === 1) c.ws.send(tab.lastFrame.buf, { binary: true });
    this.kickFrame(tab);
    this.broadcast({ t: "devtools", path: this.devtoolsPath() });
    this.broadcast({ t: "nav", ...tab.nav, start: isStartUrl(tab.nav.url) });
    this.broadcast({ t: "media", ...(tab.media || { camera: false, mic: false }) });
    this.broadcast({ t: "errors", count: tab.errors });
    this.broadcast({ t: "hung", on: !!tab.hung });
    for (const [id, p] of this.permPending) if (p.tab === tab) this.broadcast({ t: "permission", id, origin: p.origin, kinds: ["camera", "microphone"] });
    this.broadcastTabs();
    if (WINDOW_MODE) this.pushUi(tab);
    else if (this.multi) {
      this.setSync();
      this.onPaneNav(tab, tab.failedUrl || tab.nav.url, false);
    }
  }

  async newTab(url, opts = {}) {
    if (!this.browser || !this.browser.connected) {
      await this.ensure();
      if (!url) return this.active;
    }
    if (CURSOR_MODE) {
      // Target.createTarget would open a bare Electron window: let Cursor open the tab.
      const page = await this.openCursorTab(url && normalizeUrl(url), opts);
      const tab = await this.addTab(page);
      if (!opts.background) await this.activate(tab);
      return tab;
    }
    this.creatingTab = true;
    let page;
    try {
      page = await this.browser.newPage();
    } finally {
      this.creatingTab = false;
    }
    const tab = await this.addTab(page);
    if (!opts.background) await this.activate(tab);
    if (url) await page.goto(normalizeUrl(url), { waitUntil: "domcontentloaded", timeout: 30000 }).catch(e => this.toast(e.message.split("\n")[0]));
    return tab;
  }

  async closeTab(tab) {
    if (!tab) return;
    // Closing the target would leave a dead editor tab in Cursor.
    if (CURSOR_MODE) return this.toast("Close Browser Tabs in Cursor itself");
    if (this.tabs.length === 1) {
      // Never leave zero tabs: show the start page in the last one instead.
      await tab.page.goto(START_URL).catch(() => {});
      return;
    }
    await tab.page.close().catch(() => {});
  }

  async onTabClosed(tab) {
    if (WINDOW_MODE && this.multi && this.multi.tab === tab) {
      this.multi = null;
      this.broadcast(this.multiState());
    }
    const mi = this.mirrors.indexOf(tab);
    if (mi !== -1) this.mirrors.splice(mi, 1);
    // A device window closed by hand: the others stay; fewer than two ends the view.
    if (tab.mirror && !tab.closingByUs && this.multi) {
      const keys = this.multi.keys.filter(k => k !== tab.mirror.key);
      if (keys.length < 2) this.setMulti(null).catch(e => log("multi off", e.message));
      else {
        this.multi.keys = keys;
        this.broadcast(this.multiState());
      }
    }
    const idx = this.tabs.indexOf(tab);
    if (idx === -1) return;
    this.tabs.splice(idx, 1);
    if (this.active === tab) {
      this.active = null;
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
      if (next) await this.activate(next);
      // Cursor rebuilds a Browser Tab's view on reload (old target gone, a new
      // one about a second later): wait for it instead of opening another tab.
      else if (CURSOR_MODE) this.waitCursorReplacement();
      else if (this.browser && this.browser.connected) await this.newTab(null);
    }
    this.broadcastTabs();
  }

  async onTargetCreated(target) {
    if (target.type() !== (CURSOR_MODE ? "webview" : "page") || this.creatingTab) return;
    if (CURSOR_MODE) {
      // A new webview starts blank; DevTools shows its devtools:// URL a moment later.
      for (let i = 0; i < 15 && (!target.url() || target.url() === "about:blank"); i++) await sleep(100);
      if (isDevtoolsUrl(target.url())) return;
    }
    const page = await target.page();
    if (!page || this.tabs.some(t => t.page === page)) return;
    // Popups / target=_blank / window.open (opened by one of our tabs) become
    // new foreground tabs. Anything else was opened by Chrome itself or sent
    // to it by macOS (a link clicked in another app, ⌘, from the app menu,
    // a Dock "reopen"): the headless instance shares Chrome's bundle id, so
    // LaunchServices can route those here. Hand them to the user's Chrome.
    const opener = target.opener();
    const fromUs = opener && [...this.tabs, ...this.mirrors].some(t => t.page && t.page.target() === opener);
    if (!fromUs && !WINDOW_MODE) {
      await this.forwardForeignTab(target, page);
      return;
    }
    const tab = await this.addTab(page);
    // A tab the user opened in the window becomes active when it is shown.
    // Cursor mode: with no active tab (the view was just rebuilt), this is it.
    if (fromUs || (CURSOR_MODE && !this.active)) await this.activate(tab);
  }

  noteInput(what) {
    this.recentInput.push({ at: Date.now(), what });
    if (this.recentInput.length > 8) this.recentInput.shift();
  }

  async forwardForeignTab(target, page) {
    const now = Date.now();
    const recent = this.recentInput.filter(r => now - r.at < 10000).map(r => `${r.what} (${now - r.at}ms ago)`);
    log("foreign tab opened while on", this.nav && this.nav.url, "| recent input:", recent.join("; ") || "none");
    let url = target.url();
    // The URL may only arrive with the first navigation.
    for (let i = 0; i < 20 && (!url || url === "about:blank"); i++) {
      await sleep(100);
      url = target.url();
    }
    log("foreign tab", url || "(blank)");
    await page.close().catch(() => {});
    if (!url || /^(about:blank|chrome:\/\/(new-tab-page|newtab)\/?$|chrome-search:)/.test(url)) return;
    // chrome:// pages opened by this instance are about this instance: drop them.
    if (!/^(https?|file):/i.test(url)) return;
    // Only an installed Chrome can be mistaken for the user's: our own build
    // has its own bundle id and never receives these.
    if (!this.browserInfo || this.browserInfo.kind !== "system" || !this.executablePath) return;
    try {
      // Launching the binary with the default profile passes the URL to the
      // user's running Chrome (process singleton) instead of this instance.
      const { spawn } = require("child_process");
      spawn(this.executablePath, [url], { detached: true, stdio: "ignore" }).unref();
    } catch (e) {
      log("forward tab", e.message);
    }
  }

  tabList() {
    return this.tabs.map(t => ({
      id: t.id,
      title: isStartUrl(t.nav.url) ? "New Tab" : t.nav.title || t.nav.url || "New Tab",
      url: t.nav.url,
      loading: !!t.nav.loading,
      active: t === this.active,
      media: !!(t.media && (t.media.camera || t.media.mic)),
    }));
  }

  broadcastTabs() {
    this.broadcast({ t: "tabs", tabs: this.tabList() });
    this.saveSession();
  }

  tabByRef(ref) {
    if (ref === undefined || ref === null || ref === "") return this.active;
    if (typeof ref === "number" || /^\d+$/.test(String(ref))) return this.tabs[Number(ref)] || null;
    return this.tabs.find(t => t.id === ref) || null;
  }

  // ---------- downloads ----------
  async setupDownloads() {
    try {
      const cdp = await this.browser.target().createCDPSession();
      this.browserCdp = cdp;
      fs.mkdirSync(DOWNLOAD_TMP, { recursive: true });
      await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: DOWNLOAD_TMP, eventsEnabled: true });
      cdp.on("Browser.downloadWillBegin", ev => {
        const d = { guid: ev.guid, url: ev.url, name: ev.suggestedFilename || "download", state: "inProgress", received: 0, total: 0, path: null, at: Date.now() };
        this.downloads.unshift(d);
        this.downloads.length = Math.min(this.downloads.length, 30);
        this.broadcast({ t: "download", ...d });
      });
      cdp.on("Browser.downloadProgress", ev => {
        const d = this.downloads.find(x => x.guid === ev.guid);
        if (!d) return;
        d.received = ev.receivedBytes;
        d.total = ev.totalBytes;
        if (ev.state === "completed" && d.state !== "completed") {
          d.state = "completed";
          d.path = this.finishDownload(d);
          this.broadcast({ t: "download", ...d });
        } else if (ev.state === "canceled") {
          d.state = "canceled";
          this.broadcast({ t: "download", ...d });
        }
      });
    } catch (e) {
      log("downloads setup", e.message);
    }
  }

  // Chrome saved it under its GUID; move it to ~/Downloads with a unique name.
  finishDownload(d) {
    const src = path.join(DOWNLOAD_TMP, d.guid);
    const safe = path.basename(d.name).replace(/[\/\\:*?"<>|]/g, "_") || "download";
    const ext = path.extname(safe);
    const base = safe.slice(0, safe.length - ext.length);
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    let dest = path.join(DOWNLOAD_DIR, safe);
    for (let i = 1; fs.existsSync(dest); i++) dest = path.join(DOWNLOAD_DIR, `${base} (${i})${ext}`);
    try {
      fs.renameSync(src, dest);
    } catch {
      try {
        fs.copyFileSync(src, dest);
        fs.rmSync(src, { force: true });
      } catch (e) {
        log("download move", e.message);
        return src;
      }
    }
    return dest;
  }

  // ---------- file uploads ----------
  onFileChooser(tab, ev) {
    tab.pendingChooser = { backendNodeId: ev.backendNodeId, mode: ev.mode, at: Date.now() };
    const userInitiated = Date.now() - this.lastUserInput.at < 2000;
    if (tab === this.active && userInitiated) {
      this.broadcast({ t: "fileChooser", multiple: ev.mode === "selectMultiple", requester: this.lastUserInput.client });
    }
  }

  async setFiles(tab, paths) {
    const chooser = tab && tab.pendingChooser;
    if (!chooser) throw new Error("No file chooser is open — click the upload control first, or pass a ref/selector of the file input.");
    tab.pendingChooser = null;
    const files = chooser.mode === "selectMultiple" ? paths : paths.slice(0, 1);
    await tab.cdp.send("DOM.setFileInputFiles", { files, backendNodeId: chooser.backendNodeId });
    return files;
  }

  saveUploads(files) {
    const dir = path.join(HOME, "uploads", crypto.randomBytes(6).toString("hex"));
    fs.mkdirSync(dir, { recursive: true });
    return files.map(f => {
      const p = path.join(dir, path.basename(f.name || "file").replace(/[\/\\]/g, "_"));
      fs.writeFileSync(p, Buffer.from(f.data, "base64"));
      return p;
    });
  }

  // Chrome's own DevTools frontend, served through our port; the CDP socket
  // is proxied (token in the path) so Chrome's debug port never needs exposing.
  devtoolsPath() {
    if (!this.chromePort || !this.targetId) return null;
    return `/devtools/inspector.html?panel=console&ws=127.0.0.1:${PORT}/cdp/${TOKEN}/${this.targetId}`;
  }

  // ---------- page errors (the red badge, "send to Claude") ----------
  noteError(tab, kind, text, frames) {
    if (!tab || tab.mirror) return;
    const list = (tab.errorList = tab.errorList || []);
    const msg = String(text).slice(0, 1500);
    const last = list[list.length - 1];
    if (last && (last.raw || last.text) === msg) {
      last.count++;
      last.at = Date.now();
      return null;
    }
    const entry = { id: ++this.errorSeq, kind, text: msg, raw: msg, frames, at: Date.now(), count: 1, netSeq: this.netSeq };
    list.push(entry);
    if (list.length > 40) list.shift();
    return entry;
  }

  failedRequests(tab) {
    return this.net.filter(e => e.tab === tab && e.seq > (tab.navNetSeq || 0) && (e.error ? e.error !== "canceled" : e.status >= 400) && !/\/favicon\.ico(\?|$)/.test(e.url)).slice(-6);
  }

  async errorSummary(tab) {
    const items = await Promise.all(
      ((tab && tab.errorList) || []).map(async e => {
        const mapped = await mapFrames(e.frames, 1);
        return { id: e.id, kind: e.kind, text: e.text.slice(0, 300), where: mapped[0] ? mapped[0].src.replace(/^.*\/(?=[^/]+\/[^/]+$)/, "") : "", count: e.count };
      })
    );
    const requests = tab ? this.failedRequests(tab).map(r => ({ seq: r.seq, status: r.error ? "ERR" : r.status, method: r.method, url: r.url.replace(/^https?:\/\/[^/]+/, "") })) : [];
    return { t: "errorList", items: items.reverse(), requests };
  }

  // Turns errors into a report Claude reads with browser_picked, the same way
  // an element pick travels (the first source frame becomes the @-mention).
  async sendErrors(ids, requester) {
    const tab = this.active;
    const list = ((tab && tab.errorList) || []).filter(e => !ids || ids.includes(e.id));
    if (!list.length) {
      this.toast("No errors to send");
      return 0;
    }
    const lines = ["[Errors from the page — Claude Browser. The user sent these to be fixed; the file:line below is where each was thrown.]", `Page: ${tab.failedUrl || tab.page.url()}`];
    let chain = [];
    for (const e of list.slice(-8)) {
      const mapped = await mapFrames(e.frames);
      if (!chain.length) chain = mapped;
      lines.push("", `${e.kind === "exception" ? "Uncaught exception" : "console.error"}${e.count > 1 ? ` (×${e.count})` : ""}: ${await mapUrlsInText(e.text).catch(() => e.text)}`);
      if (mapped.length) {
        const w = Math.max(...mapped.map(m => m.name.length));
        lines.push("Stack (mapped to source, innermost first):", ...mapped.map((m, i) => `  ${i ? "← " : "  "}${m.name.padEnd(w)}  ${m.src}`));
      } else if (e.frames.length) {
        // No source map (plain script, production build or library code).
        lines.push("Stack (no source map, generated code):", ...e.frames.slice(0, 5).map((f, i) => `  ${i ? "← " : "  "}${f.fn || "(anonymous)"}  ${f.url}:${f.line}:${f.col}`));
      }
    }
    const reqs = this.failedRequests(tab);
    if (reqs.length) {
      lines.push("", "Failed requests on this page (full payload and response: browser_network({ id })):", ...reqs.map(r => `  #${r.seq}  ${r.error ? "ERR" : r.status} ${r.method} ${r.url}${r.error ? ` — ${r.error}` : ""}`));
    }
    const pick = { report: lines.join("\n"), chain, selector: "", url: tab.page.url(), at: Date.now() };
    this.picks.unshift(pick);
    this.picks.length = Math.min(this.picks.length, 10);
    this.broadcast({ t: "picked", ...pick, requester, title: (this.nav && this.nav.title) || "", keep: true, kind: "errors", count: list.length });
    return list.length;
  }

  // ---------- annotated screenshots ----------
  // The viewer sends the image with the user's marks drawn on it, plus the
  // marks in page coordinates; here they are tied to elements and source lines.
  async annotate(target, msg, requester) {
    const marks = (Array.isArray(msg.marks) ? msg.marks : []).slice(0, 12);
    const s = (target && target.pageScale) || 1;
    const scaled = marks.map(m => (m.kind === "arrow" ? { kind: "arrow", x1: m.x1 / s, y1: m.y1 / s, x2: m.x2 / s, y2: m.y2 / s } : { kind: "rect", x: m.x / s, y: m.y / s, w: m.w / s, h: m.h / s }));
    const found = await target.page.evaluate(ms => (window.__cb && window.__cb.describeMarks ? window.__cb.describeMarks(ms) : []), scaled).catch(() => []);
    const image = String(msg.image || "").replace(/^data:image\/png;base64,/, "");
    const vp = target.mirror ? target.mirror : this.cssSize();
    await this.reportAnnotation({ marks: scaled, found, image, url: target.failedUrl || target.page.url(), vp, label: target.mirror ? target.mirror.label : "", note: msg.note }, requester);
  }

  // marks: in the page's CSS px; found: describeMarks() of the page. Saves
  // the picture and stores the report for browser_picked. Returns the file.
  async reportAnnotation({ marks, found, image, url, vp, label, note: rawNote }, requester) {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = path.join(SHOTS_DIR, `annotated-${stamp}.png`);
    if (image) fs.writeFileSync(file, Buffer.from(image, "base64"));
    const lines = [
      `[Annotated screenshot — Claude Browser. The user drew ${marks.length === 1 ? "a mark" : `${marks.length} numbered marks`} on the page to show what they mean; the image is attached${image ? ` (also saved at ${file})` : ""}.]`,
      `Page: ${url}`,
      `Viewport: ${vp.width}×${vp.height}${label ? ` (${label}${WINDOW_MODE ? " pane of the side-by-side view" : ""})` : ""}`,
    ];
    const note = String(rawNote || "").trim();
    if (note) lines.push(`User's note: ${note}`);
    let chain = [];
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i];
      const els = (found[i] && found[i].els) || [];
      lines.push("", m.kind === "arrow" ? `${i + 1}. Arrow pointing at (${Math.round(m.x2)}, ${Math.round(m.y2)}):` : `${i + 1}. Rectangle ${Math.round(m.w)}×${Math.round(m.h)} at (${Math.round(m.x)}, ${Math.round(m.y)}) covers:`);
      if (!els.length) lines.push("     (no element found there)");
      for (const el of els) {
        const resolved = (await Promise.all((el.chain || []).map(async c => ({ name: c.name, src: c.src ? await resolveMarkers(c.src).catch(() => "") : "" })))).filter(c => c.src);
        if (!chain.length && resolved.length) chain = resolved;
        lines.push(`     <${el.tag}>${el.label ? ` "${el.label}"` : ""}  ${el.box}  selector: ${el.selector}`);
        if (resolved.length) lines.push(`        ${resolved.map((c, j) => `${j ? "← " : ""}${c.name} ${c.src}`).join("  ")}`);
      }
    }
    const pick = { report: lines.join("\n"), chain, selector: "", url, at: Date.now(), image: image || null };
    this.picks.unshift(pick);
    this.picks.length = Math.min(this.picks.length, 10);
    this.broadcast({ t: "picked", report: pick.report, chain, url: pick.url, at: pick.at, requester, title: (this.nav && this.nav.title) || "", keep: true, kind: "annotation", path: image ? file : "" });
    return image ? file : "";
  }

  // ---------- network log (browser_network) ----------
  // Every request of the real tabs, newest last. Bodies of API calls are kept
  // as they finish, because Chrome drops them when the page navigates.
  watchNetwork(tab) {
    const cdp = tab.cdp;
    const live = new Map(); // requestId -> entry
    tab.netLive = live;
    // Requests not answered yet (requestId -> start time): the side-by-side
    // page starts the next pane's load only while this is low.
    const pending = (tab.pending = new Map());
    const settled = id => pending.delete(id);
    cdp.send("Network.enable", { maxTotalBufferSize: 64 * 1024 * 1024, maxResourceBufferSize: 8 * 1024 * 1024 }).catch(() => {});
    const finish = (e, at) => {
      if (e.done) return;
      e.done = true;
      if (at) e.ms = Math.max(0, Math.round((at - e.started) * 1000));
    };
    cdp.on("Network.requestWillBeSent", ev => {
      const prev = live.get(ev.requestId);
      if (prev && ev.redirectResponse) {
        prev.status = ev.redirectResponse.status;
        prev.resHeaders = ev.redirectResponse.headers;
        prev.redirectedTo = ev.request.url;
        finish(prev, ev.timestamp);
      }
      const e = {
        seq: ++this.netSeq,
        tab,
        requestId: ev.requestId,
        url: ev.request.url,
        method: ev.request.method,
        type: (ev.type || "Other").toLowerCase(),
        reqHeaders: ev.request.headers,
        postData: ev.request.postData,
        hasPostData: !!ev.request.hasPostData,
        started: ev.timestamp,
        at: Date.now(),
        initiator: ev.initiator && ev.initiator.type === "script" && ev.initiator.stack && ev.initiator.stack.callFrames[0] ? ev.initiator.stack.callFrames.slice(0, 4).map(f => `⟦${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1}⟧`) : null,
        status: 0,
        ms: null,
        size: null,
        done: false,
      };
      live.set(ev.requestId, e);
      pending.set(ev.requestId, Date.now());
      this.net.push(e);
      if (this.net.length > 1600) {
        // A dev server loads hundreds of modules per page: let those go first
        // so the API calls of an earlier page are still there to look at.
        const api = /^(fetch|xhr|document|websocket|eventsource)$/;
        let drop = this.net.length - 1200;
        this.net = this.net.filter(x => drop <= 0 || api.test(x.type) || x.error || x.status >= 400 || !drop--);
        if (this.net.length > 1400) this.net.splice(0, this.net.length - 1400);
      }
    });
    cdp.on("Network.responseReceived", ev => {
      const e = live.get(ev.requestId);
      if (!e) return;
      e.status = ev.response.status;
      e.statusText = ev.response.statusText;
      e.mime = ev.response.mimeType;
      e.resHeaders = ev.response.headers;
      e.fromCache = !!(ev.response.fromDiskCache || ev.response.fromPrefetchCache);
      e.remote = ev.response.remoteIPAddress ? `${ev.response.remoteIPAddress}:${ev.response.remotePort}` : "";
      if (ev.response.timing) e.ttfb = Math.round(ev.response.timing.receiveHeadersEnd);
    });
    cdp.on("Network.loadingFinished", ev => {
      settled(ev.requestId);
      const e = live.get(ev.requestId);
      if (!e) return;
      e.size = ev.encodedDataLength;
      finish(e, ev.timestamp);
      const textual = /json|text|xml|javascript|x-www-form-urlencoded|graphql/i.test(e.mime || "");
      if ((e.type === "fetch" || e.type === "xhr" || e.type === "document") && textual && (e.size || 0) < 1024 * 1024) {
        cdp
          .send("Network.getResponseBody", { requestId: ev.requestId })
          .then(r => {
            e.body = r.base64Encoded ? Buffer.from(r.body, "base64").toString("utf8") : r.body;
            if (e.body.length > 400000) e.body = e.body.slice(0, 400000) + "\n… (cut)";
          })
          .catch(() => {});
      }
    });
    cdp.on("Network.webSocketFrameReceived", ev => {
      if (ev.response && ev.response.opcode === 1) this.onDevFrame(tab, ev.response.payloadData);
    });
    cdp.on("Network.loadingFailed", ev => {
      settled(ev.requestId);
      const e = live.get(ev.requestId);
      if (!e) return;
      e.error = ev.canceled ? "canceled" : ev.errorText || "failed";
      if (ev.blockedReason) e.error += ` (blocked: ${ev.blockedReason})`;
      if (ev.corsErrorStatus) e.error += ` (CORS: ${ev.corsErrorStatus.corsError})`;
      finish(e, ev.timestamp);
    });
  }

  async networkTool(args) {
    const text = t => [{ type: "text", text: t }];
    const kb = n => (n == null ? "" : n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)}kB` : `${(n / 1024 / 1024).toFixed(1)}MB`);
    if (args.clear) {
      this.net = [];
      return text("Network log cleared.");
    }
    const SECRET = /^(authorization|cookie|set-cookie|x-api-key|x-auth-token|proxy-authorization)$/i;
    const headers = h =>
      Object.entries(h || {})
        .map(([k, v]) => `  ${k}: ${SECRET.test(k) && !args.showSecrets ? String(v).slice(0, 12) + "… (hidden, pass showSecrets:true to see it)" : String(v).slice(0, 500)}`)
        .join("\n");
    const pretty = (body, mime) => {
      if (body == null) return null;
      if (/json/i.test(mime || "") || /^\s*[[{]/.test(body)) {
        try {
          return JSON.stringify(JSON.parse(body), null, 2);
        } catch {}
      }
      return body;
    };

    if (args.id !== undefined) {
      const e = this.net.find(x => x.seq === Number(args.id));
      if (!e) return text(`No request #${args.id} in the log (only the latest requests are kept).`);
      const max = args.maxChars || 8000;
      let post = e.postData;
      if (post === undefined && e.hasPostData) post = await e.tab.cdp.send("Network.getRequestPostData", { requestId: e.requestId }).then(r => r.postData, () => undefined);
      let body = e.body;
      if (body === undefined && e.done && !e.error) {
        body = await e.tab.cdp
          .send("Network.getResponseBody", { requestId: e.requestId })
          .then(r => (r.base64Encoded ? (/json|text|xml|javascript/i.test(e.mime || "") ? Buffer.from(r.body, "base64").toString("utf8") : `(binary, ${kb(Buffer.from(r.body, "base64").length)})`) : r.body), () => undefined);
      }
      const cut = (t, label) => (t.length > max ? `${t.slice(0, max)}\n… (${label} is ${t.length} chars; pass maxChars to see more)` : t);
      const out = [
        `#${e.seq} ${e.method} ${e.url}`,
        `Status: ${e.error ? `FAILED — ${e.error}` : e.status ? `${e.status} ${e.statusText || ""}`.trim() : "pending"}${e.fromCache ? " (from cache)" : ""}${e.redirectedTo ? `  → redirected to ${e.redirectedTo}` : ""}`,
        `Type: ${e.type}${e.mime ? `  ${e.mime}` : ""}  Time: ${e.ms == null ? "pending" : e.ms + "ms"}${e.ttfb != null ? ` (first byte ${e.ttfb}ms)` : ""}  Size: ${kb(e.size) || "?"}${e.remote ? `  Server: ${e.remote}` : ""}`,
      ];
      if (e.initiator) {
        const frames = (await Promise.all(e.initiator.map(m => resolveMarkers(m).catch(() => "")))).filter(Boolean);
        if (frames.length) out.push(`Started by: ${frames.join(" ← ")}`);
      }
      out.push("", "Request headers:", headers(e.reqHeaders));
      if (post !== undefined) out.push("", "Request body:", cut(pretty(post, e.reqHeaders && (e.reqHeaders["content-type"] || e.reqHeaders["Content-Type"])) || "", "request body"));
      out.push("", "Response headers:", headers(e.resHeaders));
      out.push("", "Response body:", body === undefined ? "(not available: still loading, empty, or dropped by the browser after a navigation)" : cut(pretty(body, e.mime) || "(empty)", "response body"));
      return text(out.join("\n"));
    }

    // List.
    const tabIdx = this.tabs.indexOf(this.active);
    // panes:true adds the other devices of the side-by-side view.
    let rows = this.net.filter(e => this.tabs.includes(e.tab) || (args.panes && this.mirrors.includes(e.tab)));
    if (!args.allTabs) rows = rows.filter(e => e.tab === this.active || (args.panes && e.tab.mirror));
    if (args.sinceSeq) rows = rows.filter(e => e.seq > args.sinceSeq);
    const types = args.types && args.types.length ? new Set(args.types.map(t => String(t).toLowerCase())) : args.all ? null : new Set(["fetch", "xhr", "document", "websocket", "eventsource"]);
    if (types) rows = rows.filter(e => types.has(e.type) || e.error || e.status >= 400);
    if (args.url) {
      let re = null;
      try {
        re = new RegExp(args.url, "i");
      } catch {}
      const needle = String(args.url).toLowerCase();
      rows = rows.filter(e => (re ? re.test(e.url) : e.url.toLowerCase().includes(needle)));
    }
    if (args.method) rows = rows.filter(e => e.method.toLowerCase() === String(args.method).toLowerCase());
    if (args.status) {
      const st = String(args.status).toLowerCase();
      rows = rows.filter(e => (st === "error" || st === "failed" ? e.error || e.status >= 400 : /^\dxx$/.test(st) ? Math.floor(e.status / 100) === Number(st[0]) : e.status === Number(st)));
    }
    const total = rows.length;
    rows = rows.slice(-(args.limit || 40));
    if (!rows.length) return text(`No matching requests${types && !args.types ? " (showing API calls and documents only; pass all:true for scripts, images, styles…)" : ""}. Latest seq ${this.netSeq}.`);
    const origin = (() => {
      try {
        return new URL(this.nav.url).origin;
      } catch {
        return "";
      }
    })();
    const lines = rows.map(e => {
      const st = e.error ? "ERR" : e.status || "…";
      const url = origin && e.url.startsWith(origin) ? e.url.slice(origin.length) || "/" : e.url;
      const who = args.panes ? `${(e.tab.mirror ? e.tab.mirror.key : "shared").padEnd(8)}` : "";
      return `#${e.seq}  ${who}${String(st).padEnd(3)} ${e.method.padEnd(6)} ${e.type.padEnd(8)} ${(e.ms == null ? "…" : e.ms + "ms").padStart(7)} ${kb(e.size).padStart(8)}  ${url.length > 160 ? url.slice(0, 160) + "…" : url}${e.error ? `  — ${e.error}` : ""}`;
    });
    return text(
      `${total > rows.length ? `Showing the last ${rows.length} of ${total} matching requests` : `${rows.length} request${rows.length === 1 ? "" : "s"}`}${args.allTabs ? " (all tabs)" : ` (tab ${tabIdx})`}${types && !args.types ? ", API calls and documents only (all:true for everything)" : ""}. Details with headers and bodies: browser_network({ id: N }).\n` +
        lines.join("\n") +
        `\n(latest seq ${this.netSeq})`
    );
  }

  // ---------- side-by-side view ----------
  isShown(tab) {
    return !!tab && (tab === this.active || this.mirrors.includes(tab));
  }

  shownTabs() {
    return [this.active, ...this.mirrors].filter(Boolean);
  }

  // 0 = the shared tab, 1.. = mirrors, in the order the viewer lays them out.
  paneIndex(tab) {
    const i = this.mirrors.indexOf(tab);
    return i === -1 ? 0 : i + 1;
  }

  paneTab(n) {
    return (n > 0 && this.mirrors[n - 1]) || this.active;
  }

  // A device of the side-by-side view at the size chosen for it.
  device(key) {
    const d = DEVICES[key];
    const own = this.sizes[key];
    return own ? { ...d, width: own.width, height: own.height, name: own.name || "" } : { ...d, name: "" };
  }

  // Another size for one of the devices (null: back to the default).
  async setMultiSize(key, size) {
    if (!DEVICES[key]) throw new Error(`unknown device "${key}" (mobile, tablet or desktop)`);
    if (size && size.width && size.height) {
      const width = Math.round(Math.min(3840, Math.max(240, Number(size.width))));
      const height = Math.round(Math.min(3000, Math.max(240, Number(size.height))));
      if (!width || !height) throw new Error("width and height must be numbers");
      if (width === DEVICES[key].width && height === DEVICES[key].height && !size.name) delete this.sizes[key];
      else this.sizes[key] = { width, height, name: String(size.name || "").slice(0, 40) };
    } else delete this.sizes[key];
    this.saveSession();
    if (!this.multi) return;
    if (WINDOW_MODE) return this.pushPanes();
    const d = this.device(key);
    const mirror = this.mirrors.find(m => m.mirror.key === key);
    if (mirror) {
      mirror.mirror = d;
      await this.applyMirrorViewport(mirror);
      this.kickFrame(mirror);
    } else if (this.multi.keys[this.multi.keys.length - 1] === key) {
      this.override = { width: d.width, height: d.height, mobile: d.mobile };
      await this.applyViewport();
      if (this.active) this.kickFrame(this.active);
    }
    this.broadcast(this.multiState());
  }

  multiState() {
    if (!this.multi) return { t: "multi", on: false, panes: [], sizes: this.sizes };
    if (WINDOW_MODE) return { t: "multi", on: true, keys: this.multi.keys, sizes: this.sizes, primary: this.primaryKey(), scale: this.multiScaleMode, panes: this.multi.keys.map((k, i) => ({ pane: i, ...this.device(k) })) };
    const primary = this.device(this.multi.keys[this.multi.keys.length - 1]);
    return { t: "multi", on: true, keys: this.multi.keys, sizes: this.sizes, panes: [{ pane: 0, ...primary }, ...this.mirrors.map((m, i) => ({ pane: i + 1, ...m.mirror }))] };
  }

  async applyMirrorViewport(tab) {
    const d = tab.mirror;
    // Window mode: 0 keeps the window's real pixel ratio (sharp on any screen).
    const dpr = WINDOW_MODE ? 0 : this.effective.dpr || 1;
    await withTimeout(tab.cdp.send("Emulation.setDeviceMetricsOverride", { width: d.width, height: d.height, deviceScaleFactor: dpr, mobile: !!d.mobile, screenWidth: d.width, screenHeight: d.height }), 8000, "mirror size").catch(e => log("mirror viewport", e.message));
    await tab.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: !!d.mobile }).catch(() => {});
    tab.mobile = !!d.mobile;
  }

  async closeMirror(tab) {
    tab.closingByUs = true;
    const i = this.mirrors.indexOf(tab);
    if (i !== -1) this.mirrors.splice(i, 1);
    await tab.page.close().catch(() => {});
  }

  // keys: which devices to show (two or more turns the view on).
  async setMulti(keys) {
    if (WINDOW_MODE) return this.setMultiWindow(keys);
    const want = DEVICE_ORDER.filter(k => Array.isArray(keys) && keys.includes(k));
    await this.ensure();
    if (want.length < 2) {
      if (!this.multi) return;
      const prev = this.multi.prevOverride;
      this.multi = null;
      for (const m of [...this.mirrors]) await this.closeMirror(m);
      this.override = prev || null;
      if (this.active) this.active.viewportKey = null;
      await this.applyViewport();
      this.broadcast(this.multiState());
      if (this.active) this.kickFrame(this.active);
      return;
    }
    const prevOverride = this.multi ? this.multi.prevOverride : this.override;
    this.multi = { keys: want, prevOverride };
    this.lastMultiKeys = want;
    const primary = this.device(want[want.length - 1]);
    const mirrorKeys = want.slice(0, -1);
    for (const m of [...this.mirrors]) if (!mirrorKeys.includes(m.mirror.key)) await this.closeMirror(m);
    const url = this.active ? this.active.failedUrl || this.active.nav.url : "";
    for (const key of mirrorKeys) {
      if (this.mirrors.some(m => m.mirror.key === key)) continue;
      // Its own window: only the front tab of a window is rendered, so a
      // mirror opened as a tab would blank the shared tab (or itself).
      this.creatingTab = true;
      let page;
      try {
        const known = new Set(this.browser.targets());
        await this.browserCdp.send("Target.createTarget", { url: "about:blank", newWindow: true, background: true });
        const target = await this.browser.waitForTarget(t => t.type() === "page" && !known.has(t), { timeout: 8000 });
        page = await target.page();
      } finally {
        this.creatingTab = false;
      }
      if (!page) throw new Error("could not open a preview window");
      const tab = await this.addTab(page, { mirror: this.device(key) });
      await this.applyMirrorViewport(tab);
      if (url && !/^about:/.test(url)) this.loadInTurn(tab, () => page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}));
    }
    this.mirrors.sort((a, b) => DEVICE_ORDER.indexOf(a.mirror.key) - DEVICE_ORDER.indexOf(b.mirror.key));
    this.override = { width: primary.width, height: primary.height, mobile: primary.mobile };
    await this.applyViewport();
    this.broadcast(this.multiState());
    this.setSync();
    // Opening other windows can leave the shared tab's stream silent: restart it.
    if (this.active && this.active.screencasting) {
      this.active.screencasting = false;
      await this.active.cdp.send("Page.stopScreencast").catch(() => {});
    }
    if (this.clients.size) await this.startScreencast();
    for (const t of this.shownTabs()) this.kickFrame(t);
  }

  // ---------- window mode: side-by-side in the tab itself ----------
  // The tab's own document is replaced by the side-by-side page (shell.html),
  // served at the page's address through request interception. Each pane is
  // a same-origin iframe of the real page at one device size, so it is one
  // tab with one DevTools, and the address bar keeps showing the page.
  shellTab() {
    const m = this.multi;
    return WINDOW_MODE && m && m.tab && this.tabs.includes(m.tab) ? m.tab : null;
  }

  // The widest device: the pane Claude's tools act on.
  primaryKey() {
    return this.multi ? this.multi.keys[this.multi.keys.length - 1] : null;
  }

  shellHtml(url) {
    const cfg = { url, panes: this.multi.keys.map(k => this.device(k)), primary: this.primaryKey(), scale: this.multiScaleMode || "fit", touch: this.touchPanes, ua: TOUCH_UA };
    return SHELL_HTML.replace("/*CONFIG*/null", JSON.stringify(cfg).replace(/</g, "\\u003c"));
  }

  onDocRequest(tab, ev) {
    const reply = (method, params) => tab.cdp.send(method, params).catch(e => log("doc request", method, e.message));
    const req = ev.request;
    if (ev.frameId === tab.mainFrameId && this.shellTab() === tab && req.method === "GET" && /^https?:/i.test(req.url) && !isStartUrl(req.url)) {
      return reply("Fetch.fulfillRequest", {
        requestId: ev.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: "Content-Type", value: "text/html; charset=utf-8" },
          { name: "Cache-Control", value: "no-store" },
        ],
        body: Buffer.from(this.shellHtml(req.url)).toString("base64"),
      });
    }
    // A touch pane's own page request carries its device's user agent too.
    if (this.shellTab() === tab && this.touchPanes && ev.frameId !== tab.mainFrameId) {
      return this.paneKeyOf(tab, ev.frameId).then(key => {
        const ua = key && this.device(key).mobile && TOUCH_UA[key];
        if (!ua) return reply("Fetch.continueRequest", { requestId: ev.requestId });
        const headers = Object.entries(req.headers || {}).filter(([k]) => k.toLowerCase() !== "user-agent").map(([name, value]) => ({ name, value: String(value) }));
        headers.push({ name: "User-Agent", value: ua });
        return reply("Fetch.continueRequest", { requestId: ev.requestId, headers });
      });
    }
    reply("Fetch.continueRequest", { requestId: ev.requestId });
  }

  // Which pane a frame is (from its iframe's name, cb-pane-<key>-<n>).
  async paneKeyOf(tab, frameId) {
    const tree = await tab.cdp.send("Page.getFrameTree").catch(() => null);
    const find = n => (n.frame.id === frameId ? n.frame : (n.childFrames || []).map(find).find(Boolean));
    const f = tree && find(tree.frameTree);
    const m = f && /^cb-pane-(\w+)-\d+$/.exec(f.name || "");
    return m ? m[1] : null;
  }

  // Sends the current devices to the side-by-side page.
  async pushPanes() {
    const tab = this.shellTab();
    if (tab) await tab.page.mainFrame().evaluate((list, primary) => window.__cbShell && window.__cbShell.setPanes(list, primary), this.multi.keys.map(k => this.device(k)), this.primaryKey()).catch(() => {});
    this.broadcast(this.multiState());
    this.pushUi();
  }

  async setMultiWindow(keys) {
    if (keys && this.active && this.active.sweep) await this.stopSweep(this.active);
    const want = DEVICE_ORDER.filter(k => Array.isArray(keys) && keys.includes(k));
    await this.ensure();
    const cur = this.shellTab();
    if (want.length < 2) {
      if (!this.multi) return;
      const prev = this.multi.prevOverride;
      this.multi = null;
      if (cur) {
        // Back to the page the pane in use is showing.
        const url = await withTimeout(cur.page.mainFrame().evaluate(() => (window.__cbShell ? window.__cbShell.leaderUrl() : location.href)), 3000, "pane url").catch(() => cur.page.url());
        await cur.cdp.send("Fetch.disable").catch(() => {});
        this.override = prev || null;
        cur.viewportKey = null;
        if (cur === this.active) await this.applyViewport();
        await cur.page.evaluate(u => location.replace(u), url).catch(() => {});
      }
      this.broadcast(this.multiState());
      this.pushUi();
      return;
    }
    this.lastMultiKeys = want;
    const tab = this.active;
    if (cur && cur === tab) {
      this.multi.keys = want;
      await this.pushPanes();
      return;
    }
    if (cur) await this.setMultiWindow(null);
    if (!tab) return;
    const url = tab.failedUrl || tab.page.url();
    if (!/^https?:/i.test(url) || isStartUrl(url)) {
      this.toast("Side by side works on a web page: open one first");
      return;
    }
    this.multi = { keys: want, tab, prevOverride: this.override };
    if (this.override) {
      this.override = null;
      tab.viewportKey = null;
      await this.applyViewport();
    }
    await tab.cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] });
    await tab.page.evaluate(u => location.replace(u), url).catch(() => {});
    this.broadcast(this.multiState());
    this.pushUi();
  }

  async paneFrame(tab, key) {
    for (const f of tab.page.mainFrame().childFrames()) {
      const k = await withTimeout(
        f.evaluate(() => {
          try {
            return (window.frameElement && window.frameElement.dataset.cbPane) || null;
          } catch {
            return null;
          }
        }),
        1500,
        "pane"
      ).catch(() => null);
      if (k === key) return f;
    }
    return null;
  }

  // Where a pane is in the tab (CSS px) and the scale it is shown at.
  async paneRect(tab, key) {
    return withTimeout(tab.page.mainFrame().evaluate(k => window.__cbShell && window.__cbShell.paneRect(k), key), 2000, "pane rect").catch(() => null);
  }

  // Where Claude's tools act: the page itself, or in the side-by-side view
  // the widest pane. ox/oy/s map the pane's coordinates to the tab's.
  async toolTarget() {
    const tab = this.active;
    if (tab && this.shellTab() === tab) {
      const key = this.primaryKey();
      for (let i = 0; i < 24; i++) {
        const [frame, r] = await Promise.all([this.paneFrame(tab, key), this.paneRect(tab, key)]);
        if (frame && r) return { frame, key, ox: r.x, oy: r.y, s: r.s || 1, rect: r, pane: this.device(key) };
        await sleep(250);
      }
      throw new Error("the side-by-side view is still loading; try again in a moment");
    }
    return { frame: this.page.mainFrame(), ox: 0, oy: 0, s: 1, rect: null, pane: null };
  }

  // Requests of a tab still waiting for an answer (long-lived ones, like an
  // event stream, stop counting after 20s).
  inflight(tab) {
    if (!tab || !tab.pending) return 0;
    const now = Date.now();
    let n = 0;
    for (const [id, at] of tab.pending) {
      if (now - at > 20000) tab.pending.delete(id);
      else n++;
    }
    return n;
  }

  // ---------- window mode: the toolbar in the page ----------
  uiState(tab = this.active) {
    const o = this.override;
    return {
      picking: !!(tab && tab.picking),
      errors: tab ? tab.errors : 0,
      multi: tab && this.shellTab() === tab ? this.multiState() : { on: false },
      devtools: !!(tab && tab.devtoolsId),
      scheme: this.colorScheme,
      device: o && !this.multi ? `${o.width}x${o.height}${o.mobile ? "m" : ""}` : "",
      prefs: this.uiPrefs,
      bridge: this.bridgeConnected(),
      sweep: tab && tab.sweep ? { on: true, paused: !!tab.sweep.paused, done: !!tab.sweep.done, label: tab.sweep.label || "" } : { on: false },
    };
  }

  pushUi(tab = this.active) {
    if (!WINDOW_MODE || !tab || !tab.page || tab.page.isClosed()) return;
    tab.page.mainFrame().evaluate(s => window.__cbUi && window.__cbUi.state(s), this.uiState(tab)).catch(() => {});
  }

  pushUiSoon() {
    if (!WINDOW_MODE) return;
    clearTimeout(this.uiTimer);
    this.uiTimer = setTimeout(() => this.pushUi(), 120);
  }

  uiToast(text, tab = this.active) {
    if (!WINDOW_MODE || !tab || !tab.page || tab.page.isClosed()) return;
    tab.page.mainFrame().evaluate(t => window.__cbUi && window.__cbUi.toast(t), String(text)).catch(() => {});
  }

  // Hides the toolbar (mode "all") or all but the drawn marks ("marks") for
  // a screenshot; null shows it again.
  async uiCapture(tab, mode) {
    if (!WINDOW_MODE || !tab) return;
    await withTimeout(tab.page.mainFrame().evaluate(m => (window.__cbUi ? window.__cbUi.capture(m) : true), mode), 1500, "toolbar").catch(() => {});
  }

  bridgeConnected() {
    for (const c of this.clients.values()) if (c.bridge && c.ws.readyState === 1) return true;
    return false;
  }

  // ---------- browser_verify: did the code change land? ----------
  // Dev servers tell the page about every rebuild on a websocket: Vite
  // (update / full-reload / error), webpack-dev-server (invalid / ok /
  // errors / static-changed) and Next.js (building / built / sync).
  onDevFrame(tab, raw) {
    if (tab.mirror || typeof raw !== "string" || raw.length > 300000 || raw[0] !== "{") return;
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    const plain = v => String(v || "").replace(/\x1b\[[0-9;]*m/g, "");
    const errs = list => list.map(d => plain(typeof d === "string" ? d : d && (d.message || d.text))).filter(Boolean).join("\n").slice(0, 1500);
    const t = m.type;
    const a = m.action;
    let ev = null;
    if (t === "update" && Array.isArray(m.updates)) ev = { kind: "update", files: [...new Set(m.updates.map(u => String(u.path || u.acceptedPath || "").replace(/[?#].*$/, "")).filter(Boolean))] };
    else if (t === "full-reload") ev = { kind: "reload", files: m.path && m.path !== "*" ? [m.path] : [] };
    else if (t === "error" && m.err) {
      const e = m.err;
      const loc = e.loc && e.loc.line ? `${e.loc.file || e.id || ""}:${e.loc.line}:${e.loc.column || 0}` : e.id || "";
      const frame = e.frame ? "\n" + plain(e.frame).split("\n").filter(l => l.trim()).slice(0, 8).join("\n") : "";
      ev = { kind: "error", error: `${e.plugin ? `[${e.plugin}] ` : ""}${plain(e.message).split("\n")[0]}${loc ? `\n  at ${loc}` : ""}${frame}` };
    } else if (t === "invalid" || a === "building") ev = { kind: "building" };
    else if ((t === "errors" && Array.isArray(m.data) && m.data.length) || ((a === "built" || a === "sync") && Array.isArray(m.errors) && m.errors.length)) ev = { kind: "error", error: errs(m.data || m.errors) };
    else if (t === "ok" || t === "still-ok" || a === "built" || a === "serverComponentChanges") ev = { kind: "update", files: [] };
    else if (t === "static-changed" || a === "reloadPage") ev = { kind: "reload", files: [] };
    if (ev) this.noteDev(tab, ev);
  }

  noteDev(tab, ev) {
    const now = Date.now();
    const key = `${ev.kind}|${(ev.files || []).join(",")}|${ev.error || ""}`;
    // In the side-by-side view every pane runs the dev client: one change, one event.
    if (this.devEvents.some(e => e.tab === tab && e.key === key && now - e.at < 300)) return;
    this.devEvents.push({ files: [], ...ev, key, at: now, seq: this.logSeq, tab });
    if (this.devEvents.length > 300) this.devEvents.splice(0, 150);
  }

  // The pane a frame of the side-by-side page belongs to (null outside it).
  verifyPaneKey(tab, frame, pick) {
    if (!frame || frame === tab.page.mainFrame() || this.shellTab() !== tab) return null;
    return (pick && pick.pane) || this.primaryKey();
  }

  // What the picked element looked like when it was picked: browser_verify's "before".
  async basePick(pick) {
    try {
      await sleep(350); // the pick highlight goes first
      const t = await this.inspectTarget({ pick: pick.id });
      const snap = await withTimeout(t.frame.evaluate(s => window.__cb && window.__cb.verifySnap && window.__cb.verifySnap(s, null, false), t.spec), 3000, "snapshot");
      if (!snap || !snap.found) return;
      snap.image = await this.verifyShot(t.tab, t.frame, this.verifyPaneKey(t.tab, t.frame, pick), snap).catch(() => null);
      snap.at = Date.now();
      if (!pick.base) pick.base = snap;
    } catch (e) {
      log("pick base", e.message);
    }
  }

  // The element with a little room around it, as it is shown (CSS px).
  async verifyShot(tab, frame, paneKey, snap) {
    const pad = 8;
    const r = snap.rect;
    const x0 = Math.max(0, r.x - pad);
    const y0 = Math.max(0, r.y - pad);
    const x1 = Math.min(snap.vw, r.x + r.width + pad);
    const y1 = Math.min(snap.vh, r.y + r.height + pad, y0 + 1400);
    if (x1 - x0 < 2 || y1 - y0 < 2) return null;
    if (paneKey) {
      const p = await this.paneRect(tab, paneKey);
      if (!p) return null;
      const s = p.s || 1;
      return this.capture(tab, { x: p.x + x0 * s, y: p.y + y0 * s, width: (x1 - x0) * s, height: (y1 - y0) * s, scale: 1 / s }, "all");
    }
    if (frame !== tab.page.mainFrame()) return null; // inside an iframe of the page: no picture
    const eff = this.effective;
    const clip = { x: x0 + snap.scroll.x, y: y0 + snap.scroll.y, width: x1 - x0, height: y1 - y0, scale: 1 / ((eff.dpr || 1) * (eff.zoom || 1)) };
    await this.uiCapture(tab, "all");
    try {
      return await withTimeout(tab.page.screenshot({ encoding: "base64", type: "png", clip }), 8000, "screenshot");
    } finally {
      await this.uiCapture(tab, null);
    }
  }

  async verifyTool(args, T0) {
    const out = [];
    const lines = [];
    const ago = at => {
      const s = Math.max(0, Math.round((Date.now() - at) / 1000));
      return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
    };
    // The target, and the tab it is on.
    let pick = null;
    let specKey = null;
    if (args.pick != null) {
      pick = this.picks.find(x => x.kind === "element" && x.id === Number(args.pick));
      if (!pick) throw new Error(`no pick ${args.pick} (picks so far: ${this.picks.filter(x => x.kind === "element").map(x => x.id).join(", ") || "none"})`);
    } else if (args.ref || args.selector || args.text) specKey = JSON.stringify({ ref: args.ref || null, selector: args.selector || null, text: args.text || null });
    const tab = pick ? pick.tab : this.active;
    if (!tab || !this.tabs.includes(tab) || tab.page.isClosed()) throw new Error(pick ? `the tab of pick ${pick.id} is closed` : "no tab");
    const base = pick ? pick.verifyBase || pick.base || null : specKey ? this.verifyBases.get(specKey) || null : null;

    // Changes since the last check of this target or page, or since the pick,
    // or else since the last tool call that acted on the page.
    const marks = [tab.lastVerify, pick && { at: pick.at || 0, seq: pick.seqAt || 0 }, base && base.verifiedAt && { at: base.verifiedAt, seq: base.seq || 0 }].filter(m => m && m.at);
    const start = marks.length ? marks.reduce((a, b) => (b.at > a.at ? b : a)) : this.lastAct;
    const relevant = () => this.devEvents.filter(e => e.tab === tab && e.at > start.at);
    const timeout = Math.max(0, Math.min(Number(args.timeout ?? 8000), 60000));
    const t0 = Date.now();
    const ready = evs => evs.length && evs[evs.length - 1].kind !== "building";
    let evs = relevant();
    while (!ready(evs) && Date.now() - t0 < timeout) {
      await sleep(100);
      evs = relevant();
    }
    if (evs.length) {
      // Saving several files makes a burst of updates: wait for it to end.
      for (let i = 0; i < 60; i++) {
        const last = relevant().pop();
        if (Date.now() - last.at >= 350 && last.kind !== "building") break;
        await sleep(100);
      }
      evs = relevant();
      // Then for the modules and data it fetches since: requests with no
      // answer yet, and API calls not finished (capped: streams never end).
      const since = evs[0].at - 50;
      const busy = () => {
        for (const [id, at] of tab.pending || []) {
          if (at < since) continue;
          const e = tab.netLive && tab.netLive.get(id);
          if (!e || !e.status || (/^(fetch|xhr|document)$/.test(e.type) && !e.done)) return true;
        }
        return false;
      };
      for (let quiet = 0, i = 0; quiet < 3 && i < 40; i++) {
        quiet = busy() ? 0 : quiet + 1;
        await sleep(100);
      }
    }

    // Find the element again (frames of the side-by-side view may be new after a reload).
    let frame;
    let spec = null;
    if (pick) {
      const t = await this.inspectTarget({ pick: pick.id });
      frame = t.frame;
      spec = base ? { ref: base.ref, selector: base.selector } : t.spec;
    } else {
      const T = tab === this.active && T0 && T0.pane ? await this.toolTarget() : T0;
      frame = T ? T.frame : tab.page.mainFrame();
      if (specKey) spec = base ? { ref: base.ref, selector: base.selector } : { ref: args.ref, selector: args.selector, text: args.text };
    }
    await frame.waitForFunction(() => !!(window.__cb && window.__cb.verifySnap), { timeout: 4000, polling: 100 }).catch(() => {});
    await withTimeout(frame.evaluate(() => window.__cb && window.__cb.domQuiet(250, 2500)), 4000, "dom").catch(() => {});

    const shotMode = args.screenshot || "auto";
    let snap = null;
    let pageInfo;
    if (spec) {
      snap = await withTimeout(frame.evaluate((s, fp, sc) => window.__cb.verifySnap(s, fp, sc), spec, base ? base.fp : null, shotMode !== "none"), 5000, "snapshot");
      pageInfo = snap.page;
    } else {
      pageInfo = await withTimeout(frame.evaluate(() => ({ url: location.href, title: document.title, overlay: window.__cb ? window.__cb.devOverlay() : null })), 4000, "page");
    }

    // 1. What the dev server did.
    const updates = evs.filter(e => e.kind === "update" || e.kind === "reload" || e.kind === "load");
    const errorsBuilt = evs.filter(e => e.kind === "error");
    const lastBuild = [...evs].reverse().find(e => e.kind !== "building" && e.kind !== "load");
    const buildBroken = lastBuild && lastBuild.kind === "error";
    if (evs.length) {
      const files = [...new Set(updates.flatMap(e => e.files || []))];
      const reloaded = evs.some(e => e.kind === "reload" || e.kind === "load");
      const what = buildBroken ? "build failed" : reloaded ? "page reloaded" : "hot update";
      const fl = files.length ? ` — ${files.slice(0, 4).join(", ")}${files.length > 4 ? ` (+${files.length - 4} more)` : ""}` : "";
      lines.push(`Change: ${what} ${ago(evs[evs.length - 1].at)}${fl}`);
    } else {
      lines.push(`Change: no update from the dev server reached the page in ${Math.round((Date.now() - t0) / 1000)}s (since ${ago(start.at)}). The edited file may not be used on this page, the dev server may not be running, or it has no HMR socket. Checked the page as it is.`);
    }
    if (buildBroken) lines.push(`✗ Build error:\n${lastBuild.error.split("\n").map(l => "  " + l).join("\n")}`);
    else if (errorsBuilt.length) lines.push("(a build error came up in between and is fixed now)");
    if (pageInfo.overlay && !(buildBroken && pageInfo.overlay.kind === "Vite")) lines.push(`✗ ${pageInfo.overlay.kind} error overlay on the page:\n${pageInfo.overlay.text.split("\n").slice(0, 12).map(l => "  " + l).join("\n")}`);
    lines.push(`Page: ${String(pageInfo.title || "").slice(0, 70)} — ${pageInfo.url}`);

    // 2. The element.
    const label = pick ? `pick ${pick.id}` : args.ref || args.selector || JSON.stringify(args.text);
    if (snap && !snap.found) lines.push(`✗ Element (${label}): not found any more${base ? ` (was ${base.what})` : ""}. It may have been removed, renamed, or not rendered in this state.`);
    else if (snap) {
      const how = { same: "the same element", selector: "found again by its selector", matched: "found again by its name and place" }[snap.how] || "";
      const state = !snap.visible ? " — ✗ not visible" : snap.offscreen ? " — off screen" : "";
      lines.push(`Element (${label}): ${snap.what}${how && base ? ` — ${how}` : ""}${state}`);
      if (base) {
        const diff = snapDiff(base, snap);
        lines.push(diff.length ? `Changed since ${base.verifiedAt ? "the last check" : "the pick"}:\n${diff.map(d => "  " + d).join("\n")}` : `No change in size, position, text, classes or computed styles since ${base.verifiedAt ? "the last check" : "the pick"}.`);
        if (base.hovered !== snap.hovered) lines.push(`  (the pointer was over it ${base.hovered ? "before" : "now"}: hover styles may explain some of this)`);
      } else lines.push("  (no earlier snapshot of it to compare with: this one is kept for the next browser_verify)");
    }

    // 3. Text that should be there.
    if (args.expect) {
      const found = await frame.evaluate((t, s) => {
        const el = s && window.__cb.findEl(s);
        return (el || document.body).innerText.includes(t);
      }, String(args.expect), snap && snap.found ? { ref: snap.ref } : null).catch(() => false);
      lines.push(`${found ? "✓" : "✗"} Expected text ${JSON.stringify(args.expect)} ${found ? "is" : "is not"} ${snap && snap.found ? "in the element" : "on the page"}.`);
    }

    // 4. Errors since the change.
    const fromSeq = evs.length ? evs[0].seq : start.seq || 0;
    const tabIdx = this.tabs.indexOf(tab);
    const isErr = l => (l.type === "error" || l.type === "pageerror" || l.type === "network") && (l.tab === tabIdx || l.tab === -1);
    const head = l => l.text.split("\n")[0].replace(/[?&]t=\d{10,}/g, "").slice(0, 300);
    const before = new Set(this.logs.filter(l => l.seq <= fromSeq && isErr(l)).map(head));
    const rows = this.logs.filter(l => l.seq > fromSeq && isErr(l));
    if (!rows.length) lines.push("Errors since the change: none (console, exceptions, failed requests).");
    else {
      const seen = new Map();
      for (const l of rows) {
        const h = head(l);
        if (seen.has(h)) seen.get(h).n++;
        else seen.set(h, { l, n: 1 });
      }
      const list = [...seen.values()].slice(-8);
      const fresh = list.filter(x => !before.has(head(x.l))).length;
      lines.push(`${fresh ? "✗" : "!"} Errors since the change: ${seen.size}${fresh < seen.size ? ` (${seen.size - fresh} were there before it too)` : ""}`);
      for (const { l, n } of list) {
        let t = l.text;
        if (l.type !== "network") t = await mapUrlsInText(t).catch(() => t);
        const shown = t.split("\n").slice(0, l.type === "pageerror" ? 3 : 1).join("\n    ").slice(0, 400);
        lines.push(`  [${l.type}]${n > 1 ? ` ×${n}` : ""} ${shown}${before.has(head(l)) ? "  (also before)" : ""}`);
      }
    }

    // 5. Pictures.
    if (snap && snap.found && shotMode !== "none" && shotMode !== "page") {
      const img = await this.verifyShot(tab, frame, this.verifyPaneKey(tab, frame, pick), snap).catch(e => (log("verify shot", e.message), null));
      snap.image = img;
      if (img && base && base.image && base.image === img) lines.push("The element looks pixel-identical to before.");
      out.push({ type: "text", text: lines.join("\n") });
      if (img && base && base.image && base.image !== img) out.push({ type: "text", text: `Before (${base.verifiedAt ? "last check" : "at the pick"}, ${ago(base.verifiedAt || base.at)}):` }, { type: "image", data: base.image, mimeType: "image/png" }, { type: "text", text: "After:" });
      if (img) out.push({ type: "image", data: img, mimeType: "image/png" });
    } else out.push({ type: "text", text: lines.join("\n") });
    if ((shotMode === "page" || (shotMode === "auto" && !spec)) && !args.viewports) {
      const shot = await this.runTool("screenshot", {}).catch(() => []);
      out.push(...shot);
    }
    if (args.viewports) out.push(...(await this.runTool("screenshot", { viewports: true }).catch(e => [{ type: "text", text: `(viewport screenshots failed: ${e.message})` }])));

    // This check is the "before" of the next one.
    const now = { at: Date.now(), seq: this.logSeq };
    tab.lastVerify = now;
    if (snap && snap.found) {
      snap.verifiedAt = now.at;
      snap.seq = now.seq;
      if (pick) pick.verifyBase = snap;
      else if (specKey) {
        this.verifyBases.set(specKey, snap);
        if (this.verifyBases.size > 30) this.verifyBases.delete(this.verifyBases.keys().next().value);
      }
    }
    return out;
  }

  // ---------- browser_inspect: details of a pick, fetched only when needed ----------
  async inspectTarget(args, T) {
    if (args.pick != null) {
      const p = this.picks.find(x => x.kind === "element" && x.id === Number(args.pick));
      if (!p) throw new Error(`no pick ${args.pick} (picks so far: ${this.picks.filter(x => x.kind === "element").map(x => x.id).join(", ") || "none"})`);
      const tab = this.tabs.includes(p.tab) ? p.tab : null;
      if (!tab || tab.page.isClosed()) throw new Error(`the tab of pick ${p.id} is closed`);
      let frame = null;
      if (p.pane) frame = await this.paneFrame(tab, p.pane);
      if (!frame && this.shellTab() === tab) frame = await this.paneFrame(tab, this.primaryKey());
      return { tab, frame: frame || tab.page.mainFrame(), spec: { ref: p.ref, selector: p.selector }, pick: p };
    }
    if (!args.ref && !args.selector && !args.text) throw new Error("Pass pick (the number on a pick card), or ref, selector or text");
    return { tab: this.active, frame: T ? T.frame : this.page.mainFrame(), spec: { ref: args.ref, selector: args.selector, text: args.text }, pick: null };
  }

  async inspectTool(args, T) {
    const aspects = [].concat(args.aspect || "styles");
    const t = await this.inspectTarget(args, T);
    const out = [];
    for (const aspect of aspects) {
      let body;
      try {
        body = await this.inspectAspect(t, aspect, args);
      } catch (e) {
        body = `(failed: ${e.message})`;
      }
      out.push(aspects.length > 1 ? `## ${aspect}\n${body}` : body);
    }
    return out.join("\n\n");
  }

  async inspectAspect(t, aspect, args) {
    const { frame, spec } = t;
    const inPage = async (a, opts = {}) => {
      const r = await frame.evaluate((s, a, o) => (window.__cb && window.__cb.inspect ? window.__cb.inspect(s, a, o) : { error: "page helper not loaded yet" }), spec, a, opts);
      if (r.error) throw new Error(r.error);
      return r.text;
    };
    switch (aspect) {
      case "layout":
      case "html":
        return inPage(aspect, { maxChars: args.maxChars });
      case "animation":
        return inPage("animation", { ms: args.ms, scroll: !!args.scroll });
      case "styles": {
        const base = await inPage("styles");
        const states = await this.stateChanges(t).catch(e => [`(hover/focus not checked: ${e.message})`]);
        return base + (states.length ? "\n" + states.join("\n") : "");
      }
      case "rules":
        return this.cssRules(t, args.maxChars || 4000);
      case "events":
        return this.eventsOf(t);
      case "react": {
        const res = await frame.evaluate(s => (window.__cb && window.__cb.react ? window.__cb.react(s) : { error: "page helper not loaded yet" }), { ...spec, depth: args.depth || 2, maxChars: args.maxChars || 1200 });
        if (res.error) throw new Error(res.error);
        return formatReact(res, {});
      }
      case "source": {
        let chain, target;
        if (t.pick) ({ chain, target } = t.pick);
        else {
          const raw = await frame.evaluate(s => {
            const el = window.__cb && window.__cb.findEl(s);
            return el ? window.__cb.buildReport(el).chain : null;
          }, spec);
          if (!raw) throw new Error("element not found");
          ({ chain, target } = await resolveChain(raw));
        }
        return chainLines(chain, target).join("\n");
      }
      default:
        throw new Error(`unknown aspect "${aspect}" (use ${INSPECT_ASPECTS.join(", ")})`);
    }
  }

  async elementHandle(t) {
    const h = await t.frame.evaluateHandle(s => window.__cb && window.__cb.findEl(s), t.spec);
    const el = h.asElement();
    if (!el) {
      await h.dispose().catch(() => {});
      throw new Error("element not found (it may have been re-rendered; pick it again)");
    }
    return el;
  }

  async nodeIds(cdp, handles) {
    await cdp.send("DOM.getDocument", { depth: 0 });
    const ids = [];
    for (const h of handles) {
      const { nodeId } = await cdp.send("DOM.requestNode", { objectId: h.remoteObject().objectId });
      ids.push(nodeId);
    }
    return ids;
  }

  // What changes on :hover (forced on the element and its ancestors, like a
  // real hover) and on :focus, compared with now.
  async stateChanges(t) {
    const el = await this.elementHandle(t);
    const cdp = sessionOf(el, t);
    const arr = await t.frame.evaluateHandle(e => {
      const a = [];
      for (let n = e; n && n.nodeType === 1; n = n.parentElement) a.push(n);
      return a;
    }, el);
    const handles = [...(await arr.getProperties()).values()].map(h => h.asElement()).filter(Boolean);
    const lines = [];
    await cdp.send("DOM.enable").catch(() => {});
    await cdp.send("CSS.enable");
    try {
      const ids = await this.nodeIds(cdp, handles);
      const focusable = await t.frame.evaluate(e => e.tabIndex >= 0 || e.isContentEditable, el);
      const before = await t.frame.evaluate(e => window.__cb.stateSnapshot(e), el);
      const states = [["hover", ids.map(id => [id, ["hover"]])]];
      if (focusable) states.push(["focus", [[ids[0], ["focus", "focus-visible"]], ...ids.slice(1).map(id => [id, ["focus-within"]])]]);
      for (const [label, forced] of states) {
        for (const [nodeId, cls] of forced) await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: cls });
        const diff = await t.frame.evaluate((e, b) => {
          window.__cb.finishTransitions(e);
          return window.__cb.stateDiff(e, b, window.__cb.stateSnapshot(e));
        }, el, before);
        for (const [nodeId] of forced) await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] }).catch(() => {});
        await t.frame.evaluate(e => window.__cb.finishTransitions(e), el).catch(() => {});
        lines.push(diff.length ? `On :${label}:\n${diff.join("\n")}` : `On :${label}: no visible change`);
      }
    } finally {
      await cdp.send("CSS.disable").catch(() => {});
      await arr.dispose().catch(() => {});
    }
    return lines;
  }

  // The authored CSS rules that apply, winning declarations only, grouped by
  // stylesheet, highest precedence first.
  async cssRules(t, budget) {
    const el = await this.elementHandle(t);
    const cdp = sessionOf(el, t);
    const headers = new Map();
    const onAdd = e => headers.set(e.header.styleSheetId, e.header);
    cdp.on("CSS.styleSheetAdded", onAdd);
    await cdp.send("DOM.enable").catch(() => {});
    await cdp.send("CSS.enable");
    try {
      const [nodeId] = await this.nodeIds(cdp, [el]);
      const m = await cdp.send("CSS.getMatchedStylesForNode", { nodeId });
      const computed = new Map(((await cdp.send("CSS.getComputedStyleForNode", { nodeId }).catch(() => null)) || { computedStyle: [] }).computedStyle.map(p => [p.name, p.value]));
      const sheetName = new Map();
      const nameOf = async id => {
        if (!id) return "inline style";
        if (sheetName.has(id)) return sheetName.get(id);
        const h = headers.get(id) || {};
        let name = h.sourceURL || "";
        if ((!name || h.isInline) && h.ownerNode) {
          const d = await cdp.send("DOM.describeNode", { backendNodeId: h.ownerNode }).catch(() => null);
          const at = (d && d.node.attributes) || [];
          const get = k => {
            const i = at.indexOf(k);
            return i >= 0 ? at[i + 1] : "";
          };
          name = get("data-vite-dev-id") || get("href") || name || `<${(d && d.node.localName) || "style"}> in the page`;
        }
        sheetName.set(id, name || "stylesheet");
        return sheetName.get(id);
      };
      const seen = new Map(); // prop -> important
      const decls = style =>
        (style.cssProperties || []).filter(p => p.range && !p.disabled && p.parsedOk !== false && !p.name.startsWith("--tw-"));
      const keep = p => {
        const imp = !!p.important;
        if (seen.has(p.name) && !(imp && !seen.get(p.name))) return false;
        seen.set(p.name, imp || !!seen.get(p.name));
        return true;
      };
      const show = p => `${p.name}: ${p.value}${/var\(/.test(p.value) && computed.has(p.name) ? ` /* ${computed.get(p.name)} */` : ""}${p.important ? " !important" : ""}`;
      const groups = new Map(); // sheet -> lines
      const add = async (sheetId, line) => {
        const k = await nameOf(sheetId);
        if (!groups.has(k)) groups.set(k, []);
        if (!groups.get(k).includes(line)) groups.get(k).push(line);
      };
      if (m.inlineStyle) {
        const ps = decls(m.inlineStyle).filter(keep);
        if (ps.length) await add(null, `  style="${ps.map(show).join("; ")}"`);
      }
      for (const r of [...(m.matchedCSSRules || [])].reverse()) {
        const rule = r.rule;
        if (rule.origin === "user-agent") continue;
        const ps = decls(rule.style).filter(keep);
        if (!ps.length) continue;
        const sel = (r.matchingSelectors || []).map(i => rule.selectorList.selectors[i] && rule.selectorList.selectors[i].text).filter(Boolean).join(", ") || rule.selectorList.text;
        const h = headers.get(rule.styleSheetId) || {};
        const line = rule.style.range ? `:${(h.startLine || 0) + rule.style.range.startLine + 1}` : "";
        const media = (rule.media || []).map(x => `@${x.source === "mediaRule" ? "media" : x.source} ${x.text}`).join(" ");
        await add(rule.styleSheetId, `  ${sel}${media ? `  ${media}` : ""}${line ? `  (line ${line.slice(1)})` : ""} { ${ps.map(show).join("; ")} }`);
      }
      for (const pe of m.pseudoElements || []) {
        if (!/^(before|after|placeholder|marker|selection)$/.test(pe.pseudoType)) continue;
        for (const r of [...pe.matches].reverse()) {
          if (r.rule.origin === "user-agent") continue;
          const ps = decls(r.rule.style);
          if (ps.length) await add(r.rule.styleSheetId, `  ${r.rule.selectorList.text} { ${ps.map(show).join("; ")} }`);
        }
      }
      if (!groups.size) return "No authored CSS rules match it (only browser defaults and inherited styles).";
      let outText = "Winning declarations only, highest precedence first (rules for :hover/:focus show up in aspect styles):";
      for (const [k, ls] of groups) outText += `\n${k}\n${ls.join("\n")}`;
      return outText.length > budget ? outText.slice(0, budget) + `\n… (cut at ${budget} chars; pass maxChars for more)` : outText;
    } finally {
      cdp.off("CSS.styleSheetAdded", onAdd);
      await cdp.send("CSS.disable").catch(() => {});
    }
  }

  // Listeners on the element, its ancestors, document and window, with their
  // code location mapped to source when the page has source maps.
  async eventsOf(t) {
    const el = await this.elementHandle(t);
    const cdp = sessionOf(el, t);
    const chainH = await t.frame.evaluateHandle(e => {
      const a = [];
      for (let n = e; n && n.nodeType === 1; n = n.parentElement) a.push(n);
      a.push(document, window);
      return a;
    }, el);
    const nodes = [...(await chainH.getProperties()).values()];
    const labels = await t.frame.evaluate(arr => arr.map(n => (n === window ? "window" : n === document ? "document" : n.localName + (n.id ? "#" + n.id : ""))), chainH);
    const urls = new Map();
    const onScript = e => urls.set(e.scriptId, e.url);
    const where = async (scriptId, line, col) => {
      const url = urls.get(scriptId);
      if (!url) return "";
      const mapped = await resolveLocation(url, line + 1, col + 1).catch(() => null);
      return mapped || `${url.length > 90 ? "…" + url.slice(-90) : url}:${line + 1}:${col + 1}`;
    };
    cdp.on("Debugger.scriptParsed", onScript);
    let debuggerOn = false;
    const lines = [];
    try {
      await cdp.send("Debugger.enable");
      debuggerOn = true;
      await cdp.send("Debugger.setSkipAllPauses", { skip: true }).catch(() => {});
      const code = l => (l.handler && l.handler.description ? l.handler.description.replace(/\s+/g, " ").slice(0, 120) : "");
      const FRAMEWORK = /react-dom|scheduler|preact|@vue\/runtime|vue\.runtime|svelte\/internal|zone\.js|@angular\/core/;
      const LIBRARY = /node_modules|^\.\.\/|^https?:/;
      for (let i = 0; i < nodes.length; i++) {
        const { listeners } = await cdp.send("DOMDebugger.getEventListeners", { objectId: nodes[i].remoteObject().objectId, depth: 0 }).catch(() => ({ listeners: [] }));
        if (!listeners.length) continue;
        const name = i === 0 ? "the element" : labels[i];
        const isEdge = labels[i] === "window" || labels[i] === "document";
        let framework = 0;
        let library = 0;
        const shown = [];
        for (const l of listeners) {
          if (!urls.get(l.scriptId)) continue; // injected scripts (this tool, extensions)
          const loc = await where(l.scriptId, l.lineNumber, l.columnNumber);
          if (FRAMEWORK.test(loc)) {
            framework++;
            continue;
          }
          if (isEdge && !/^(scroll|wheel|resize|mousemove|pointermove|touchmove|keydown|visibilitychange|intersection)$/.test(l.type)) continue;
          if (i > 0 && LIBRARY.test(loc) && !(isEdge && /^(scroll|wheel|resize)$/.test(l.type))) {
            library++;
            continue;
          }
          const line = `${name}: ${l.type}${l.useCapture ? " (capture)" : ""}${l.passive ? " passive" : ""}  ${loc}  ${code(l)}`;
          const same = shown.find(x => x.line === line);
          if (same) same.n++;
          else if (shown.length < 8) shown.push({ line, n: 1 });
        }
        if (framework) lines.push(`${name}: ${framework} framework listener${framework === 1 ? "" : "s"} (delegated event handling)`);
        lines.push(...shown.map(x => (x.n > 1 ? `${x.line} (×${x.n})` : x.line)));
        if (library) lines.push(`${name}: +${library} more from libraries`);
      }
      // React: handlers are props, not DOM listeners.
      const rh = await t.frame.evaluateHandle(e => window.__cb.reactHandlers(e), el);
      const items = [...(await rh.getProperties()).values()];
      for (const it of items) {
        const info = await it.evaluate(o => ({ owner: o.owner, prop: o.prop, code: o.code }));
        const fn = await it.getProperty("fn");
        let loc = "";
        try {
          const props = await cdp.send("Runtime.getProperties", { objectId: fn.remoteObject().objectId, ownProperties: true });
          const fl = (props.internalProperties || []).find(p => p.name === "[[FunctionLocation]]");
          if (fl) loc = await where(fl.value.value.scriptId, fl.value.value.lineNumber, fl.value.value.columnNumber);
        } catch {}
        lines.push(`${info.owner}: React ${info.prop}  ${loc}  ${info.code}`);
      }
      await rh.dispose().catch(() => {});
    } finally {
      cdp.off("Debugger.scriptParsed", onScript);
      if (debuggerOn) await cdp.send("Debugger.disable").catch(() => {});
      await chainH.dispose().catch(() => {});
    }
    return lines.length ? lines.join("\n") : "No event listeners on it, its ancestors, document or window (it may be pure CSS, or handled through a framework's root listener).";
  }

  // What the toolbar says after something was handed to Claude.
  sentText(what) {
    return this.bridgeConnected() ? `${what} sent to the Claude prompt.` : `${what} saved — the editor isn't connected; ask Claude to read it (browser_picked).`;
  }

  // Side-by-side: each pane logs the same errors; keep one of each.
  paneEcho(tab, key) {
    if (!WINDOW_MODE || this.shellTab() !== tab) return false;
    const now = Date.now();
    const seen = (tab.paneLog = tab.paneLog || new Map());
    const at = seen.get(key);
    seen.set(key, now);
    if (seen.size > 300) for (const [k, t] of seen) if (now - t > 5000) seen.delete(k);
    return !!at && now - at < 4000;
  }

  setPickWindow(tab, on) {
    if (!tab) return;
    tab.picking = !!on;
    // In the side-by-side view the panes pick, not the page around them.
    const skip = this.shellTab() === tab ? tab.page.mainFrame() : null;
    for (const f of tab.page.frames()) if (f !== skip) f.evaluate(v => window.__cb && window.__cb.isPicking() !== v && window.__cb.setPick(v), !!on).catch(() => {});
    this.pushUiSoon();
  }

  async toggleDevtools(tab, forceOpen) {
    if (!this.browserCdp || !tab || !tab.id) return;
    const alive = await this.devtoolsAlive(tab);
    if (alive && !forceOpen) {
      await this.browserCdp.send("Target.closeTarget", { targetId: tab.devtoolsId }).catch(() => {});
      tab.devtoolsId = null;
    } else if (!alive && CURSOR_MODE) {
      // Cursor's Chromium has no Target.openDevTools; its own toolbar has a DevTools button.
      this.toast("Use the DevTools button in Cursor's browser toolbar");
    } else if (!alive) {
      try {
        const r = await this.browserCdp.send("Target.openDevTools", { targetId: tab.id });
        tab.devtoolsId = r.targetId;
      } catch (e) {
        log("open devtools", e.message);
        this.toast(`Press ${process.platform === "darwin" ? "⌥⌘I" : "F12"} for DevTools`);
      }
    }
    this.pushUi(tab);
  }

  async devtoolsAlive(tab) {
    if (!tab.devtoolsId || !this.browserCdp) return false;
    const { targetInfos } = await this.browserCdp.send("Target.getTargets").catch(() => ({ targetInfos: [] }));
    if (targetInfos.some(t => t.targetId === tab.devtoolsId)) return true;
    tab.devtoolsId = null;
    return false;
  }

  // macOS: an image file onto the clipboard.
  copyImage(file) {
    if (process.platform !== "darwin" || !file) return false;
    try {
      execFileSync("/usr/bin/osascript", ["-e", `set the clipboard to (read (POSIX file ${JSON.stringify(file)}) as «class PNGf»)`], { timeout: 5000, stdio: "ignore" });
      return true;
    } catch (e) {
      log("copy image", e.message.split("\n")[0]);
      return false;
    }
  }

  async capture(tab, clip, uiMode) {
    await this.uiCapture(tab, uiMode);
    try {
      const { data } = await withTimeout(tab.cdp.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip, captureBeyondViewport: false } : {}) }), 8000, "screenshot");
      return data;
    } finally {
      await this.uiCapture(tab, null);
    }
  }

  // The toolbar's screenshot button: the page, or every pane of the view.
  async windowScreenshot(tab) {
    let clip = null;
    if (this.shellTab() === tab) {
      const r = await tab.page.mainFrame().evaluate(() => ({ top: window.__cbShell ? window.__cbShell.stageTop() : 40, w: innerWidth, h: innerHeight })).catch(() => null);
      if (r) clip = { x: 0, y: r.top, width: r.w, height: r.h - r.top, scale: 1 };
    }
    const data = await this.capture(tab, clip, "all");
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = path.join(SHOTS_DIR, `screenshot-${stamp}.png`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    return { path: file, copied: this.copyImage(file) };
  }

  // Marks drawn with the toolbar (tab CSS px): the picture with the marks,
  // and what is under each mark, become a report for Claude.
  async annotateWindow(tab, msg) {
    const drawn = (Array.isArray(msg.marks) ? msg.marks : []).slice(0, 12);
    if (!drawn.length) return { text: "Nothing marked" };
    let frame = tab.page.mainFrame();
    let clip = null;
    let marks = drawn;
    let vp;
    let label = "";
    if (msg.pane && this.shellTab() === tab) {
      const [r, f] = await Promise.all([this.paneRect(tab, msg.pane), this.paneFrame(tab, msg.pane)]);
      if (!r || !f) return { text: "That pane is gone" };
      frame = f;
      const s = r.s || 1;
      const X = x => (x - r.x) / s;
      const Y = y => (y - r.y) / s;
      marks = drawn.map(m => (m.kind === "arrow" ? { kind: "arrow", x1: X(m.x1), y1: Y(m.y1), x2: X(m.x2), y2: Y(m.y2) } : { kind: "rect", x: X(m.x), y: Y(m.y), w: m.w / s, h: m.h / s }));
      clip = { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 / s };
      vp = { width: r.cssWidth, height: r.cssHeight };
      label = this.device(msg.pane).label;
    } else {
      const v = await frame.evaluate(() => ({ w: innerWidth, h: innerHeight })).catch(() => ({ w: 0, h: 0 }));
      vp = { width: v.w, height: v.h };
    }
    const image = await this.capture(tab, clip, "marks");
    // The drawing layer covers the page: out of the way while looking under it.
    await this.uiCapture(tab, "all");
    const found = await frame.evaluate(ms => (window.__cb && window.__cb.describeMarks ? window.__cb.describeMarks(ms) : []), marks).catch(() => []);
    await this.uiCapture(tab, null);
    const url = await frame.evaluate(() => location.href).catch(() => tab.page.url());
    const file = await this.reportAnnotation({ marks, found, image, url, vp, label, note: msg.note }, this.bridgeTarget());
    const copied = this.copyImage(file);
    return { text: this.sentText("Marked screenshot") + (copied ? " The picture is on the clipboard too (⌘V)." : "") };
  }

  async setScheme(value) {
    this.colorScheme = value === "light" || value === "dark" ? value : "";
    await Promise.all(this.tabs.map(t => t.cdp && t.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: this.colorScheme }] }).catch(() => {})));
    this.broadcast({ t: "viewportState", effective: this.effective, override: this.override, zoom: this.zoom, colorScheme: this.colorScheme });
    this.pushUi();
  }

  // Requests from the toolbar (ui.js) and the side-by-side page (shell.html).
  // The returned JSON is what the page's __cbEmit call resolves to.
  async onUi(tab, msg) {
    const J = v => JSON.stringify(v === undefined ? null : v);
    switch (msg.a) {
      case "state":
        return J(this.uiState(tab));
      case "pick":
        this.pickRequester = this.bridgeTarget();
        this.setPickWindow(tab, !!msg.on);
        return J(true);
      case "multi":
        if (tab !== this.active) await this.activate(tab);
        await this.setMulti(msg.on ? this.lastMultiKeys || DEVICE_ORDER : null).catch(e => this.toast(e.message));
        return J(true);
      case "multiKeys":
        if (tab !== this.active) await this.activate(tab);
        await this.setMulti(Array.isArray(msg.keys) ? msg.keys : null).catch(e => this.toast(e.message));
        return J(true);
      case "multiScale":
        this.multiScaleMode = ["fit", "0.5", "0.75", "1"].includes(String(msg.value)) ? String(msg.value) : "fit";
        this.saveSession();
        return J(true);
      case "multiSize":
        await this.setMultiSize(msg.key, msg.width && msg.height ? { width: msg.width, height: msg.height, name: msg.name } : null).catch(e => this.toast(e.message));
        return J(true);
      case "print":
        return J({ print: await this.sessionPrint(tab, msg.url) });
      case "inflight":
        return J({ n: this.inflight(tab) });
      case "touch":
        // Touch emulation in the phone and tablet panes (they reload to apply it).
        this.touchPanes = !!msg.on;
        this.saveSession();
        return J({ on: this.touchPanes });
      case "errors":
        return J(await this.errorSummary(tab));
      case "sendErrors": {
        const n = await this.sendErrors(Array.isArray(msg.ids) ? msg.ids : null, this.bridgeTarget());
        return J({ text: n ? this.sentText(n === 1 ? "Error" : `${n} errors`) : "" });
      }
      case "devtools":
        await this.toggleDevtools(tab, !!msg.open);
        return J(true);
      case "screenshot":
        return J(await this.windowScreenshot(tab).catch(e => ({ error: `Screenshot failed: ${e.message.split("\n")[0]}` })));
      case "annotate":
        return J(await this.annotateWindow(tab, msg).catch(e => ({ text: `Could not take the screenshot: ${e.message.split("\n")[0]}` })));
      case "hardReload":
        await this.reloadTab(tab, true);
        return J(true);
      case "phone":
        return J(await this.phoneLink(tab).catch(e => ({ error: e.message.split("\n")[0] })));
      case "copyText":
        try {
          execFileSync("/usr/bin/pbcopy", { input: String(msg.text || ""), timeout: 3000 });
          return J(true);
        } catch {
          return J(false);
        }
      case "copyUrl": {
        let url = tab.failedUrl || tab.page.url();
        if (this.shellTab() === tab) url = await tab.page.mainFrame().evaluate(() => window.__cbShell.leaderUrl()).catch(() => url);
        try {
          execFileSync("/usr/bin/pbcopy", { input: url, timeout: 3000 });
          return J(true);
        } catch {
          return J(false);
        }
      }
      case "clearSite":
        await this.viewerAction({ ws: { readyState: 0 } }, { name: "clearSite" });
        return J(true);
      case "restart":
        setTimeout(() => this.restart().catch(e => log("restart", e.message)), 50);
        return J(true);
      case "scheme":
        await this.setScheme(msg.value);
        return J(true);
      case "sweep":
        await this.sweepCmd(tab, msg);
        return J(true);
      case "device": {
        if (tab.sweep) await this.stopSweep(tab);
        const m = /^(\d+)x(\d+)(m?)$/.exec(String(msg.value || ""));
        if (this.multi) await this.setMulti(null);
        this.override = m ? { width: +m[1], height: +m[2], mobile: !!m[3] } : null;
        if (this.active) this.active.viewportKey = null;
        await this.applyViewport();
        this.pushUi();
        return J(true);
      }
      case "prefs": {
        const p = msg.prefs || {};
        const pos = p.pos && Number.isFinite(p.pos.fx) && Number.isFinite(p.pos.fy) ? { fx: Math.min(1, Math.max(0, p.pos.fx)), fy: Math.min(1, Math.max(0, p.pos.fy)) } : this.uiPrefs.pos;
        this.uiPrefs = { ...this.uiPrefs, pos, collapsed: !!p.collapsed };
        this.saveSession();
        for (const t of this.tabs) if (t !== tab) this.pushUi(t);
        return J(true);
      }
    }
    return J(null);
  }

  // ---------- width sweep: the page narrows from the window's width to 375 px ----------
  sweepSpeed() {
    const v = Number(this.uiPrefs.sweepSpeed);
    return SWEEP_SPEEDS.includes(v) ? v : 1;
  }

  async sweepCmd(tab, msg) {
    const s = tab.sweep;
    switch (msg.cmd) {
      case "start":
      case "replay":
        this.startSweep(tab).catch(e => log("sweep", e.message));
        return;
      case "pause":
        if (s) s.paused = true;
        break;
      case "resume":
        if (s && s.done) return void this.startSweep(tab).catch(e => log("sweep", e.message));
        if (s) s.paused = false;
        break;
      case "stop":
        await this.stopSweep(tab);
        return;
      case "speed": {
        const v = Number(msg.speed);
        if (!SWEEP_SPEEDS.includes(v)) return;
        this.uiPrefs = { ...this.uiPrefs, sweepSpeed: v };
        this.saveSession();
        for (const t of this.tabs) this.pushUi(t);
        return;
      }
    }
    this.pushUi(tab);
  }

  async startSweep(tab) {
    if (this.multi || this.shellTab() === tab) return this.uiToast("Turn side by side off to sweep the size", tab);
    let s = tab.sweep;
    if (!s) {
      // Measure the window itself: no device size, no emulation.
      const restore = this.override;
      if (restore) {
        this.override = null;
        tab.viewportKey = null;
        await this.applyViewport();
      }
      await tab.cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
      await sleep(60);
      const m = await withTimeout(tab.page.evaluate(() => ({ w: innerWidth, h: innerHeight })), 3000, "measure");
      s = { from: m.w, h: m.h, restore, run: 0 };
      tab.sweep = s;
      tab.viewportKey = "sweep";
    }
    const run = ++s.run;
    // The path: the window's own size, then every device narrower than it.
    const pts = sweepPath(s.from, s.h);
    Object.assign(s, { seg: 0, t: 0, sent: "", paused: false, done: false, label: "", dwellUntil: 0 });
    this.pushUi(tab);
    let last = Date.now();
    while (tab.sweep === s && s.run === run) {
      const now = Date.now();
      const dt = now - last;
      last = now;
      if (!s.paused && now >= s.dwellUntil && s.seg < pts.length - 1) {
        if (s.label) {
          s.label = "";
          this.pushUi(tab);
        }
        const a = pts[s.seg];
        const b = pts[s.seg + 1];
        const len = Math.hypot(a.w - b.w, a.h - b.h) || 1;
        s.t += (SWEEP_BASE * this.sweepSpeed() * dt) / 1000 / len;
        if (s.t >= 1) {
          // Hold on each device for a moment, with its name in the strip.
          s.seg++;
          s.t = 0;
          s.label = b.label;
          s.dwellUntil = now + Math.min(600, SWEEP_DWELL / this.sweepSpeed());
          this.pushUi(tab);
        }
      }
      const a = pts[s.seg];
      const b = pts[Math.min(s.seg + 1, pts.length - 1)];
      const w = Math.round(a.w + (b.w - a.w) * s.t);
      const h = Math.round(a.h + (b.h - a.h) * s.t);
      if (`${w}x${h}` !== s.sent) {
        s.sent = `${w}x${h}`;
        // At its real size (never scaled): what doesn't fit the window runs off its bottom.
        await withTimeout(tab.cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 0, mobile: false, screenWidth: w, screenHeight: h }), 2000, "sweep").catch(() => {});
      }
      if (s.seg >= pts.length - 1) {
        s.done = true;
        this.pushUi(tab);
        return;
      }
      await sleep(Math.max(4, 16 - (Date.now() - now)));
    }
  }

  // Back to the window's own size (or the device size chosen before).
  async stopSweep(tab) {
    const s = tab.sweep;
    if (!s) return;
    tab.sweep = null;
    tab.viewportKey = null;
    if (tab === this.active) {
      this.override = s.restore || null;
      await this.applyViewport();
    } else await tab.cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    this.pushUi(tab);
  }

  // ---------- open on my phone: the page's address on the LAN, as a QR code ----------
  lanAddress() {
    const found = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      if (/^(utun|bridge|vmnet|vboxnet|docker|awdl|llw|lo)/.test(name)) continue;
      for (const a of list || []) {
        if (a.family !== "IPv4" && a.family !== 4) continue;
        if (a.internal || a.address.startsWith("169.254.")) continue;
        const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address);
        found.push({ address: a.address, score: (priv ? 2 : 0) + (/^en0$/.test(name) ? 1 : 0) });
      }
    }
    found.sort((a, b) => b.score - a.score);
    return found.length ? found[0].address : null;
  }

  async phoneLink(tab) {
    let url = tab.failedUrl || tab.page.url();
    if (this.shellTab() === tab) url = await tab.page.mainFrame().evaluate(() => window.__cbShell.leaderUrl()).catch(() => url);
    let u;
    try {
      u = new URL(url);
    } catch {
      return { error: "This page has no address a phone can open" };
    }
    if (!/^https?:$/.test(u.protocol)) return { error: "This page has no address a phone can open" };
    let warn = "";
    const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/.test(u.hostname) || u.hostname.endsWith(".localhost");
    if (local) {
      const ip = this.lanAddress();
      if (!ip) return { error: "This Mac isn't on a network (no LAN address found)" };
      u.hostname = ip;
      // A dev server listening on localhost only can't be reached from the phone.
      const reach = await new Promise(resolve => {
        const lib = u.protocol === "https:" ? require("https") : http;
        const req = lib.request({ host: ip, port: u.port || (u.protocol === "https:" ? 443 : 80), path: "/", method: "HEAD", timeout: 1500, rejectUnauthorized: false }, res => {
          res.resume();
          resolve(true);
        });
        req.on("timeout", () => (req.destroy(), resolve(false)));
        req.on("error", () => resolve(false));
        req.end();
      });
      if (!reach) warn = "The dev server only listens on localhost, so the phone can't reach it. Start it with --host (Vite: vite --host · Next.js: next dev -H 0.0.0.0 · CRA: HOST=0.0.0.0).";
    }
    const link = u.toString();
    return { url: link, svg: qrSvg(link, 4, 4), warn, lan: local };
  }

  async toggleMulti() {
    await this.setMulti(this.multi ? null : this.lastMultiKeys || DEVICE_ORDER);
  }

  // Scroll reporting is only switched on in pages that take part in the view.
  setSync() {
    const on = !!this.multi;
    for (const t of this.shownTabs()) t.page.evaluate(v => window.__cb && window.__cb.setSync && window.__cb.setSync(v), on).catch(() => {});
  }

  // A short fingerprint of what a page's login state hangs on: its cookies and
  // the auth-looking entries of localStorage. Panes share both, but each keeps
  // its own copy of the app's state in memory.
  async sessionPrint(tab, forUrl) {
    const url = forUrl || tab.failedUrl || tab.page.url();
    const cookies = withTimeout(tab.cdp.send("Network.getCookies", { urls: [url] }), 1500, "cookies").then(
      // Bare numbers are expiry times and counters, which move on their own.
      r => r.cookies.filter(c => !/^\d*$/.test(c.value)).map(c => `${c.name}=${c.value}`).sort().join(";"),
      () => ""
    );
    const stored = withTimeout(
      tab.page.evaluate(() => {
        const out = [];
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!/token|auth|session|jwt|login|user|account|credential/i.test(k)) continue;
            const v = localStorage.getItem(k) || "";
            // Expiry times and "last seen" stamps change without anyone signing in or out.
            if (/^\d*$/.test(v) || /expir|(^|[_-])(at|time|ts)$|last|stamp/i.test(k)) continue;
            out.push(k + "=" + v);
          }
        } catch {}
        return out.sort().join(";");
      }),
      1500,
      "storage"
    ).catch(() => "");
    const [c, l] = await Promise.all([cookies, stored]);
    if (process.env.CB_DEBUG_SYNC) log("print", this.paneIndex(tab), c.replace(/=([^;]{0,10})[^;]*/g, "=$1…"), "|", l.replace(/=([^;]{0,24})[^;]*/g, "=$1…"));
    return crypto.createHash("sha1").update(c + "\n" + l).digest("hex");
  }

  // Panes load one after another. Copies of one site starting at the very same
  // moment trip over each other while they set up shared storage (an app that
  // probes IndexedDB with a fixed key sees another copy delete its probe).
  loadInTurn(tab, start) {
    const run = async () => {
      if (!tab.page || tab.page.isClosed() || !(this.isShown(tab) || this.tabs.includes(tab))) return;
      const loaded = new Promise(r => tab.page.once("load", r));
      if ((await start()) === false) return;
      await Promise.race([loaded, sleep(8000)]);
      await sleep(350); // the app's own start-up, right after load
    };
    this.loadTurn = (this.loadTurn || Promise.resolve()).then(run, run);
    return this.loadTurn;
  }

  // Reload is for the whole side-by-side view, not just the shared tab (which
  // the caller reloads right after this and which therefore goes first).
  reloadMirrors(ignoreCache) {
    if (!this.multi) return;
    if (this.active) this.loadInTurn(this.active, () => {});
    for (const m of this.mirrors) {
      m.syncUntil = Date.now() + 30000;
      this.loadInTurn(m, () => m.cdp.send("Page.reload", { ignoreCache: !!ignoreCache }).catch(() => {})).then(() => (m.syncUntil = Date.now() + 2500));
    }
  }

  // One pane went somewhere: take the others there too.
  onPaneNav(src, url, within) {
    if (WINDOW_MODE) return; // the side-by-side page keeps its panes in step itself
    if (!this.multi || !this.isShown(src) || !/^(https?|file):/i.test(url || "")) return;
    // A pane that is itself following must not lead (redirects would ping-pong).
    if (src.syncUntil && Date.now() < src.syncUntil) return;
    if (src !== this.active && src !== this.lastInputTab) return;
    const seq = (this.navSyncSeq = (this.navSyncSeq || 0) + 1);
    this.followNav(src, url, within, seq).catch(e => log("pane sync", e.message));
  }

  async followNav(src, url, within, seq) {
    // Signing in or out (or switching account) in one pane changes the session
    // every pane shares, while the others still hold the old state in memory.
    // Changing only their route would run the app against that stale state:
    // at best a wrong page, at worst the app "cleans up" and ends the session
    // for all of them. Such panes get a real page load instead.
    const print = within ? await this.sessionPrint(src) : null;
    if (seq !== this.navSyncSeq || !this.multi) return; // a newer navigation took over
    if (print) src.sessionPrint = print;
    for (const t of this.shownTabs()) {
      if (t === src) continue;
      const cur = t.failedUrl || t.page.url();
      const stale = !!print && t.sessionPrint !== print;
      if (cur === url && !stale) continue;
      t.syncUntil = Date.now() + 2500;
      let sameOrigin = false;
      try {
        sameOrigin = new URL(cur).origin === new URL(url).origin;
      } catch {}
      const go = () => {
        t.syncUntil = Date.now() + 30000;
        if (print) t.sessionPrint = print;
        return this.loadInTurn(t, () => {
          if (seq !== this.navSyncSeq) return false; // the view has moved on since
          return t.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
        }).then(() => {
          // Still following while the fresh page settles (its own redirects).
          t.syncUntil = Date.now() + 2500;
        });
      };
      if (within && sameOrigin && !stale) {
        // A client-side route change: do the same in place instead of reloading.
        t.page
          .evaluate(u => {
            history.pushState(null, "", u);
            dispatchEvent(new PopStateEvent("popstate", { state: null }));
          }, url)
          .then(() => sleep(500))
          .then(() => {
            if (seq === this.navSyncSeq && this.isShown(t) && (src.failedUrl || src.page.url()) === url && t.page.url() !== url) go();
          })
          .catch(go);
      } else go();
    }
  }

  onPaneScroll(src, msg) {
    if (WINDOW_MODE) return;
    if (!this.multi || src !== (this.lastInputTab || this.active)) return;
    if (src.syncUntil && Date.now() < src.syncUntil) return;
    for (const t of this.shownTabs()) {
      if (t !== src) t.page.evaluate((sel, fx, fy) => window.__cb && window.__cb.syncScroll && window.__cb.syncScroll(sel, fx, fy), msg.sel || "", msg.fx || 0, msg.fy || 0).catch(() => {});
    }
  }

  // ---------- viewport & screencast ----------
  // width/height: the size the viewer shows (panel or device). The page lays
  // out at width/zoom and is rendered at dpr*zoom, which is what browser zoom is.
  // The next browser start renders at this panel's scale. A change takes
  // effect at the next start (⋯ › Restart browser), not mid-session.
  rememberDisplay(dpr) {
    const v = Math.min(3, Math.max(1, Math.round(Number(dpr) || 1)));
    if (v === this.savedDisplayScale) return;
    this.savedDisplayScale = v;
    try {
      const old = JSON.parse(fs.readFileSync(DISPLAY_FILE, "utf8"));
      if (Math.round(Number(old.dpr)) === v) return;
    } catch {}
    try {
      fs.writeFileSync(DISPLAY_FILE, JSON.stringify({ dpr: v }));
      if (v !== RENDER_SCALE) log("panel scale", v, "differs from browser scale", RENDER_SCALE, "- used from the next browser start");
    } catch {}
  }

  computeEffective() {
    const panel = this.activeClient && this.clients.get(this.activeClient);
    const pv = panel && panel.viewport;
    const panelDpr = (pv && pv.dpr) || DEFAULT_VIEWPORT.dpr;
    const dpr = this.multi ? Math.min(3, Math.max(0.1, panelDpr * Math.min(1, this.multiViewScale || 1))) : Math.min(3, Math.max(RENDER_SCALE, panelDpr));
    const zoom = this.zoom || 1;
    if (this.override) return { width: this.override.width, height: this.override.height, dpr, mobile: !!this.override.mobile, zoom };
    if (pv && pv.width > 50 && pv.height > 50) return { width: Math.round(pv.width), height: Math.round(pv.height), dpr, mobile: false, zoom };
    return { ...DEFAULT_VIEWPORT, mobile: false, zoom };
  }

  // CSS size a tab's frames cover, as frame metadata.
  paneCssSize(tab) {
    if (tab.mirror) return { deviceWidth: tab.mirror.width, deviceHeight: tab.mirror.height };
    const css = this.cssSize();
    return { deviceWidth: css.width, deviceHeight: css.height };
  }

  async setMultiViewScale(scale) {
    const v = Math.min(1, Math.max(0.1, Math.round((Number(scale) || 1) * 1000) / 1000));
    if (v === this.multiViewScale) return;
    this.multiViewScale = v;
    if (!this.multi) return;
    await this.applyViewport();
    for (const m of this.mirrors) await this.applyMirrorViewport(m);
  }

  // Layout size of the page in CSS px.
  cssSize(eff = this.effective) {
    const z = eff.zoom || 1;
    return { width: Math.max(1, Math.round(eff.width / z)), height: Math.max(1, Math.round(eff.height / z)) };
  }

  // Window mode: the window's own size is the viewport (unless a device size
  // is chosen). Measure it so screenshots and tools know it.
  async measureWindow(tab = this.active) {
    if (!tab) return;
    const m = await withTimeout(tab.page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })), 3000, "measure").catch(() => null);
    if (m) this.effective = { width: m.w, height: m.h, dpr: m.dpr || 1, mobile: false, zoom: 1 };
  }

  async applyViewport() {
    if (WINDOW_MODE && this.active && this.active.sweep) return; // the sweep owns the viewport
    if (WINDOW_MODE && !this.override) {
      const tab = this.active;
      if (!tab || !tab.cdp) return;
      if (tab.viewportKey !== "window") {
        tab.viewportKey = "window";
        await tab.cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
        if (tab.mobile) {
          tab.mobile = false;
          await tab.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
          if (!/^(about:|chrome)/.test(tab.page.url())) this.reloadTab(tab);
        }
      }
      await this.measureWindow(tab);
      this.broadcast({ t: "viewportState", effective: this.effective, override: null, zoom: 1, colorScheme: this.colorScheme });
      return;
    }
    const eff = this.computeEffective();
    this.effective = eff;
    this.broadcast({ t: "viewportState", effective: eff, override: this.override, zoom: this.zoom, colorScheme: this.colorScheme });
    const tab = this.active;
    if (!tab || !tab.cdp) return;
    // Each tab keeps its own emulation, so apply whenever this tab is stale.
    const key = JSON.stringify(eff);
    if (tab.viewportKey === key) return;
    tab.viewportKey = key;
    // A drag sends sizes faster than Chrome applies them: only the newest one
    // matters, so never queue more than one behind the call in flight.
    tab.vpWanted = eff;
    if (tab.vpBusy) return;
    tab.vpBusy = true;
    try {
      while (tab.vpWanted) {
        const e = tab.vpWanted;
        tab.vpWanted = null;
        const css = this.cssSize(e);
        try {
          await withTimeout(
            tab.cdp.send("Emulation.setDeviceMetricsOverride", {
              width: css.width,
              height: css.height,
              deviceScaleFactor: WINDOW_MODE ? 0 : e.dpr * (e.zoom || 1),
              mobile: !!e.mobile,
              screenWidth: css.width,
              screenHeight: css.height,
            }),
            8000,
            "resize"
          );
          if (!!e.mobile !== tab.mobile) {
            // Mobile layout (meta viewport, overlay scrollbars) needs a fresh load.
            tab.mobile = !!e.mobile;
            await tab.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: tab.mobile }).catch(() => {});
            if (!/^(about:|chrome)/.test(tab.page.url())) this.reloadTab(tab);
          }
        } catch (err) {
          tab.viewportKey = null;
          log("setViewport", err.message);
        }
      }
    } finally {
      tab.vpBusy = false;
    }
  }

  frameFits(md) {
    const eff = this.effective;
    if (!eff || !md || !md.deviceWidth) return true;
    const css = this.cssSize(eff);
    return Math.abs(md.deviceWidth - css.width) <= 2 && Math.abs(md.deviceHeight - css.height) <= 2;
  }

  // Frames that keep coming at the wrong size (emulation lost or never applied
  // to this tab): re-apply the viewport. Short mismatches during a live resize
  // are normal, so wait before acting.
  checkFrameSize(tab, md) {
    if (this.multi) return;
    if (this.frameFits(md)) {
      clearTimeout(tab.sizeHealTimer);
      tab.sizeHealTimer = null;
      return;
    }
    if (tab.sizeHealTimer) return;
    tab.sizeHealTimer = setTimeout(async () => {
      tab.sizeHealTimer = null;
      if (tab !== this.active || !tab.lastFrame || this.frameFits(tab.lastFrame.metadata)) return;
      const m = tab.lastFrame.metadata;
      const css = this.cssSize();
      log("viewport heal: frame", `${m.deviceWidth}x${m.deviceHeight}`, "expected", `${css.width}x${css.height}`);
      tab.viewportKey = null;
      await this.applyViewport();
      this.kickFrame(tab);
    }, 700);
  }

  // Make the compositor produce a fresh frame even on a static page.
  kickFrame(tab) {
    if (WINDOW_MODE) return; // nothing is streamed
    tab.page
      .evaluate(() => {
        const d = document.createElement("div");
        d.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:2147483647";
        (document.body || document.documentElement).appendChild(d);
        requestAnimationFrame(() => requestAnimationFrame(() => d.remove()));
      })
      .catch(() => {});
  }

  // Viewer frame: 16-byte header + image.
  //   u32 seq | u16 flags (1 = still, 2 = png) | u16 pane | f32 width | f32 height
  // width/height are the CSS size the image covers, so the viewer maps the
  // pointer onto the page from the frame itself, whatever size it is showing.
  packFrame(seq, md, image, flags, pane = 0) {
    const head = Buffer.alloc(16);
    head.writeUInt32LE(seq >>> 0, 0);
    head.writeUInt16LE(flags, 4);
    head.writeUInt16LE(pane, 6);
    head.writeFloatLE((md && md.deviceWidth) || 0, 8);
    head.writeFloatLE((md && md.deviceHeight) || 0, 12);
    return Buffer.concat([head, image]);
  }

  // The stream is compressed for speed. When nothing has moved for a moment,
  // replace the last frame with a crisp one.
  scheduleSharp(tab) {
    clearTimeout(tab.sharpTimer);
    // The still itself can make Chrome emit one more frame: don't chase it.
    if (tab.sharpDoneAt && Date.now() - tab.sharpDoneAt < 220) return;
    tab.sharpTimer = setTimeout(() => this.sendSharp(tab).catch(() => {}), SHARP_AFTER_MS);
  }

  async sendSharp(tab) {
    if (!this.isShown(tab) || !this.clients.size || tab.hung || !tab.lastFrame || tab.sharpBusy) return;
    const base = tab.lastFrame;
    const md = base.metadata || {};
    const pixels = (md.deviceWidth || 0) * (md.deviceHeight || 0) * Math.pow(this.effective.dpr * (this.effective.zoom || 1), 2);
    const png = pixels > 0 && pixels < PNG_STILL_MAX_PIXELS;
    tab.sharpBusy = true;
    try {
      const { data } = await withTimeout(
        tab.cdp.send("Page.captureScreenshot", png ? { format: "png", optimizeForSpeed: true } : { format: "jpeg", quality: 96, optimizeForSpeed: true }),
        4000,
        "still frame"
      );
      tab.sharpDoneAt = Date.now();
      if (!this.isShown(tab)) return;
      // A frame arrived while capturing. Often the capture itself causes it
      // (always in the side-by-side view), so try again rather than leave a
      // lossy frame on screen; real motion keeps rescheduling anyway.
      if (tab.lastFrame !== base) {
        if ((tab.sharpRetries = (tab.sharpRetries || 0) + 1) <= 2) {
          clearTimeout(tab.sharpRetryTimer);
          tab.sharpRetryTimer = setTimeout(() => this.sendSharp(tab).catch(() => {}), SHARP_AFTER_MS);
        }
        return;
      }
      tab.sharpRetries = 0;
      const buf = this.packFrame(++this.frameSeq, md, Buffer.from(data, "base64"), png ? 3 : 1, this.paneIndex(tab));
      tab.lastFrame = { buf, metadata: md, at: Date.now(), still: true };
      for (const c of this.clients.values()) if (c.ws.readyState === 1 && c.ws.bufferedAmount < 4 * 1024 * 1024) c.ws.send(buf, { binary: true });
    } finally {
      tab.sharpBusy = false;
    }
  }

  async startScreencast() {
    if (WINDOW_MODE) return;
    for (const tab of this.shownTabs()) {
      if (!tab.cdp || tab.screencasting) continue;
      try {
        await withTimeout(tab.cdp.send("Page.startScreencast", { format: "jpeg", quality: STREAM_QUALITY, maxWidth: 8192, maxHeight: 8192, everyNthFrame: 1 }), 8000, "startScreencast");
        tab.screencasting = true;
        // Force a fresh frame even if nothing is animating.
        this.kickFrame(tab);
      } catch (e) {
        log("startScreencast", e.message);
      }
    }
  }

  async stopScreencast() {
    this.flushAcks();
    for (const tab of this.shownTabs()) {
      if (!tab.screencasting) continue;
      tab.screencasting = false;
      await tab.cdp.send("Page.stopScreencast").catch(() => {});
    }
  }

  // ---------- state broadcast ----------
  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const c of this.clients.values()) if (c.ws.readyState === 1) c.ws.send(data);
  }

  toast(text) {
    this.broadcast({ t: "toast", text });
    this.uiToast(text);
  }

  setNav(tab, patch) {
    const before = tab.nav.title + "|" + tab.nav.url + "|" + tab.nav.loading;
    Object.assign(tab.nav, patch);
    if (tab === this.active) this.broadcast({ t: "nav", ...tab.nav, start: isStartUrl(tab.nav.url) });
    if (before !== tab.nav.title + "|" + tab.nav.url + "|" + tab.nav.loading) this.broadcastTabs();
  }

  async refreshNav(tab = this.active) {
    if (!tab || !tab.cdp || tab.page.isClosed()) return;
    try {
      const h = await withTimeout(tab.cdp.send("Page.getNavigationHistory"), 5000, "history");
      const title = await tab.page.title().catch(() => tab.nav.title);
      const url = tab.failedUrl || tab.page.url();
      this.setNav(tab, {
        url,
        title,
        failed: !!tab.failedUrl,
        canGoBack: h.currentIndex > 0,
        canGoForward: h.currentIndex < h.entries.length - 1,
      });
      if (!tab.failedUrl) history.record(url, title);
    } catch {}
  }

  pushLog(type, text, where = "", tab = null) {
    if (tab && tab.mirror) return; // the shared tab already reports the same page
    const tabIdx = tab ? this.tabs.indexOf(tab) : -1;
    this.logs.push({ seq: ++this.logSeq, time: Date.now(), type, text: String(text).slice(0, 2000), where, tab: tabIdx });
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
    if (tab && (type === "error" || type === "pageerror")) {
      tab.errors++;
      if (tab === this.active) {
        // One message per burst is plenty for a badge.
        clearTimeout(this.errorTimer);
        this.errorTimer = setTimeout(() => {
          if (!this.active) return;
          this.broadcast({ t: "errors", count: this.active.errors });
          this.pushUi(this.active);
        }, 150);
      }
    }
  }

  // ---------- camera / microphone permission ----------
  async onPermissionRequest(tab, msg) {
    const origin = msg.origin;
    const decision = this.permDecisions[origin] || (isLocalOrigin(origin) ? "allow" : null);
    if (decision) return this.answerPermission(tab, msg.id, origin, decision === "allow");
    if (!this.clients.size) {
      this.pushLog("dialog", `camera/mic request from ${origin} denied (no viewer to ask)`, "", tab);
      return this.answerPermission(tab, msg.id, origin, false);
    }
    const id = ++this.permSeq;
    this.permPending.set(id, { tab, pageId: msg.id, origin });
    if (tab !== this.active) await this.activate(tab);
    this.broadcast({ t: "permission", id, origin, kinds: msg.kinds });
  }

  async answerPermission(tab, pageId, origin, allow) {
    this.pushLog("dialog", `camera/mic ${allow ? "allowed" : "blocked"} for ${origin}`, "", tab);
    // The request may come from any frame; only the one holding this id reacts.
    await Promise.all(tab.page.frames().map(f => f.evaluate((id, ok) => window.__cb && window.__cb.permissionReply(id, ok), pageId, allow).catch(() => {})));
  }

  async onPermissionReply({ id, allow, remember }) {
    const p = this.permPending.get(id);
    if (!p) return;
    this.permPending.delete(id);
    if (remember) {
      this.permDecisions[p.origin] = allow ? "allow" : "block";
      try {
        fs.writeFileSync(PERMS_FILE, JSON.stringify(this.permDecisions, null, 2));
      } catch {}
    }
    this.broadcast({ t: "permissionDone", id });
    if (this.tabs.includes(p.tab)) await this.answerPermission(p.tab, p.pageId, p.origin, !!allow);
  }

  onPageEmit(tab, json) {
    let msg;
    try {
      msg = JSON.parse(json);
    } catch {
      return;
    }
    // The toolbar and the side-by-side page ask and get an answer back.
    if (msg.t === "ui" && WINDOW_MODE) return this.onUi(tab, msg).catch(e => (log("ui", msg.a, e.message), "null"));
    if (msg.t === "permission") {
      this.onPermissionRequest(tab, msg).catch(e => log("permission", e.message));
      return;
    }
    if (msg.t === "ready" || msg.t === "title") {
      this.refreshNav(tab);
      // A new document starts with pick mode off: carry it across navigations.
      if (msg.t === "ready" && msg.top && tab.picking) tab.page.evaluate(() => window.__cb && window.__cb.setPick(true)).catch(() => {});
      // A pane that (re)loaded while picking picks too.
      if (msg.t === "ready" && msg.pane && tab.picking) this.setPickWindow(tab, true);
      if (msg.t === "ready" && msg.top && this.multi && this.isShown(tab)) tab.page.evaluate(() => window.__cb && window.__cb.setSync && window.__cb.setSync(true)).catch(() => {});
      return;
    }
    if (msg.t === "shown" && WINDOW_MODE) {
      if (this.tabs.includes(tab) && tab !== this.active) this.activate(tab).catch(e => log("follow tab", e.message));
      return;
    }
    if (msg.t === "touched" && WINDOW_MODE) {
      // Real input in one of the device windows: that one leads scroll/nav sync.
      this.lastInputTab = tab;
      return;
    }
    if (msg.t === "wantMulti" && WINDOW_MODE) {
      this.toggleMulti().catch(e => this.toast(e.message));
      return;
    }
    if (msg.t === "wantPick" && WINDOW_MODE) {
      this.pickRequester = this.bridgeTarget();
      this.setPickWindow(tab, !!msg.on);
      return;
    }
    if (msg.t === "wantAnnotate" && WINDOW_MODE) {
      tab.page.mainFrame().evaluate(() => window.__cbUi && window.__cbUi.annotate()).catch(() => {});
      return;
    }
    if (msg.t === "pickState") {
      // In the side-by-side page every pane reports; the toolbar shows any.
      if (!WINDOW_MODE || !msg.pane) tab.picking = !!msg.on;
      this.pushUiSoon();
    }
    if (!this.isShown(tab)) return;
    const pane = this.paneIndex(tab);
    if (msg.t === "context") {
      const s = tab.pageScale || 1;
      this.broadcast({ ...msg, pane, x: msg.x * s, y: msg.y * s, canGoBack: tab.nav.canGoBack, canGoForward: tab.nav.canGoForward, requester: this.lastUserInput.client });
    } else if (msg.t === "scroll") {
      this.onPaneScroll(tab, msg);
    } else if (msg.t === "cursor") {
      if (!pane) this.cursor = msg.v;
      this.broadcast({ ...msg, pane });
    } else if (msg.t === "pickState") {
      if (!pane) this.broadcast(msg);
    } else if (msg.t === "pick") {
      // Picked in one pane: the others leave pick mode too.
      if (!msg.keep && WINDOW_MODE) this.setPickWindow(tab, false);
      else if (!msg.keep) this.setPickAll(false, tab);
      const requester = this.pickRequester;
      const url = tab.page.url();
      const title = (this.nav && this.nav.title) || "";
      resolveChain(msg.chain)
        .catch(e => {
          log("pick resolve", e.message);
          return { chain: msg.chain || [], target: -1 };
        })
        .then(({ chain, target }) => {
          const pick = { id: ++this.pickSeq, kind: "element", tab, pane: msg.pane || null, ref: msg.ref, selector: msg.selector, card: msg.card, chain, target, url, title, at: msg.at };
          pick.report = pickCard(pick);
          pick.seqAt = this.logSeq;
          this.picks.unshift(pick);
          this.basePick(pick);
          this.picks.length = Math.min(this.picks.length, 20);
          this.broadcast({ t: "picked", id: pick.id, report: pick.report, chain, target, selector: msg.selector, url, at: msg.at, requester, title, keep: !!msg.keep });
          if (WINDOW_MODE) this.uiToast(this.sentText(`Pick ${pick.id}`), tab);
        });
    } else if (msg.t === "resolveSrc" && typeof msg.marker === "string") {
      resolveMarkers(msg.marker)
        .catch(() => "")
        .then(v => tab.page.evaluate((m, val) => window.__cb && window.__cb.setResolvedSrc(m, val), msg.marker, v))
        .catch(() => {});
    } else if (msg.t === "pickCancelled") {
      if (WINDOW_MODE) this.setPickWindow(tab, false);
      tab.picking = false;
      this.setPickAll(false, tab);
      this.broadcast({ t: "pickState", on: false });
    } else if (msg.t === "media") {
      tab.media = { camera: !!msg.camera, mic: !!msg.mic };
      if (tab === this.active) this.broadcast({ t: "media", ...tab.media });
      this.broadcastTabs();
    } else if (msg.t === "popup") {
      // Native <select>/date/color popups don't render headless: the viewer
      // draws its own. Convert layout px to what the viewer shows.
      const s = tab.pageScale || 1;
      const r = msg.rect;
      this.broadcast({ ...msg, pane, rect: { x: r.x * s, y: r.y * s, width: r.width * s, height: r.height * s }, requester: this.lastUserInput.client });
    }
  }

  // The Cursor window that gets picks made in the Chrome window: the one
  // focused last, else any connected one.
  bridgeTarget() {
    const a = this.activeClient && this.clients.get(this.activeClient);
    if (a && a.bridge) return this.activeClient;
    for (const [id, c] of this.clients) if (c.bridge) return id;
    return this.activeClient || null;
  }

  // Bring the Chrome window to the front (window mode).
  async showWindow(url) {
    await this.ensure();
    if (url) await this.navigate({ url }).catch(e => this.toast(e.message));
    if (this.active) await withTimeout(this.active.page.bringToFront(), 5000, "bringToFront").catch(() => {});
    const exe = this.executablePath || "";
    if (process.platform === "darwin" && /\.app\//.test(exe) && this.browserInfo && this.browserInfo.kind !== "system") {
      try {
        execFileSync("/usr/bin/open", ["-a", exe.slice(0, exe.indexOf(".app/") + 4)], { stdio: "ignore", timeout: 4000 });
      } catch {}
    }
  }

  setPickAll(on, except) {
    for (const t of this.shownTabs()) {
      if (t === except) continue;
      t.page.evaluate(v => window.__cb && window.__cb.isPicking() !== v && window.__cb.setPick(v), !!on).catch(() => {});
    }
  }

  // ---------- viewer clients ----------
  async addClient(ws, role) {
    const id = crypto.randomBytes(6).toString("hex");
    const client = { ws, viewport: null, bridge: role === "bridge" };
    this.clients.set(id, client);
    this.touch();
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      this.touch();
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.onClientMessage(id, client, msg).catch(e => log("client msg", msg.t, e.message));
    });
    ws.on("close", () => {
      this.clients.delete(id);
      if (this.activeClient === id) {
        this.activeClient = [...this.clients.keys()].pop() || null;
        this.applyViewport().catch(() => {});
      }
      if (!this.clients.size) this.stopScreencast();
    });
    ws.on("error", () => {});
    const hello = () => ({
      t: "hello",
      id,
      version: VERSION,
      tabs: this.tabList(),
      devtools: this.devtoolsPath(),
      nav: { ...this.nav, start: isStartUrl(this.nav.url) },
      cursor: this.cursor,
      override: this.override,
      effective: this.effective,
      zoom: this.zoom,
      colorScheme: this.colorScheme,
      status: this.status,
      browser: this.browserInfo && { kind: this.browserInfo.kind, version: this.browserInfo.version || "" },
      errors: this.active ? this.active.errors : 0,
      hung: !!(this.active && this.active.hung),
      picking: !!(this.active && this.active.picking),
      multi: this.multiState(),
    });
    ws.send(JSON.stringify(hello()));
    // The editor's bridge (window mode) only listens for picks: connecting it
    // must not start a browser.
    if (client.bridge) {
      if (!this.activeClient || !this.clients.get(this.activeClient)) this.activeClient = id;
      return;
    }
    try {
      await this.ensure();
      if (ws.readyState !== 1) return;
      ws.send(JSON.stringify(hello()));
      for (const t of this.shownTabs()) if (t.lastFrame) ws.send(t.lastFrame.buf, { binary: true });
      await this.startScreencast();
      if (this.active) this.kickFrame(this.active);
    } catch (e) {
      log("ensure on connect", e);
      this.setStatus("failed", `Could not start the browser: ${e.message.split("\n")[0]}`);
    }
  }

  async onClientMessage(id, client, msg) {
    // Input carries the pane it happened in; everything else means the shared tab.
    const target = this.paneTab(msg.pane || 0);
    const cdp = target ? target.cdp : null;
    const scale = (target && target.pageScale) || 1;
    switch (msg.t) {
      case "viewport":
        client.viewport = { width: msg.width, height: msg.height, dpr: msg.dpr };
        this.rememberDisplay(msg.dpr);
        if (msg.active || !this.activeClient) this.activeClient = id;
        if (this.activeClient === id) await this.applyViewport();
        return;
      case "bridge":
        // The editor extension in window mode: receives picks, drives no viewport.
        client.bridge = true;
        if (!this.activeClient || !this.clients.get(this.activeClient)) this.activeClient = id;
        return;
      case "show":
        await this.showWindow(msg.url);
        return;
      case "multiToggle":
        await this.ensure();
        await this.toggleMulti().catch(e => this.toast(e.message));
        return;
      case "focus":
        if (this.activeClient !== id) {
          this.activeClient = id;
          await this.applyViewport();
        }
        return;
      case "multi":
        await this.setMulti(msg.on ? msg.keys || DEVICE_ORDER : null);
        return;
      case "multiScale":
        await this.setMultiViewScale(msg.scale);
        return;
      case "multiSize":
        await this.setMultiSize(msg.key, msg.width && msg.height ? { width: msg.width, height: msg.height, name: msg.name } : null).catch(e => this.toast(e.message));
        return;
      case "device":
        if (this.multi) await this.setMulti(null);
        this.override = msg.device ? { width: msg.device.width, height: msg.device.height, mobile: !!msg.device.mobile } : null;
        await this.applyViewport();
        return;
      case "ping":
        client.ws.send(JSON.stringify({ t: "pong", n: msg.n }));
        return;
      case "ack": {
        // Everything up to this frame has been drawn (or skipped) by the viewer.
        for (const [seq, fn] of this.pendingAcks) if (seq <= msg.seq) fn();
        return;
      }
      case "zoom": {
        let z = 1;
        if (msg.dir) {
          const i = ZOOMS.reduce((best, v, idx) => (Math.abs(v - this.zoom) < Math.abs(ZOOMS[best] - this.zoom) ? idx : best), 0);
          z = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, i + (msg.dir > 0 ? 1 : -1)))];
        }
        this.zoom = z;
        await this.applyViewport();
        return;
      }
      case "scheme":
        await this.setScheme(msg.value);
        return;
      case "action":
        await this.viewerAction(client, msg, id);
        return;
      case "annotate":
        if (target) await this.annotate(target, msg, id);
        return;
      case "errorList":
        client.ws.send(JSON.stringify(await this.errorSummary(this.active)));
        return;
      case "sendErrors":
        await this.sendErrors(Array.isArray(msg.ids) ? msg.ids : null, id);
        return;
      case "mouse":
        if (!cdp) return;
        if (msg.type !== "mouseMoved") this.lastInputTab = target;
        if (target && target.picking) {
          // Picking is decided here, not by the page's own click handling, so
          // disabled controls and click-swallowing overlays can be picked too.
          const tab = target;
          if (msg.type === "mousePressed") {
            tab.swallowRelease = true;
            if ((msg.button || "left") === "left") {
              this.pickRequester = id;
              const s = scale;
              tab.page.evaluate((x, y, keep) => window.__cb && window.__cb.pickAt(x, y, keep), msg.x / s, msg.y / s, !!(msg.modifiers & 8)).catch(e => log("pick", e.message));
            }
            return;
          }
          if (msg.type === "mouseReleased" && tab.swallowRelease) {
            tab.swallowRelease = false;
            return;
          }
        }
        if (msg.type === "mousePressed") {
          this.lastUserInput = { at: Date.now(), client: id };
          this.noteInput(`click ${Math.round(msg.x)},${Math.round(msg.y)}`);
        }
        cdp
          .send("Input.dispatchMouseEvent", {
            type: msg.type,
            x: msg.x / scale,
            y: msg.y / scale,
            button: msg.button || "none",
            buttons: msg.buttons || 0,
            clickCount: msg.clickCount || 0,
            modifiers: msg.modifiers || 0,
          })
          .catch(() => {});
        return;
      case "wheel":
        if (!cdp) return;
        this.lastInputTab = target;
        cdp
          .send("Input.dispatchMouseEvent", { type: "mouseWheel", x: msg.x / scale, y: msg.y / scale, deltaX: msg.dx, deltaY: msg.dy, modifiers: msg.modifiers || 0 })
          .catch(() => {});
        return;
      case "key": {
        if (!cdp) return;
        if (msg.type !== "keyUp") {
          this.lastUserInput = { at: Date.now(), client: id };
          // Key names only (no typed characters: this may be a password field).
          const m = msg.modifiers || 0;
          const mods = (m & 4 ? "Meta+" : "") + (m & 2 ? "Ctrl+" : "") + (m & 1 ? "Alt+" : "") + (m & 8 ? "Shift+" : "");
          this.noteInput(`key ${mods}${msg.key && msg.key.length === 1 ? "<char>" : msg.key}${msg.commands ? " " + msg.commands : ""}`);
        }
        const p = { type: msg.type, modifiers: msg.modifiers || 0 };
        for (const k of ["key", "code", "text", "unmodifiedText", "windowsVirtualKeyCode", "nativeVirtualKeyCode", "autoRepeat", "location", "commands"]) {
          if (msg[k] !== undefined) p[k] = msg[k];
        }
        cdp.send("Input.dispatchKeyEvent", p).catch(() => {});
        return;
      }
      case "text":
        if (cdp && msg.text) cdp.send("Input.insertText", { text: msg.text }).catch(() => {});
        return;
      case "copy": {
        if (!target) return;
        const text = await target.page.evaluate(() => (window.__cb ? window.__cb.selectionText() : String(getSelection()))).catch(() => "");
        if (msg.cut && text) cdp && cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 }).catch(() => {});
        client.ws.send(JSON.stringify({ t: "clipboard", text }));
        return;
      }
      case "nav":
        await this.navigate(msg);
        return;
      case "suggest":
        client.ws.send(JSON.stringify({ t: "suggestions", seq: msg.seq, q: msg.q, items: history.suggest(msg.q) }));
        return;
      case "forget":
        history.remove(msg.url);
        return;
      case "pick":
        await this.ensure();
        this.pickRequester = id;
        if (WINDOW_MODE) {
          await this.showWindow();
          this.setPickWindow(this.active, !!msg.on);
          return;
        }
        await this.page.evaluate(on => window.__cb && window.__cb.setPick(on), !!msg.on).catch(() => {});
        this.setPickAll(!!msg.on, this.active);
        return;
      case "restart":
        await this.restart();
        return;
      case "tab": {
        if (msg.action === "new") await this.newTab(msg.url || START_URL);
        else if (msg.action === "switch") await this.activate(this.tabByRef(msg.id));
        else if (msg.action === "close") await this.closeTab(this.tabByRef(msg.id));
        return;
      }
      case "permissionReply":
        await this.onPermissionReply(msg);
        return;
      case "popupResult": {
        if (!target) return;
        await target.page.evaluate((ref, value) => window.__cb && window.__cb.setValue(ref, value), msg.ref, msg.value).catch(() => {});
        return;
      }
      case "files": {
        const paths = Array.isArray(msg.paths) ? msg.paths.filter(p => typeof p === "string" && fs.existsSync(p)) : [];
        if (!paths.length) {
          if (this.active) this.active.pendingChooser = null;
          return;
        }
        await this.setFiles(this.active, paths).catch(e => this.toast(e.message));
        return;
      }
      case "filesData": {
        if (!Array.isArray(msg.files) || !msg.files.length) return;
        const paths = this.saveUploads(msg.files);
        await this.setFiles(this.active, paths).catch(e => this.toast(e.message));
        return;
      }
    }
  }

  async navigate({ action, url }) {
    const page = await this.ensure();
    if (action === "goto") {
      const target = normalizeUrl(url);
      this.setNav(this.active, { url: target, loading: true });
      try {
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 });
      } catch (e) {
        this.toast(e.message.split("\n")[0]);
        throw e;
      }
    } else if (action === "reload") {
      if (this.active && this.active.hung && !CURSOR_MODE) return this.replaceTab(this.active);
      this.reloadMirrors(false);
      if (CURSOR_MODE) {
        await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {}), this.reloadTab(this.active)]);
      } else await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(e => this.toast(e.message.split("\n")[0]));
    } else if (action === "back" || action === "forward") {
      const h = await this.cdp.send("Page.getNavigationHistory");
      const idx = h.currentIndex + (action === "back" ? -1 : 1);
      if (idx < 0 || idx >= h.entries.length) return false;
      await this.cdp.send("Page.navigateToHistoryEntry", { entryId: h.entries[idx].id });
    } else if (action === "stop") {
      await this.cdp.send("Page.stopLoading").catch(() => {});
    }
    return true;
  }

  async restart() {
    if (this.tabs.length) this.restore = this.sessionSnapshot();
    await this.recover("restart requested");
  }

  // Things the viewer's ⋯ menu and shortcuts ask for.
  async viewerAction(client, msg, clientId) {
    const tab = this.active;
    const reply = m => client.ws.readyState === 1 && client.ws.send(JSON.stringify(m));
    // Right-click menu items act on the pane that was clicked.
    const pane = this.paneTab(msg.pane || 0);
    const ps = (pane && pane.pageScale) || 1;
    switch (msg.name) {
      case "openTab":
        if (/^(https?|file|data|blob):/i.test(msg.url || "")) await this.newTab(msg.url);
        return;
      case "pickPoint":
        this.pickRequester = clientId;
        if (pane) await pane.page.evaluate((x, y) => window.__cb && window.__cb.pickPoint(x, y), msg.x / ps, msg.y / ps).catch(e => log("pickPoint", e.message));
        return;
      case "inspect": {
        // The console's inspect() makes DevTools reveal a node, but only the
        // DevTools that asked: so ask through its own (proxied) connection.
        if (!pane) return;
        const expr = `inspect((window.__cb && window.__cb.hitTest(${Number(msg.x) / ps}, ${Number(msg.y) / ps})) || document.elementFromPoint(${Number(msg.x) / ps}, ${Number(msg.y) / ps}))`;
        for (let i = 0; i < 40; i++) {
          const ups = [...(devtoolsUpstreams.get(pane.id) || [])].filter(u => u.readyState === 1);
          if (ups.length) {
            // A freshly opened DevTools needs a moment before it listens.
            if (i > 0) await sleep(900);
            for (const u of ups) u.send(JSON.stringify({ id: 900000000 + Math.floor(Math.random() * 1e6), method: "Runtime.evaluate", params: { expression: expr, includeCommandLineAPI: true } }));
            return;
          }
          await sleep(150);
        }
        return;
      }
      case "saveImage": {
        if (!pane || !msg.url) return;
        try {
          let buf;
          let type = "";
          if (/^data:/i.test(msg.url)) {
            const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(msg.url);
            type = m[1];
            buf = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]));
          } else {
            // Through the page, so cookies and blob: URLs work; plain fetch as a fallback.
            const got = await withTimeout(pane.page.evaluate(u => window.__cb.fetchAsBase64(u), msg.url), 15000, "image").catch(() => null);
            if (got && got.data) {
              buf = Buffer.from(got.data, "base64");
              type = got.type;
            } else {
              const res = await fetch(msg.url, { signal: AbortSignal.timeout(15000) });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              buf = Buffer.from(await res.arrayBuffer());
              type = res.headers.get("content-type") || "";
            }
          }
          let name = "image";
          try {
            name = decodeURIComponent(path.basename(new URL(msg.url).pathname)) || "image";
          } catch {}
          if (/^(data|blob):/i.test(msg.url)) name = "image";
          if (!path.extname(name)) name += "." + ((/image\/([a-z0-9+]+)/i.exec(type) || [])[1] || "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
          const guid = crypto.randomBytes(8).toString("hex");
          fs.mkdirSync(DOWNLOAD_TMP, { recursive: true });
          fs.writeFileSync(path.join(DOWNLOAD_TMP, guid), buf);
          const d = { guid, url: msg.url.slice(0, 300), name, state: "completed", received: buf.length, total: buf.length, path: null, at: Date.now() };
          d.path = this.finishDownload(d);
          this.downloads.unshift(d);
          this.downloads.length = Math.min(this.downloads.length, 30);
          this.broadcast({ t: "download", ...d });
        } catch (e) {
          this.toast(`Could not save the image: ${e.message.split("\n")[0]}`);
        }
        return;
      }
      case "hardReload":
        this.reloadMirrors(true);
        if (tab) await this.reloadTab(tab, true).catch(e => this.toast(e.message.split("\n")[0]));
        return;
      case "replaceTab":
        await this.replaceTab(tab);
        return;
      case "clearSite": {
        if (!tab) return;
        let origin = "";
        try {
          origin = new URL(tab.failedUrl || tab.page.url()).origin;
        } catch {}
        if (!/^https?:/.test(origin)) return this.toast("Nothing to clear for this page");
        await tab.cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" }).catch(e => log("clearSite", e.message));
        // Cookies are per host, not per origin.
        const { cookies } = await tab.cdp.send("Network.getCookies", { urls: [origin] }).catch(() => ({ cookies: [] }));
        for (const c of cookies || []) await tab.cdp.send("Network.deleteCookies", { name: c.name, domain: c.domain, path: c.path }).catch(() => {});
        this.reloadMirrors(true);
        await this.reloadTab(tab, true);
        this.toast(`Cleared cookies and storage for ${new URL(origin).host}`);
        return;
      }
      case "screenshot": {
        if (!tab) return;
        const { data } = await withTimeout(tab.cdp.send("Page.captureScreenshot", { format: "png" }), 8000, "screenshot");
        fs.mkdirSync(SHOTS_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const file = path.join(SHOTS_DIR, `screenshot-${stamp}.png`);
        fs.writeFileSync(file, Buffer.from(data, "base64"));
        reply({ t: "shot", path: file, data });
        return;
      }
    }
  }

  // ---------- agent tools ----------
  async settle(prevUrl) {
    await sleep(120);
    if (!this.page) return "";
    try {
      await this.page.waitForNetworkIdle({ idleTime: 350, timeout: 2500 });
    } catch {}
    const url = this.page.url();
    return url !== prevUrl ? `\nNavigated to: ${url}` : "";
  }

  newErrorsSince(seq) {
    const errs = this.logs.filter(l => l.seq > seq && (l.type === "error" || l.type === "pageerror" || l.type === "network"));
    if (!errs.length) return "";
    return "\nNew errors:\n" + errs.slice(-8).map(l => `  [${l.type}] ${l.text.split("\n")[0].slice(0, 300)}`).join("\n");
  }

  // Position of an element (or a point) in the target's own coordinates.
  async locate(args, T) {
    const spec = { ref: args.ref, selector: args.selector, text: args.text };
    if (args.x !== undefined && args.y !== undefined && !spec.ref && !spec.selector && !spec.text) {
      return { x: args.x, y: args.y, tag: "point", label: "" };
    }
    const res = await (T ? T.frame : this.page).evaluate(s => (window.__cb ? window.__cb.locate(s) : { error: "page helper not loaded yet" }), spec);
    if (res.error) throw new Error(res.error);
    return res;
  }

  async tool(name, args = {}) {
    const mine = name !== "verify";
    if (mine) this.busyTools++;
    try {
      return await this.runTool(name, args);
    } finally {
      if (mine) this.busyTools--;
      if (ACTING_TOOLS.has(name)) this.lastAct = { at: Date.now(), seq: this.logSeq };
    }
  }

  async runTool(name, args = {}) {
    this.touch();
    const text = t => [{ type: "text", text: t }];
    if (name === "restart") {
      await this.restart();
      return text(`Browser restarted (${this.tabs.length} tab${this.tabs.length === 1 ? "" : "s"} reopened). URL: ${this.nav.url}`);
    }
    if (this.recovering) await this.recovering;
    const page = await this.ensure();
    if (WINDOW_MODE && !this.override) await this.measureWindow();
    // In the side-by-side view (window mode) tools act on the widest pane.
    const T = ["snapshot", "screenshot", "click", "hover", "type", "press", "scroll", "wait", "evaluate", "react", "upload", "select", "inspect", "verify"].includes(name) ? await this.toolTarget() : null;
    const fr = T ? T.frame : page.mainFrame();
    const toTab = (x, y) => ({ x: T.ox + x * T.s, y: T.oy + y * T.s });
    const paneNote = T && T.pane ? `[Side-by-side view: acting on the ${T.pane.label} pane, ${T.pane.width}×${T.pane.height}]\n` : "";
    const seq = this.logSeq;
    const prevUrl = page.url();
    const startedAt = Date.now();

    switch (name) {
      case "navigate": {
        if (args.url) {
          this.broadcast({ t: "agent", kind: "navigate" });
          await this.navigate({ action: "goto", url: args.url });
        } else if (args.action) {
          await this.navigate({ action: args.action });
        } else throw new Error("Pass url or action");
        await this.settle(prevUrl);
        await this.refreshNav();
        const now = this.page || page; // Cursor mode: a reload swaps the page
        return text(`URL: ${now.url()}\nTitle: ${await now.title().catch(() => "")}${this.newErrorsSince(seq)}`);
      }

      case "snapshot": {
        const snap = await fr.evaluate(o => (window.__cb ? window.__cb.snapshot(o) : "page helper not loaded"), { maxChars: args.maxChars || 40000 });
        return text(paneNote + (await resolveMarkers(snap)).replace(/  ‹›/g, ""));
      }

      case "screenshot": {
        if (args.viewports && WINDOW_MODE && T.pane) {
          // The side-by-side view: each pane at its device size.
          const tab = this.active;
          await page.waitForNetworkIdle({ idleTime: 400, timeout: 6000 }).catch(() => {});
          const out = [];
          for (const key of this.multi.keys) {
            const r = await this.paneRect(tab, key);
            if (!r) continue;
            const d = this.device(key);
            const f = await this.paneFrame(tab, key);
            const data = await this.capture(tab, { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 / (r.s || 1) }, null);
            out.push({ type: "text", text: `${d.label} ${d.width}×${d.height}${key === T.key ? " (the pane tools act on)" : ""} — ${f ? f.url() : page.url()}` }, { type: "image", data, mimeType: "image/png" });
          }
          return out;
        }
        if (args.viewports && WINDOW_MODE) {
          // Side-by-side is off: emulate each device on the shared tab in
          // turn, then give the window its own size back.
          const tab = this.active;
          const out = [];
          await this.uiCapture(tab, "all");
          try {
            for (const key of DEVICE_ORDER) {
              const d = this.device(key);
              await tab.cdp.send("Emulation.setDeviceMetricsOverride", { width: d.width, height: d.height, deviceScaleFactor: 1, mobile: !!d.mobile, screenWidth: d.width, screenHeight: d.height });
              await tab.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: !!d.mobile }).catch(() => {});
              await sleep(700);
              const { data } = await withTimeout(tab.cdp.send("Page.captureScreenshot", { format: "png" }), 8000, "screenshot");
              out.push({ type: "text", text: `${d.label} ${d.width}×${d.height} — ${tab.page.url()}` }, { type: "image", data, mimeType: "image/png" });
            }
          } finally {
            await tab.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
            tab.viewportKey = null;
            await this.applyViewport();
            await this.uiCapture(tab, null);
          }
          return out;
        }
        if (args.viewports) {
          // One image per device of the side-by-side view (turned on if needed).
          if (!this.multi) {
            await this.setMulti(DEVICE_ORDER);
            await sleep(600);
          }
          await Promise.all(this.mirrors.map(m => m.page.waitForNetworkIdle({ idleTime: 400, timeout: 6000 }).catch(() => {})));
          await sleep(250);
          const out = [];
          const state = this.multiState();
          for (const p of state.panes) {
            const t = this.paneTab(p.pane);
            // Panes render at the panel's (small) scale: capture at full size.
            const at = await t.page.evaluate(() => ({ x: scrollX, y: scrollY })).catch(() => ({ x: 0, y: 0 }));
            const panel = this.activeClient && this.clients.get(this.activeClient);
            const want = Math.min(3, Math.max(1, (panel && panel.viewport && panel.viewport.dpr) || 1));
            const clip = { x: at.x, y: at.y, width: p.width, height: p.height, scale: WINDOW_MODE ? 1 : want / (this.effective.dpr || 1) };
            const { data } = await withTimeout(t.cdp.send("Page.captureScreenshot", { format: "png", clip }), 8000, "screenshot");
            out.push({ type: "text", text: `${p.label} ${p.width}×${p.height}${p.pane === 0 ? " (shared tab)" : ""} — ${t.page.url()}` }, { type: "image", data, mimeType: "image/png" });
          }
          return out;
        }
        if ((args.ref || args.selector) && T.pane) {
          // An element of a pane shown scaled: clip the tab's picture to it.
          const loc = await this.locate({ ref: args.ref, selector: args.selector }, T);
          const r = loc.rect;
          const data = await this.capture(this.active, { x: T.ox + r.x * T.s, y: T.oy + r.y * T.s, width: Math.max(1, r.width * T.s), height: Math.max(1, r.height * T.s), scale: 1 / T.s }, null);
          return [{ type: "image", data, mimeType: "image/png" }];
        }
        if (args.ref || args.selector) {
          const handle = args.ref
            ? await page.evaluateHandle(r => window.__cb && window.__cb.resolve(r), args.ref)
            : await page.$(args.selector);
          const el = handle && handle.asElement();
          if (!el) throw new Error("element not found");
          await this.uiCapture(this.active, "all");
          try {
            const data = await el.screenshot({ encoding: "base64", type: "png" });
            return [{ type: "image", data, mimeType: "image/png" }];
          } finally {
            await this.uiCapture(this.active, null);
          }
        }
        if (T.pane) {
          // Side-by-side view: the pane tools act on, at its device size.
          const r = T.rect;
          const data = await this.capture(this.active, { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 / T.s }, null);
          return [
            { type: "image", data, mimeType: "image/png" },
            { type: "text", text: `${fr.url()} — ${T.pane.label} pane ${T.pane.width}×${T.pane.height} of the side-by-side view (viewports:true captures every pane)` },
          ];
        }
        const eff = this.effective;
        const css = this.cssSize(eff);
        const scale = args.hiDpi ? 1 : 1 / (eff.dpr * (eff.zoom || 1));
        let clip;
        if (args.fullPage) {
          const dims = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: Math.min(document.documentElement.scrollHeight, 8000) }));
          clip = { x: 0, y: 0, width: dims.w, height: dims.h, scale };
        } else {
          const s = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
          clip = { x: s.x, y: s.y, width: css.width, height: css.height, scale };
        }
        await this.uiCapture(this.active, "all");
        let data;
        try {
          data = await page.screenshot({ encoding: "base64", type: "png", clip, captureBeyondViewport: !!args.fullPage });
        } finally {
          await this.uiCapture(this.active, null);
        }
        return [
          { type: "image", data, mimeType: "image/png" },
          { type: "text", text: `${page.url()} — viewport ${css.width}×${css.height}${eff.mobile ? " (mobile)" : ""}` },
        ];
      }

      case "click": {
        const loc = await this.locate(args, T);
        this.broadcast({ t: "agent", kind: "click", x: loc.x * (this.pageScale || 1), y: loc.y * (this.pageScale || 1) });
        const at = toTab(loc.x, loc.y);
        await page.mouse.click(at.x, at.y, { button: args.button || "left", count: args.double ? 2 : 1 });
        const nav = await this.settle(prevUrl);
        const warn = loc.covered ? `\nWarning: the element was covered by <${loc.covered}> at that point; the click may have hit it instead.` : "";
        const chooser = this.active && this.active.pendingChooser && this.active.pendingChooser.at > startedAt ? "\nA file chooser opened: call browser_upload with the file path(s)." : "";
        return text(`${paneNote}${chooser ? chooser.trim() + "\n" : ""}Clicked ${loc.tag}${loc.label ? ` "${loc.label}"` : ""} at (${Math.round(loc.x)}, ${Math.round(loc.y)}).${warn}${nav}${this.newErrorsSince(seq)}`);
      }

      case "hover": {
        const loc = await this.locate(args, T);
        this.broadcast({ t: "agent", kind: "hover", x: loc.x * (this.pageScale || 1), y: loc.y * (this.pageScale || 1) });
        const at = toTab(loc.x, loc.y);
        await page.mouse.move(at.x, at.y, { steps: 4 });
        await sleep(200);
        return text(`Hovering ${loc.tag}${loc.label ? ` "${loc.label}"` : ""} at (${Math.round(loc.x)}, ${Math.round(loc.y)}).`);
      }

      case "type": {
        if (args.ref || args.selector || args.text_match) {
          const loc = await this.locate({ ref: args.ref, selector: args.selector, text: args.text_match }, T);
          this.broadcast({ t: "agent", kind: "click", x: loc.x * (this.pageScale || 1), y: loc.y * (this.pageScale || 1) });
          const at = toTab(loc.x, loc.y);
          await page.mouse.click(at.x, at.y);
        }
        if (args.clear) {
          await fr.evaluate(() => {
            const a = document.activeElement;
            if (a && typeof a.select === "function") a.select();
            else document.execCommand("selectAll");
          });
          await page.keyboard.press("Backspace");
        }
        this.broadcast({ t: "agent", kind: "type" });
        await page.keyboard.type(String(args.text ?? ""), { delay: args.slowly ? 40 : 0 });
        if (args.submit) await page.keyboard.press("Enter");
        const nav = await this.settle(prevUrl);
        return text(`Typed ${JSON.stringify(String(args.text ?? "").slice(0, 80))}${args.submit ? " + Enter" : ""}.${nav}${this.newErrorsSince(seq)}`);
      }

      case "press": {
        const combo = String(args.key || "").split("+").map(s => s.trim()).filter(Boolean);
        const mods = combo.slice(0, -1).map(m => ({ cmd: "Meta", command: "Meta", meta: "Meta", ctrl: "Control", control: "Control", alt: "Alt", option: "Alt", shift: "Shift" })[m.toLowerCase()] || m);
        const key = combo[combo.length - 1];
        for (const m of mods) await page.keyboard.down(m);
        await page.keyboard.press(key);
        for (const m of mods.reverse()) await page.keyboard.up(m);
        const nav = await this.settle(prevUrl);
        return text(`Pressed ${args.key}.${nav}${this.newErrorsSince(seq)}`);
      }

      case "scroll": {
        let x = (T.pane ? T.pane.width : this.cssSize().width) / 2;
        let y = (T.pane ? T.pane.height : this.cssSize().height) / 2;
        if (args.ref || args.selector) {
          const loc = await this.locate(args, T);
          x = loc.x;
          y = loc.y;
          if (!args.dy && !args.dx) return text(`Scrolled ${loc.tag} into view.`);
        }
        const at = toTab(x, y);
        await page.mouse.move(at.x, at.y);
        await page.mouse.wheel({ deltaX: (args.dx || 0) * T.s, deltaY: (args.dy ?? 600) * T.s });
        await sleep(350);
        const pos = await fr.evaluate(() => `${Math.round(scrollX)},${Math.round(scrollY)} of ${document.documentElement.scrollWidth}×${document.documentElement.scrollHeight}`);
        return text(`Scrolled. Window scroll: ${pos}`);
      }

      case "wait": {
        const timeout = args.timeout || 10000;
        if (args.text) {
          await fr.waitForFunction(t => document.body && document.body.innerText.includes(t), { timeout, polling: 200 }, args.text);
          return text(`Text "${args.text}" is present.`);
        }
        if (args.selector) {
          await fr.waitForSelector(args.selector, { timeout, visible: true });
          return text(`Selector ${args.selector} is visible.`);
        }
        if (args.textGone) {
          await fr.waitForFunction(t => !document.body || !document.body.innerText.includes(t), { timeout, polling: 200 }, args.textGone);
          return text(`Text "${args.textGone}" is gone.`);
        }
        await sleep(Math.min(args.ms || 1000, 30000));
        return text(`Waited ${args.ms || 1000}ms.`);
      }

      case "evaluate": {
        const result = await fr.evaluate(
          // eslint-disable-next-line no-new-func
          async src => {
            let fn;
            try {
              fn = new Function(`return (async () => { return (${src}\n); })()`);
            } catch {
              // Not a single expression: run as a function body (use `return`).
              fn = new Function(`return (async () => { ${src}\n })()`);
            }
            const v = await fn();
            try {
              return JSON.stringify(v, null, 2) ?? String(v);
            } catch {
              return String(v);
            }
          },
          String(args.expression)
        );
        return text(paneNote + String(result).slice(0, 30000));
      }

      case "network":
        return this.networkTool(args);

      case "react": {
        const res = await fr.evaluate(spec => (window.__cb && window.__cb.react ? window.__cb.react(spec) : { error: "page helper not loaded yet" }), {
          ref: args.ref,
          selector: args.selector,
          text: args.text,
          component: args.component,
          depth: args.depth,
          maxChars: args.maxChars,
          tree: !!args.tree,
          limit: args.limit,
        });
        if (res.error) throw new Error(res.error);
        return text(await formatReact(res, args));
      }

      case "console": {
        const types = args.types && args.types.length ? new Set(args.types) : null;
        const since = args.sinceSeq || 0;
        const rows = this.logs.filter(l => l.seq > since && (!types || types.has(l.type))).slice(-(args.limit || 80));
        if (args.clear) this.logs = [];
        // Stack frames of errors point into generated code: show the source lines.
        const mapped = new Map();
        await Promise.all(
          rows
            .filter(l => l.type === "pageerror" || l.type === "error")
            .map(async l => mapped.set(l, await mapUrlsInText(l.text).catch(() => l.text)))
        );
        for (const [l, t] of mapped) if (t && t !== l.text) l.shown = t;
        if (!rows.length) return text(`No console/network entries${types ? " of those types" : ""}. (latest seq ${this.logSeq})`);
        return text(
          rows.map(l => `#${l.seq} [${l.type}] ${l.shown || l.text}${l.where && l.type !== "network" ? `  (${l.where})` : ""}`).join("\n") + `\n(latest seq ${this.logSeq})`
        );
      }

      case "picked": {
        if (!this.picks.length) return text("Nothing picked or sent yet. Ask the user to press the crosshair button in the Claude Browser panel and click an element.");
        const n = Math.min(args.count || 1, this.picks.length);
        const out = [];
        this.picks.slice(0, n).forEach((p, i) => {
          out.push({ type: "text", text: `${i === 0 ? "Most recent" : `#${i + 1}`} (${Math.round((Date.now() - p.at) / 1000)}s ago):\n${p.report}` });
          if (p.image) out.push({ type: "image", data: p.image, mimeType: "image/png" });
        });
        return out;
      }

      case "inspect":
        return text(await this.inspectTool(args, T));

      case "verify":
        return this.verifyTool(args, T);

      case "viewport": {
        if (args.sizes && typeof args.sizes === "object") {
          for (const [key, size] of Object.entries(args.sizes)) await this.setMultiSize(key, size);
          if (args.multi === undefined) return text(`Side-by-side sizes: ${DEVICE_ORDER.map(k => this.device(k)).map(d => `${d.label} ${d.width}×${d.height}`).join(", ")}.${this.multi ? "" : " (The view is off; multi:true turns it on.)"}`);
        }
        if (args.multi !== undefined) {
          await this.setMulti(args.multi ? (Array.isArray(args.multi) ? args.multi : DEVICE_ORDER) : null);
          if (this.multi && WINDOW_MODE) return text(`Side-by-side view on, in the tab itself: ${this.multiState().panes.map(p => `${p.label} ${p.width}×${p.height}`).join(", ")}. Every other tool acts on the ${this.device(this.primaryKey()).label} pane. browser_screenshot with viewports:true captures all of them.`);
          if (this.multi) return text(`Side-by-side view on: ${this.multiState().panes.map(p => `${p.label} ${p.width}×${p.height}`).join(", ")}. The shared tab (the one every other tool acts on) is the first one listed. browser_screenshot with viewports:true captures all of them.`);
          return text("Side-by-side view off.");
        }
        if (this.multi && (args.reset || (args.width && args.height))) await this.setMulti(null);
        if (args.reset) this.override = null;
        else if (args.width && args.height) this.override = { width: args.width, height: args.height, mobile: !!args.mobile };
        await this.applyViewport();
        const e = this.effective;
        return text(`Viewport: ${e.width}×${e.height} @${e.dpr}x${e.mobile ? " mobile" : ""}${this.override ? " (fixed)" : " (fits the panel)"}`);
      }

      case "tabs": {
        const action = args.action || "list";
        if (action === "new") await this.newTab(args.url || null);
        else if (action === "switch" || action === "close") {
          const tab = this.tabByRef(args.index ?? args.id);
          if (!tab) throw new Error(`No tab ${args.index ?? args.id}`);
          if (action === "switch") await this.activate(tab);
          else await this.closeTab(tab);
          await sleep(200);
        }
        if (action !== "list") await sleep(300);
        return text(this.tabList().map((t, i) => `${t.active ? "▶" : " "} [${i}] ${t.title}${t.title !== t.url ? `  — ${t.url}` : ""}`).join("\n"));
      }

      case "upload": {
        const paths = (args.paths || []).map(p => path.resolve(String(p).replace(/^~(?=\/|$)/, os.homedir())));
        const missing = paths.filter(p => !fs.existsSync(p));
        if (!paths.length || missing.length) throw new Error(missing.length ? `File not found: ${missing.join(", ")}` : "Pass paths");
        if (args.ref || args.selector) {
          const handle = args.ref ? await fr.evaluateHandle(r => window.__cb && window.__cb.resolve(r), args.ref) : await fr.$(args.selector);
          const el = handle && handle.asElement();
          if (!el) throw new Error("element not found");
          const isFile = await el.evaluate(e => e instanceof HTMLInputElement && e.type === "file");
          if (!isFile) throw new Error("That element is not an <input type=file>; click the upload control instead and then call browser_upload with just paths.");
          await el.uploadFile(...paths);
        } else {
          await this.setFiles(this.active, paths);
        }
        const nav = await this.settle(prevUrl);
        return text(`Attached ${paths.map(p => path.basename(p)).join(", ")}.${nav}${this.newErrorsSince(seq)}`);
      }

      case "select": {
        const res = await fr.evaluate(
          (spec, want) => {
            const el = spec.ref ? window.__cb.resolve(spec.ref) : document.querySelector(spec.selector);
            if (!(el instanceof HTMLSelectElement)) return { error: "not a <select>" };
            const opts = [...el.options];
            const w = String(want).trim().toLowerCase();
            const o = opts.find(x => x.value === want) || opts.find(x => x.text.trim().toLowerCase() === w) || opts.find(x => x.text.toLowerCase().includes(w));
            if (!o) return { error: `no option matching "${want}". Options: ${opts.map(x => x.text.trim()).join(" | ")}` };
            window.__cb.setValue(window.__cb.refFor(el), o.value);
            return { label: o.text.trim(), value: o.value };
          },
          { ref: args.ref, selector: args.selector },
          String(args.option ?? "")
        );
        if (res.error) throw new Error(res.error);
        const nav = await this.settle(prevUrl);
        return text(`Selected "${res.label}" (value ${JSON.stringify(res.value)}).${nav}${this.newErrorsSince(seq)}`);
      }

      case "downloads": {
        if (!this.downloads.length) return text("No downloads yet.");
        return text(
          this.downloads
            .slice(0, args.limit || 10)
            .map(d => `${d.state === "completed" ? "✓" : d.state === "canceled" ? "✗" : "…"} ${d.name}${d.path ? `  → ${d.path}` : ""}  (${d.url.slice(0, 120)})`)
            .join("\n")
        );
      }

      case "status": {
        await this.refreshNav();
        const e = this.effective;
        const b = this.browserInfo;
        return text(
          `Engine: ${VERSION}  Browser: ${b ? (b.kind === "cursor" ? `Cursor's Browser Tab (${b.version || ""}, port ${CURSOR_PORT})` : `${b.kind === "managed" ? "own Chromium" : b.kind === "system" ? "installed browser" : "custom"} ${b.version || ""} (${b.executablePath})`) : "not running"}\nURL: ${this.nav.url}${this.active && this.active.failedUrl ? "  (failed to load)" : ""}\nTitle: ${this.nav.title}\nPage responding: ${this.active && this.active.hung ? "NO — call browser_restart, or browser_navigate with action reload" : "yes"}\nViewport: ${e.width}×${e.height} @${e.dpr}x${e.mobile ? " mobile" : ""}${e.zoom && e.zoom !== 1 ? ` zoom ${Math.round(e.zoom * 100)}%` : ""}\nTabs: ${this.tabs.length} (active ${this.tabs.indexOf(this.active)})\nCamera: ${this.active && this.active.media && this.active.media.camera ? "in use" : "off"}  Mic: ${this.active && this.active.media && this.active.media.mic ? "in use" : "off"}\nViewers connected: ${this.clients.size}\nPicks stored: ${this.picks.length}`
        );
      }
    }
    throw new Error(`Unknown tool ${name}`);
  }
}

// ---------- servers ----------
const engine = new Engine();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/health") return json(200, { ok: true, name: "claude-browser", version: VERSION, pid: process.pid });
  if (req.method === "GET" && url.pathname === "/start") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(START_PAGE);
  }
  if (req.method === "GET" && url.pathname === "/start/data") {
    // Same-origin only (no CORS headers): other pages cannot read this.
    return json(200, { servers: await localServers(engine.chromePort).catch(() => []), recent: history.top(9) });
  }
  if (req.method === "GET" && url.pathname.startsWith("/panel/")) {
    // The viewer, usable from any browser: /panel/panel.html?token=…
    const name = path.basename(url.pathname);
    const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
    const file = path.join(MEDIA_DIR, name);
    if (!types[path.extname(name)] || !fs.existsSync(file)) return json(404, { error: "not found" });
    res.writeHead(200, { "content-type": types[path.extname(name)], "cache-control": "no-store" });
    return res.end(fs.readFileSync(file));
  }
  if (req.method === "GET" && url.pathname.startsWith("/devtools/")) {
    // Static DevTools frontend files from Chrome (no secrets in them).
    if (url.pathname === "/devtools/__cb_prefs.js") {
      // Runs before DevTools boots: its own screencast duplicates our view.
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(
        `try{if(!localStorage.getItem("cb-prefs-v1")){localStorage.setItem("screencast-enabled","false");localStorage.setItem("cb-prefs-v1","1");}}catch(e){}`
      );
      return;
    }
    if (!engine.chromePort) return json(503, { error: "browser not running" });
    if (url.pathname === "/devtools/inspector.html") {
      http
        .get({ host: "127.0.0.1", port: engine.chromePort, path: req.url }, r => {
          let body = "";
          r.setEncoding("utf8");
          r.on("data", c => (body += c));
          r.on("end", () => {
            res.writeHead(r.statusCode || 502, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
            res.end(body.replace('<script type="module"', '<script src="./__cb_prefs.js"></script>\n<script type="module"'));
          });
        })
        .on("error", e => json(502, { error: e.message }));
      return;
    }
    const up = http.get({ host: "127.0.0.1", port: engine.chromePort, path: req.url, headers: { accept: req.headers.accept || "*/*" } }, r => {
      res.writeHead(r.statusCode || 502, { "content-type": r.headers["content-type"] || "application/octet-stream", "cache-control": "max-age=3600" });
      r.pipe(res);
    });
    up.on("error", e => json(502, { error: e.message }));
    return;
  }
  if (req.headers["x-cb-token"] !== TOKEN) return json(401, { error: "bad token" });

  if (req.method === "POST" && url.pathname === "/api/tool") {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", async () => {
      try {
        const { name, args } = JSON.parse(body || "{}");
        const content = await engine.tool(name, args || {});
        json(200, { content });
      } catch (e) {
        log("tool error", e.message);
        json(200, { content: [{ type: "text", text: `Error: ${e.message.split("\n")[0]}` }], isError: true });
      }
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/shutdown") {
    json(200, { ok: true });
    shutdown();
    return;
  }
  json(404, { error: "not found" });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
const cdpWss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024, perMessageDeflate: false });
const WebSocket = require("ws");

const DEVTOOLS_BLOCKED = new Set([
  "Emulation.clearDeviceMetricsOverride",
  "Emulation.setDeviceMetricsOverride",
  "Emulation.setVisibleSize",
  "Emulation.resetPageScaleFactor",
  "Emulation.setPageScaleFactor",
]);

// Open DevTools connections per target, so the engine can speak as DevTools.
const devtoolsUpstreams = new Map();

function proxyCdp(client, targetId) {
  const upstream = new WebSocket(`ws://127.0.0.1:${engine.chromePort}/devtools/page/${targetId}`, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  if (!devtoolsUpstreams.has(targetId)) devtoolsUpstreams.set(targetId, new Set());
  devtoolsUpstreams.get(targetId).add(upstream);
  const queue = [];
  upstream.on("open", () => {
    for (const [d, b] of queue) upstream.send(d, { binary: b });
    queue.length = 0;
  });
  upstream.on("message", (d, b) => {
    // Replies to the engine's own requests are not DevTools' business.
    if (!b && d.length < 4096 && d.toString().startsWith('{"id":9000')) return;
    if (client.readyState === 1) client.send(d, { binary: b });
  });
  client.on("message", (d, b) => {
    // DevTools resets device metrics when it attaches (and on tab switches the
    // panel re-attaches it), which drops the panel-sized viewport back to the
    // window size. The panel owns the viewport: answer those calls ourselves.
    if (!b) {
      try {
        const msg = JSON.parse(d.toString());
        if (msg && DEVTOOLS_BLOCKED.has(msg.method)) {
          log("devtools: ignored", msg.method);
          const reply = { id: msg.id, result: {} };
          if (msg.sessionId) reply.sessionId = msg.sessionId;
          if (client.readyState === 1) client.send(JSON.stringify(reply));
          return;
        }
      } catch {}
    }
    if (upstream.readyState === 1) upstream.send(d, { binary: b });
    else queue.push([d, b]);
  });
  const close = () => {
    const set = devtoolsUpstreams.get(targetId);
    if (set) set.delete(upstream);
    try { client.close(); } catch {}
    try { upstream.close(); } catch {}
  };
  upstream.on("close", close);
  upstream.on("error", e => { log("devtools proxy", e.message); close(); });
  client.on("close", close);
  client.on("error", close);
}

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  const cdpMatch = /^\/cdp\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (cdpMatch) {
    if (cdpMatch[1] !== TOKEN || !engine.chromePort) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    cdpWss.handleUpgrade(req, socket, head, client => proxyCdp(client, cdpMatch[2]));
    return;
  }
  if (url.pathname !== "/ws" || url.searchParams.get("token") !== TOKEN) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => engine.addClient(ws, url.searchParams.get("role")));
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down");
  engine.expectedStop = true;
  try {
    fs.rmSync(PID_FILE, { force: true });
  } catch {}
  try {
    // In Cursor mode, close() would quit Cursor: only let go of it.
    if (engine.browser) await withTimeout(CURSOR_MODE ? engine.browser.disconnect() : engine.browser.close(), 4000, "close");
  } catch {}
  engine.killChrome();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("unhandledRejection", e => log("unhandledRejection", e));
process.on("uncaughtException", e => log("uncaughtException", e));

setInterval(() => {
  if (!engine.clients.size && Date.now() - engine.lastActivity > IDLE_EXIT_MS) shutdown();
}, 60 * 1000).unref();

let watching = false;
setInterval(() => {
  if (watching || shuttingDown) return;
  watching = true;
  engine
    .watchdog()
    .catch(e => log("watchdog", e.message))
    .finally(() => (watching = false));
}, 5000).unref();

server.on("error", e => {
  if (e.code === "EADDRINUSE") {
    log(`port ${PORT} already in use — another engine is running`);
    process.exit(0);
  }
  log("server error", e);
  process.exit(1);
});
server.listen(PORT, "127.0.0.1", () => {
  try {
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch {}
  log(`claude-browser engine ${VERSION} listening on 127.0.0.1:${PORT} (pid ${process.pid})`);
});

// Claude Browser — editor side. Hosts the viewer panel, starts the shared engine,
// and turns element picks into Claude Code prompt context.
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { ensureEngine, stopEngine, writeConfig, LOG_FILE, HOME } = require("./daemon/launcher.js");

const VIEW_TYPE = "claudeBrowser.panel";

// A small log of what the editor side does (bridge, picks, mentions), next to
// the engine's own log, for troubleshooting.
const EXT_LOG = path.join(HOME, "extension.log");
function xlog(...parts) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    if (fs.existsSync(EXT_LOG) && fs.statSync(EXT_LOG).size > 512 * 1024) fs.renameSync(EXT_LOG, EXT_LOG + ".1");
    const text = parts.map(p => (p instanceof Error ? p.stack || p.message : typeof p === "string" ? p : JSON.stringify(p))).join(" ");
    fs.appendFileSync(EXT_LOG, `[${new Date().toISOString()}] ${text}\n`);
  } catch {}
}
let panel = null;
let engine = null;
let ensuring = null;
let extCtx = null;

function cfg() {
  return vscode.workspace.getConfiguration("claudeBrowser");
}

// Prefer a real Node; fall back to the editor's own runtime.
function nodeRuntime() {
  const custom = cfg().get("nodePath");
  const candidates = [custom, "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return { nodePath: c, env: {} };
  try {
    const p = execFileSync(process.env.SHELL || "/bin/zsh", ["-lc", "command -v node"], { encoding: "utf8", timeout: 4000 }).trim();
    if (p && fs.existsSync(p)) return { nodePath: p, env: {} };
  } catch {}
  return { nodePath: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

async function getEngine(force) {
  if (engine && !force) return engine;
  if (!ensuring) {
    const { nodePath, env } = nodeRuntime();
    syncConfig();
    ensuring = ensureEngine({ port: cfg().get("port"), nodePath, env })
      .then(e => (engine = e))
      .finally(() => (ensuring = null));
  }
  return ensuring;
}

// The engine reads its settings from a file, because the MCP server (which has
// no access to editor settings) may be the one that starts it.
function syncConfig() {
  const c = cfg();
  const custom = (c.get("chromePath") || "").trim();
  return writeConfig({ homeUrl: (c.get("homeUrl") || "").trim(), browser: custom || c.get("browser") || "auto", mode: mode(), cursorPort: CURSOR_PORT });
}

const CURSOR_PORT = 9333;
function mode() {
  const m = cfg().get("mode");
  return m === "window" || m === "cursor" ? m : "panel";
}

// Window and Cursor modes both drive a natively drawn browser through the bridge.
function windowMode() {
  return mode() !== "panel";
}

// Cursor mode needs Cursor started with --remote-debugging-port.
async function cursorReachable() {
  try {
    const r = await fetch(`http://127.0.0.1:${CURSOR_PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

// Quit this Cursor and start it again with the debugging port. Cursor restores
// its windows and unsaved files as on any normal quit.
// On quit Cursor kills the extension host's whole child tree (walked by parent
// pid), so a plain detached child dies with it and nothing relaunches. The
// outer shell backgrounds the real script and exits at once: the script is
// adopted by launchd before the quit starts and ignores HUP/TERM.
function restartCursorWithControl() {
  const bundle = path.resolve(vscode.env.appRoot, "..", "..", "..");
  if (process.platform !== "darwin" || !bundle.endsWith(".app")) {
    return vscode.window.showErrorMessage(`Claude Browser: start ${vscode.env.appName} yourself with --remote-debugging-port=${CURSOR_PORT}`);
  }
  const q = s => `'${s.replace(/'/g, "'\\''")}'`;
  const log = path.join(path.dirname(LOG_FILE), "restart.log");
  const running = `pgrep -f ${q(bundle + "/Contents/MacOS/")} >/dev/null`;
  const script = [
    "trap '' HUP TERM",
    `exec >${q(log)} 2>&1`,
    "set -x",
    "sleep 1",
    `osascript -e ${q(`tell application "${bundle}" to quit`)}`,
    `for i in $(seq 1 240); do ${running} || break; sleep 0.5; done`,
    `if ${running}; then echo 'still running, not relaunching'; exit 1; fi`,
    "sleep 0.5",
    `open -a ${q(bundle)} --args --remote-debugging-port=${CURSOR_PORT}`,
  ].join("\n");
  try {
    fs.mkdirSync(path.dirname(log), { recursive: true });
  } catch {}
  // The extension host runs with ELECTRON_RUN_AS_NODE=1 (and other VSCODE_*
  // vars); `open` hands the caller's environment to the app, so Cursor would
  // start as plain Node and exit at once. Start from a clean environment.
  const env = {};
  for (const k of ["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG", "SHELL"]) if (process.env[k]) env[k] = process.env[k];
  require("child_process")
    .spawn("/bin/sh", ["-c", `/bin/sh -c ${q(script)} </dev/null >/dev/null 2>&1 &`], { detached: true, stdio: "ignore", env })
    .unref();
}

async function offerCursorRestart() {
  if (mode() !== "cursor" || (await cursorReachable())) return;
  const go = "Restart Cursor";
  const a = await vscode.window.showInformationMessage(
    `Claude Browser drives Cursor's own Browser Tab, which needs Cursor started with browser control (--remote-debugging-port=${CURSOR_PORT}). Restart Cursor now? Open windows and unsaved files come back.`,
    go
  );
  if (a === go) restartCursorWithControl();
}

// ---------- window mode: Chrome is its own window ----------
// A light connection to the engine that receives picks made in the Chrome
// window (and tells the engine which Cursor window was focused last).
let bridge = null; // { ws, id }
let bridgeTimer = null;
function connectBridge() {
  if (!windowMode() || (bridge && bridge.ws.readyState <= 1)) return;
  clearTimeout(bridgeTimer);
  getEngine()
    .then(e => {
      const WebSocket = require("ws");
      const ws = new WebSocket(`ws://127.0.0.1:${e.port}/ws?token=${encodeURIComponent(e.token)}&role=bridge`);
      const b = { ws, id: null, queue: [] };
      bridge = b;
      ws.on("open", () => {
        if (vscode.window.state.focused) ws.send(JSON.stringify({ t: "focus" }));
        for (const m of b.queue.splice(0)) ws.send(JSON.stringify(m));
      });
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (msg.t === "hello") {
          b.id = msg.id;
          xlog("bridge connected", b.id);
        } else if (msg.t === "picked") {
          xlog("picked", msg.kind || "element", msg.id || "", msg.requester === b.id ? "for this window" : `for ${msg.requester} (this window is ${b.id})`);
          if (msg.requester === b.id) onPick(msg).catch(err => xlog("pick failed", err));
        }
        else if (msg.t === "openCursorBrowser") {
          // The engine sends this to one window only (the one focused last).
          vscode.commands.executeCommand("workbench.action.openBrowserEditor", { url: msg.url, inactive: !!msg.background }).then(undefined, err => console.error("[claude-browser]", err));
        } else if (msg.t === "toast" && msg.text && vscode.window.state.focused) vscode.window.setStatusBarMessage(`Claude Browser: ${msg.text}`, 5000);
      });
      ws.on("close", () => {
        if (bridge === b) bridge = null;
        // The engine exited (idle or restart): come back while window mode is on.
        if (windowMode()) bridgeTimer = setTimeout(() => {
          engine = null;
          connectBridge();
        }, 3000);
      });
      ws.on("error", () => {});
    })
    .catch(() => {
      if (windowMode()) bridgeTimer = setTimeout(connectBridge, 10000);
    });
}

function disconnectBridge() {
  clearTimeout(bridgeTimer);
  if (bridge) {
    const b = bridge;
    bridge = null;
    try {
      b.ws.close();
    } catch {}
  }
}

function bridgeSend(msg) {
  connectBridge();
  const b = bridge;
  if (!b) return setTimeout(() => bridge && bridgeSend(msg), 500);
  if (b.ws.readyState === 1) b.ws.send(JSON.stringify(msg));
  else b.queue.push(msg);
}

async function restartEngine() {
  await stopEngine(cfg().get("port"));
  engine = null;
  if (panel) await sendConfig(panel, true);
  else await getEngine(true);
}

function html(webview, port) {
  const media = vscode.Uri.joinPath(extCtx.extensionUri, "media");
  const base = webview.asWebviewUri(media).toString() + "/";
  const nonce = crypto.randomBytes(16).toString("base64");
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `connect-src ws://127.0.0.1:${port} http://127.0.0.1:${port}`,
    `frame-src http://127.0.0.1:${port}`,
  ].join("; ");
  return fs
    .readFileSync(path.join(media.fsPath, "panel.html"), "utf8")
    .replace("<!--CSP-->", `<meta http-equiv="Content-Security-Policy" content="${csp}">`)
    .replace("<!--BASE-->", `<base href="${base}">`)
    .replace("<!--CONFIG-->", `<script nonce="${nonce}">window.CB_CONFIG = ${JSON.stringify({ port })};</script>`)
    .replace('<script src="panel.js">', `<script nonce="${nonce}" src="panel.js">`);
}

function setupPanel(p) {
  panel = p;
  const port = cfg().get("port");
  p.iconPath = vscode.Uri.joinPath(extCtx.extensionUri, "media", "icon.svg");
  p.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extCtx.extensionUri, "media")] };
  p.webview.html = html(p.webview, port);
  p.onDidDispose(() => {
    if (panel === p) panel = null;
  });
  p.webview.onDidReceiveMessage(msg => onPanelMessage(p, msg).catch(e => console.error("[claude-browser]", e)));
}

async function sendConfig(p, force) {
  try {
    const e = await getEngine(force);
    p.webview.postMessage({ type: "config", port: e.port, token: e.token });
  } catch (err) {
    vscode.window.showErrorMessage(`Claude Browser: ${err.message}`, "Open log").then(a => {
      if (a) vscode.window.showTextDocument(vscode.Uri.file(LOG_FILE));
    });
  }
}

let downTimer = null;
async function onPanelMessage(p, msg) {
  switch (msg.type) {
    case "ready":
      return sendConfig(p, false);
    case "engineDown":
      // Engine exited (idle/crash): restart it, at most every few seconds.
      if (downTimer) return;
      downTimer = setTimeout(() => (downTimer = null), 3000);
      return sendConfig(p, true);
    case "engineStuck":
      // The engine holds its port but no longer answers: replace it.
      if (downTimer) return;
      downTimer = setTimeout(() => (downTimer = null), 5000);
      return restartEngine();
    case "external":
      if (/^https?:/i.test(msg.url || "")) await vscode.env.openExternal(vscode.Uri.parse(msg.url));
      return;
    case "clipboard":
      return vscode.env.clipboard.writeText(msg.text || "");
    case "nav":
      p.title = msg.title ? `Browser · ${msg.title}`.slice(0, 40) : "Browser";
      return;
    case "picked":
      return onPick(msg.pick);
    case "openFiles": {
      const uris = await vscode.window.showOpenDialog({ canSelectMany: !!msg.multiple, openLabel: "Upload" });
      p.webview.postMessage({ type: "files", paths: (uris || []).map(u => u.fsPath) });
      return;
    }
    case "reveal":
      if (msg.path) await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(msg.path));
      return;
  }
}

// ---------- picks → Claude Code ----------
function resolveSource(src) {
  const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(src || "");
  if (!m) return null;
  const [, file, line, col] = m;
  if (/node_modules/.test(file)) return null;
  const candidates = path.isAbsolute(file) ? [file] : (vscode.workspace.workspaceFolders || []).map(f => path.join(f.uri.fsPath, file));
  const hit = candidates.find(c => fs.existsSync(c));
  return hit ? { file: hit, line: Number(line), col: Number(col || 1) } : null;
}

// ---------- which Claude Code session gets the pick ----------
// claude-vscode.insertAtMention delivers to every *visible* Claude session and,
// when none is visible, reveals the one opened last, which is not necessarily
// the one you are working in. So remember the session tab you last used and
// keep it visible while the mention is inserted.
const isClaudeTab = tab => !!tab && tab.input instanceof vscode.TabInputWebview && /claudeVSCodePanel$/.test(tab.input.viewType);
let lastClaudeTab = null; // { tab, label, viewColumn }

function trackClaudeTab() {
  const g = vscode.window.tabGroups.activeTabGroup;
  if (g && isClaudeTab(g.activeTab)) lastClaudeTab = { tab: g.activeTab, label: g.activeTab.label, viewColumn: g.viewColumn };
}

function findClaudeTab() {
  const all = vscode.window.tabGroups.all.flatMap(g => g.tabs.filter(isClaudeTab));
  if (!all.length) return null;
  if (lastClaudeTab) {
    const hit =
      all.find(t => t === lastClaudeTab.tab) ||
      all.find(t => t.label === lastClaudeTab.label && t.group.viewColumn === lastClaudeTab.viewColumn) ||
      all.find(t => t.label === lastClaudeTab.label);
    if (hit) return hit;
  }
  // Never used one in this window yet: a visible one, else the active one in its group.
  return all.find(t => t.group.activeTab === t && t.group.isActive) || all.find(t => t.group.activeTab === t) || null;
}

// Cursor mode: Cursor's own Browser Tab showing the page a pick came from.
// It's no text, notebook or terminal editor, and its label is the page title.
function findBrowserTab(title) {
  if (mode() !== "cursor" || !title) return null;
  const known = t =>
    [vscode.TabInputText, vscode.TabInputTextDiff, vscode.TabInputNotebook, vscode.TabInputNotebookDiff, vscode.TabInputTerminal, vscode.TabInputCustom].some(C => C && t.input instanceof C);
  const all = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => t.label === title && !known(t) && !isClaudeTab(t));
  return all.find(t => t.group.activeTab === t) || all[0] || null;
}

const FOCUS_GROUP = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth"];
async function revealTab(tab) {
  const g = tab.group;
  if (g.activeTab === tab) return true;
  const name = FOCUS_GROUP[g.viewColumn - 1];
  const index = g.tabs.indexOf(tab);
  if (!name || index < 0) return false;
  await vscode.commands.executeCommand(`workbench.action.focus${name}EditorGroup`);
  await vscode.commands.executeCommand("workbench.action.openEditorAtIndex", index);
  return tab.group.activeTab === tab || vscode.window.tabGroups.all.some(x => x.activeTab && isClaudeTab(x.activeTab) && x.activeTab.label === tab.label);
}

// Move the workbench's focus to the Claude prompt (its editor tab or side bar
// view). insertAtMention only posts the mention into Claude's webview and
// leaves focus in the source file we opened to make the selection.
async function focusClaude(session) {
  const run = (cmd, ...a) => vscode.commands.executeCommand(cmd, ...a).then(() => true, () => false);
  const tab = session && findClaudeTab();
  if (tab) {
    const name = FOCUS_GROUP[tab.group.viewColumn - 1];
    const index = tab.group.tabs.indexOf(tab);
    if (name && index >= 0) {
      await run(`workbench.action.focus${name}EditorGroup`);
      await run("workbench.action.openEditorAtIndex", index);
    }
  } else if (!(await run("claudeVSCodeSidebarSecondary.focus"))) {
    await run("claudeVSCodeSidebar.focus");
  }
  // claude-vscode.focus puts the cursor in the prompt, but it also mentions the
  // active editor's selection: only call it once no text editor holds one.
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.selection.isEmpty) await run("claude-vscode.focus");
}

// Set after a pick made while Cursor was in the background; see onPick.
let pendingRefocus = null;
async function replayFocus() {
  const p = pendingRefocus;
  pendingRefocus = null;
  if (!p || Date.now() - p.at > 15 * 60 * 1000) return;
  const ed = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === p.uri);
  if (!ed) return;
  // Only when focus is still where the pick left it: the Claude tab is the
  // active editor or, with Claude in the side bar, the picked file is. (Cursor
  // keeps reporting the last text editor as activeTextEditor while a webview
  // editor is active, so the tab groups are what tell.)
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const stillThere = p.session ? isClaudeTab(tab) : !!tab && tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === p.uri;
  if (!stillThere) return;
  await vscode.window.showTextDocument(ed.document, { viewColumn: ed.viewColumn, preserveFocus: false, preview: true });
  await focusClaude(p.session);
}

// ---------- pick cards → Claude Code ----------
// A pick is a few lines of text (what the element is, where it is, its source
// line when known). Claude Code's extension can only @-mention files, so the
// card is written to a small file and that file is mentioned: it works for any
// site and any project, in VS Code and Cursor, with no tool call.
const PICKS_DIR = path.join(os.homedir(), ".claude-browser", "picks");

function writePickFile(name, text) {
  fs.mkdirSync(PICKS_DIR, { recursive: true });
  const file = path.join(PICKS_DIR, name);
  fs.writeFileSync(file, text.endsWith("\n") ? text : text + "\n");
  // Keep the last 40.
  try {
    const all = fs.readdirSync(PICKS_DIR).map(f => ({ f, t: fs.statSync(path.join(PICKS_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { f } of all.slice(40)) fs.rmSync(path.join(PICKS_DIR, f), { force: true });
  } catch {}
  return file;
}

async function mentionFile(file) {
  const session = findClaudeTab();
  if (session) await revealTab(session).catch(() => false);
  await vscode.commands.executeCommand("claude-vscode.addToChat", vscode.Uri.file(file));
  await focusClaude(session);
  return session;
}

async function deliverPickCard(pick, mode) {
  if (mode === "clipboard" || mode === "both") await vscode.env.clipboard.writeText(pick.report);
  if (mode !== "mention" && mode !== "both") {
    vscode.window.setStatusBarMessage("$(target) Pick copied — paste it into the Claude prompt", 4000);
    return;
  }
  const file = writePickFile(`pick-${pick.id || Date.now()}.md`, pick.report);
  xlog("pick card written", file);
  try {
    const session = await mentionFile(file);
    xlog("pick mentioned in Claude Code", session ? session.label : "");
    vscode.window.setStatusBarMessage(`$(target) Pick ${pick.id || ""} added to the Claude prompt${session ? ` (${session.label})` : ""}`, 4000);
  } catch (err) {
    xlog("mention failed, copied instead", err);
    await vscode.env.clipboard.writeText(pick.report);
    vscode.window.setStatusBarMessage("$(target) Claude Code isn't available — pick copied to the clipboard instead", 5000);
  }
}

async function onPick(pick) {
  const mode = cfg().get("onPick");
  const chain = (pick && pick.chain) || [];
  const isErrors = pick && pick.kind === "errors";
  const isShot = pick && pick.kind === "annotation";
  if (!isErrors && !isShot) return deliverPickCard(pick, mode);
  // If the DOM element is written inside the definition of the component
  // right above it (e.g. <p> inside Typography.tsx), the useful place is
  // where that component is used.
  let start = 0;
  if (chain.length > 1 && chain[0].name.startsWith("<") && chain[0].src) {
    const file = path.basename(chain[0].src.split(":")[0]).replace(/\.[jt]sx?$/, "");
    if (file === chain[1].name && chain[1].src) start = 1;
  }
  let target = null;
  let name = "";
  // The engine marks the usage outside shared components (pick.target); try it first.
  const order = Number.isInteger(pick && pick.target) && pick.target >= 0 && chain[pick.target]
    ? [chain[pick.target], ...chain.filter((_, i) => i !== pick.target)]
    : [...chain.slice(start), ...chain.slice(0, start)];
  for (const c of order) {
    target = resolveSource(c.src);
    if (target) {
      name = c.name;
      break;
    }
  }

  // No source line to mention: hand Claude the report itself as a file.
  if (!target && (mode === "mention" || mode === "both")) {
    if (!isShot && mode === "both") await vscode.env.clipboard.writeText(pick.report);
    try {
      await mentionFile(writePickFile(`${isShot ? "marks" : "errors"}-${Date.now()}.md`, pick.report));
      vscode.window.setStatusBarMessage(isShot ? "$(device-camera) Marked area added to the Claude prompt — the screenshot is on the clipboard too (⌘V)" : "$(bug) Error report added to the Claude prompt", 5000);
      return;
    } catch {}
  }
  // An annotated screenshot is already on the clipboard as an image: keep it there.
  if (!isShot && (mode === "clipboard" || mode === "both" || !target)) {
    await vscode.env.clipboard.writeText(pick.report);
  }

  if ((mode === "mention" || mode === "both") && target) {
    const doc = await vscode.workspace.openTextDocument(target.file);
    const session = findClaudeTab();
    let sessionCol;
    if (session) {
      await revealTab(session).catch(() => false);
      sessionCol = session.group.viewColumn;
    }
    // Open the source in a group that hides neither the session nor the browser;
    // with only those two groups, borrow the browser's and bring it back after.
    const browserTab = !panel && findBrowserTab(pick.title);
    const panelCol = (panel && panel.viewColumn) || (browserTab && browserTab.group.viewColumn);
    const groups = vscode.window.tabGroups.all.map(g => g.viewColumn);
    let column = groups.find(c => c !== sessionCol && c !== panelCol);
    let restorePanel = false;
    if (!column) {
      if (sessionCol && panelCol && panelCol !== sessionCol) {
        column = panelCol;
        restorePanel = true;
      } else if (sessionCol) {
        column = vscode.ViewColumn.Beside;
      } else {
        column = panelCol === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
      }
    }
    const wasOpen = vscode.window.tabGroups.all.some(g => g.viewColumn === column && g.tabs.some(t => t.input instanceof vscode.TabInputText && t.input.uri.toString() === doc.uri.toString()));
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: column, preserveFocus: false, preview: true });
    const lineIdx = Math.max(0, Math.min(doc.lineCount - 1, target.line - 1));
    const text = doc.lineAt(lineIdx).text;
    const start = new vscode.Position(lineIdx, Math.min(text.length, Math.max(0, target.col - 1)));
    const end = new vscode.Position(lineIdx, text.length);
    editor.selection = new vscode.Selection(start, end);
    editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    try {
      await vscode.commands.executeCommand("claude-vscode.insertAtMention");
      if (restorePanel && panel) panel.reveal(panelCol, true);
      else if (restorePanel && browserTab && !wasOpen) {
        // Cursor can't switch to its Browser Tab by index; closing the source
        // file we just opened brings back what was in front before: the browser.
        const opened = vscode.window.tabGroups.all
          .flatMap(g => g.tabs)
          .find(t => t.input instanceof vscode.TabInputText && t.input.uri.toString() === doc.uri.toString() && t.group.viewColumn === column);
        if (opened) await vscode.window.tabGroups.close(opened, true).then(undefined, () => {});
      }
      await focusClaude(session);
      // Cursor is in the background during a window-mode pick (the click was in
      // Chrome). Focusing the source editor then marks Monaco focused without a
      // real focus event, and moving focus to Claude fires no blur, so the file
      // keeps its blinking caret and gets ⌘V / ⌘A even after you click the
      // prompt. Replay the focus change once Cursor is in front again.
      pendingRefocus = vscode.window.state.focused ? null : { uri: doc.uri.toString(), session: !!session, at: Date.now() };
      vscode.window.setStatusBarMessage(isShot ? `$(device-camera) Marked area added to the Claude prompt at ${path.basename(target.file)}:${target.line} — the screenshot is on the clipboard too (⌘V)` : isErrors ? `$(bug) ${pick.count > 1 ? `${pick.count} errors` : "Error"} added to the Claude prompt at ${path.basename(target.file)}:${target.line}${session ? ` (${session.label})` : ""}` : `$(target) ${name} added to the Claude prompt${session ? ` (${session.label})` : ""}`, 4000);
    } catch {
      vscode.window.setStatusBarMessage(`$(target) ${name} selected — Claude Code command not available`, 4000);
    }
  } else if (isShot) {
    vscode.window.setStatusBarMessage("$(device-camera) Annotated screenshot copied — paste it into the Claude prompt (⌘V); Claude gets the marked elements from the browser", 6000);
  } else if (!target) {
    vscode.window.setStatusBarMessage(isErrors ? "$(bug) Error report copied (no source line in this workspace) — paste it into the Claude prompt" : "$(target) Element report copied (no source location in this workspace) — paste it, or ask Claude to read the pick", 5000);
  } else {
    vscode.window.setStatusBarMessage("$(target) Element report copied — paste it into the Claude prompt", 4000);
  }
}

// ---------- commands ----------
async function openPanel() {
  if (panel) {
    panel.reveal(undefined, false);
    return panel;
  }
  const p = vscode.window.createWebviewPanel(VIEW_TYPE, "Browser", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(extCtx.extensionUri, "media")],
  });
  setupPanel(p);
  return p;
}

// ---------- MCP registration with Claude Code ----------
// Claude Code is pointed at a small file in ~/.claude-browser that loads the
// MCP server of whatever version is installed, so the registration survives
// extension updates (each version lives in its own folder).
const MCP_SHIM = path.join(HOME, "mcp-server.js");
function writeMcpShim(extPath) {
  const body = `// Written by the Claude Browser extension: runs the MCP server of the installed version.\n"use strict";\nrequire(${JSON.stringify(path.join(extPath, "mcp", "server.js"))});\n`;
  try {
    fs.mkdirSync(HOME, { recursive: true });
    if (!fs.existsSync(MCP_SHIM) || fs.readFileSync(MCP_SHIM, "utf8") !== body) fs.writeFileSync(MCP_SHIM, body);
  } catch (e) {
    console.error("[claude-browser]", e);
  }
}

// The `claude` CLI: on PATH, else the one bundled with the Claude Code extension.
function claudeCli() {
  try {
    const p = execFileSync(process.env.SHELL || "/bin/zsh", ["-lc", "command -v claude"], { encoding: "utf8", timeout: 4000 }).trim();
    if (p && fs.existsSync(p)) return p;
  } catch {}
  const ext = vscode.extensions.getExtension("anthropic.claude-code");
  if (ext) {
    for (const rel of ["resources/native-binary/claude", "resources/native-binary/claude.exe"]) {
      const p = path.join(ext.extensionPath, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return "claude";
}

function mcpRegistered() {
  try {
    const conf = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
    return !!(conf.mcpServers && conf.mcpServers["claude-browser"]);
  } catch {
    return false;
  }
}

function registerMcp() {
  const { nodePath } = nodeRuntime();
  const cli = claudeCli();
  const q = s => (process.platform === "win32" ? `"${s}"` : `'${s.replace(/'/g, "'\\''")}'`);
  const t = vscode.window.createTerminal("Claude Browser MCP");
  t.show();
  const rm = process.platform === "win32" ? `& ${q(cli)} mcp remove --scope user claude-browser 2>$null; & ` : `${q(cli)} mcp remove --scope user claude-browser >/dev/null 2>&1; `;
  t.sendText(`${rm}${q(cli)} mcp add --scope user claude-browser -- ${q(nodePath)} ${q(MCP_SHIM)}`);
  vscode.window.showInformationMessage("Claude Browser: registered with Claude Code. Start a new Claude Code session to get the browser_* tools.");
}

async function offerMcpRegistration(context) {
  if (mcpRegistered() || context.globalState.get("mcpOfferDismissed")) return;
  const yes = "Register";
  const never = "Don't ask again";
  const a = await vscode.window.showInformationMessage(
    "Claude Browser: register its browser tools with Claude Code (user scope, every project)? Claude can then see and drive the same tab you do.",
    yes,
    never
  );
  if (a === yes) registerMcp();
  else if (a === never) context.globalState.update("mcpOfferDismissed", true);
}

function activate(context) {
  extCtx = context;
  xlog("activate", require("./package.json").version, vscode.env.appName, `mode=${mode()}`);
  writeMcpShim(context.extensionPath);
  setTimeout(() => offerMcpRegistration(context).catch(() => {}), 3000);
  trackClaudeTab();
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(trackClaudeTab), vscode.window.tabGroups.onDidChangeTabGroups(trackClaudeTab));

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeBrowser.open", async url => {
      if (windowMode()) return bridgeSend({ t: "show", url: typeof url === "string" ? url : undefined });
      const p = await openPanel();
      if (typeof url === "string" && url) p.webview.postMessage({ type: "navigate", url });
      return p;
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration("claudeBrowser")) return;
      if (e.affectsConfiguration("claudeBrowser.mode")) {
        // Headless vs a visible window is a different Chrome start: restart now.
        syncConfig();
        disconnectBridge();
        if (windowMode() && panel) panel.dispose();
        restartEngine()
          .then(() => {
            if (windowMode()) {
              connectBridge();
              bridgeSend({ t: "show" });
            }
            vscode.window.setStatusBarMessage(`Claude Browser: ${mode()} mode`, 4000);
            offerCursorRestart();
          })
          .catch(err => vscode.window.showErrorMessage(`Claude Browser: ${err.message}`));
        return;
      }
      if (syncConfig()) vscode.window.setStatusBarMessage("Claude Browser: setting saved, applies after “Restart Browser Engine”", 5000);
    }),
    vscode.commands.registerCommand("claudeBrowser.pick", async () => {
      if (windowMode()) return bridgeSend({ t: "pick", on: true });
      const p = await openPanel();
      p.webview.postMessage({ type: "pick", on: true });
    }),
    vscode.commands.registerCommand("claudeBrowser.multi", async () => {
      if (windowMode()) return bridgeSend({ t: "multiToggle" });
      await openPanel();
      vscode.window.setStatusBarMessage("Claude Browser: use the side-by-side button (three bars) in the panel toolbar", 4000);
    }),
    vscode.commands.registerCommand("claudeBrowser.restartDaemon", async () => {
      try {
        await restartEngine();
        vscode.window.setStatusBarMessage("Claude Browser engine restarted", 3000);
      } catch (err) {
        vscode.window.showErrorMessage(`Claude Browser: ${err.message}`);
      }
    }),
    vscode.commands.registerCommand("claudeBrowser.restartCursor", restartCursorWithControl),
    vscode.commands.registerCommand("claudeBrowser.registerMcp", registerMcp),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(p) {
        if (windowMode()) return p.dispose();
        setupPanel(p);
      },
    })
  );

  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.text = "$(globe) Browser";
  item.tooltip = "Open Claude Browser (shared with Claude Code)";
  item.command = "claudeBrowser.open";
  item.show();
  context.subscriptions.push(item);

  // Window mode: listen for picks from the Chrome window from the start.
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState(st => {
      if (st.focused && bridge && bridge.ws.readyState === 1) bridge.ws.send(JSON.stringify({ t: "focus" }));
      if (st.focused && pendingRefocus) replayFocus().catch(err => console.error("[claude-browser]", err));
    }),
    { dispose: disconnectBridge }
  );
  if (windowMode()) {
    syncConfig();
    connectBridge();
    offerCursorRestart();
  }
}

function deactivate() {}

module.exports = { activate, deactivate };

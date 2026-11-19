// Claude Browser toolbar for window mode (Chrome as a visible window).
// Injected into every document of every tab, but only the top frame shows it:
// a small floating bar over the page, or the toolbar row of the side-by-side
// view (a document marked with <meta name="cb-shell">). It lives in a closed
// shadow root in the top layer, so the page's CSS and z-indexes can't reach it.
// Talks to the engine through the exposed binding `__cbEmit(json)`, which
// returns the engine's answer.
(() => {
  if (!window.__cbWindowMode || window.__cbUi) return;
  try {
    if (window.top !== window) return;
  } catch {
    return;
  }

  const send = msg => {
    try {
      if (typeof window.__cbEmit !== "function") return Promise.resolve(null);
      return Promise.resolve(window.__cbEmit(JSON.stringify({ t: "ui", ...msg })))
        .then(r => (typeof r === "string" && r ? JSON.parse(r) : null))
        .catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  };

  const isMac = /Mac/.test(navigator.platform);
  const ICONS = {
    grip: '<svg viewBox="0 0 16 16" class="fill"><circle cx="6" cy="4" r="1.1"/><circle cx="10" cy="4" r="1.1"/><circle cx="6" cy="8" r="1.1"/><circle cx="10" cy="8" r="1.1"/><circle cx="6" cy="12" r="1.1"/><circle cx="10" cy="12" r="1.1"/></svg>',
    pick: '<svg viewBox="0 0 16 16"><path d="M2.5 2.5h4M2.5 2.5v4M13.5 2.5h-4M13.5 2.5v4M2.5 13.5h3M2.5 13.5v-3M8 7l6 2.2-2.6 1.1L10.3 13 8 7Z"/></svg>',
    annotate: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="8.5" height="7" rx="1" stroke-dasharray="2 1.6"/><path d="M8.5 13.5 14 8M14 8h-3.2M14 8v3.2"/></svg>',
    multi: '<svg viewBox="0 0 16 16"><rect x="1.5" y="5.5" width="3" height="6" rx="0.8"/><rect x="6" y="4" width="4" height="8" rx="0.8"/><rect x="11.5" y="3" width="3" height="10" rx="0.8"/></svg>',
    devtools: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M1.5 9.5h13M4.5 11.5h2"/></svg>',
    shot: '<svg viewBox="0 0 16 16"><path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h1.3l1-1.5h4.4l1 1.5h1.3A1.5 1.5 0 0 1 14 5.5v6A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z"/><circle cx="8" cy="8.5" r="2.3"/></svg>',
    measure: '<svg viewBox="0 0 16 16"><path d="M1.8 10.5 10.5 1.8l3.7 3.7-8.7 8.7z"/><path d="M4.4 7.9l1.4 1.4M6.4 5.9l1 1M8.4 3.9l1.4 1.4"/></svg>',
    phone: '<svg viewBox="0 0 16 16"><rect x="4" y="1.5" width="8" height="13" rx="1.6"/><path d="M7 12.3h2"/></svg>',
    fill: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="9" height="3" rx=".8"/><rect x="1.5" y="8" width="6" height="3" rx=".8"/><path d="M9.5 13.8l.4-1.9 4.2-4.2a1 1 0 0 1 1.5 1.5l-4.2 4.2z"/></svg>',
    sweep: '<svg viewBox="0 0 16 16"><path d="M1.5 3v10M14.5 3v10M3.8 8h3M5.4 6.4 7 8l-1.6 1.6M12.2 8h-3M10.6 6.4 9 8l1.6 1.6"/></svg>',
    play: '<svg viewBox="0 0 16 16" class="fill"><path d="M5 3.2v9.6L12.6 8z"/></svg>',
    pause: '<svg viewBox="0 0 16 16" class="fill"><rect x="4" y="3.2" width="2.8" height="9.6" rx=".6"/><rect x="9.2" y="3.2" width="2.8" height="9.6" rx=".6"/></svg>',
    replay: '<svg viewBox="0 0 16 16"><path d="M3 8a5 5 0 1 0 1.5-3.6M3 2.5v2.4h2.4"/></svg>',
    close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
    more: '<svg viewBox="0 0 16 16"><path d="M3.5 8h.01M8 8h.01M12.5 8h.01" stroke-width="2.2"/></svg>',
    dot: '<svg viewBox="0 0 16 16"><path d="M2.5 2.5h4M2.5 2.5v4M13.5 2.5h-4M13.5 2.5v4M2.5 13.5h3M2.5 13.5v-3M8 7l6 2.2-2.6 1.1L10.3 13 8 7Z"/></svg>',
  };

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .root { font: 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #ececec; direction: ltr; text-align: left; -webkit-font-smoothing: antialiased; }
    .bar { position: fixed; display: flex; align-items: center; gap: 2px; padding: 3px; background: #202022; border: 1px solid #3a3a3d; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.35), 0 1px 3px rgba(0,0,0,.3); pointer-events: auto; user-select: none; -webkit-user-select: none; }
    .bar.docked { left: 0; top: 0; height: 40px; padding: 0 8px; border: 0; border-radius: 0; box-shadow: none; background: transparent; gap: 2px; }
    .sbar { position: fixed; display: none; flex-direction: column; align-items: stretch; gap: 2px; padding: 3px; background: #202022; border: 1px solid #3a3a3d; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.35); pointer-events: auto; user-select: none; -webkit-user-select: none; }
    .sbar.show { display: flex; }
    .sbar .b { width: 26px; height: 26px; }
    .sbar .b svg { width: 15px; height: 15px; }
    .sbar .row { display: flex; align-items: center; justify-content: center; gap: 1px; }
    .sbar .info { display: flex; align-items: baseline; justify-content: center; gap: 6px; padding: 3px 6px 1px; white-space: nowrap; }
    .sbar .w { font: 600 12px/1.2 ui-monospace, Menlo, monospace; color: #fff; font-variant-numeric: tabular-nums; }
    .sbar .dev { font-size: 11.5px; color: #e2876a; }
    .sbar .spd { min-width: 38px; text-align: center; font: 11.5px/1 ui-monospace, Menlo, monospace; color: #c4c4c8; }
    .sbar .pm { font: 600 15px/1 -apple-system, sans-serif; }
    .sbar .b[disabled] { opacity: .35; pointer-events: none; }
    .bar.hidden, .root.capture .sbar, .root.capture .mlayer, .root.capture .bar, .root.capture .pop, .root.capture .abar, .root.capture .toast, .root.capture-all .layer { visibility: hidden !important; }
    button { all: unset; box-sizing: border-box; cursor: default; }
    .b { position: relative; width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; border-radius: 7px; color: #d4d4d8; }
    .b:hover { background: #333337; color: #fff; }
    .b.on { background: #d97757; color: #fff; }
    .b.on:hover { background: #e2876a; }
    .b svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
    .b svg.fill, svg.fill { fill: currentColor; stroke: none; }
    .grip { width: 16px; height: 30px; display: inline-flex; align-items: center; justify-content: center; color: #6b6b70; cursor: grab; }
    .grip:active { cursor: grabbing; }
    .grip svg { width: 14px; height: 14px; }
    .sep { width: 1px; height: 18px; background: #3a3a3d; margin: 0 3px; }
    .errs { height: 22px; min-width: 22px; padding: 0 7px; margin: 0 2px; border-radius: 11px; background: #e5484d; color: #fff; font-weight: 600; font-size: 11.5px; display: none; align-items: center; justify-content: center; }
    .errs.show { display: inline-flex; }
    .errs:hover { background: #f06064; }
    .collapsed { position: fixed; width: 30px; height: 30px; border-radius: 15px; background: #d97757; color: #fff; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 16px rgba(0,0,0,.35); pointer-events: auto; opacity: .75; }
    .collapsed:hover { opacity: 1; }
    .collapsed svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
    .pop { position: fixed; min-width: 230px; max-width: min(560px, calc(100vw - 16px)); max-height: min(70vh, 520px); overflow: auto; background: #252527; border: 1px solid #3a3a3d; border-radius: 9px; padding: 4px; box-shadow: 0 10px 32px rgba(0,0,0,.45); pointer-events: auto; }
    .mi { display: flex; align-items: center; gap: 16px; width: 100%; padding: 6px 10px; border-radius: 6px; white-space: nowrap; }
    .mi:hover { background: #d97757; color: #fff; }
    .mi .hint { margin-left: auto; color: #8a8a90; font-size: 11px; }
    .mi:hover .hint { color: #fff; }
    .mi.checked::before { content: "✓"; width: 10px; margin-left: -4px; }
    .mi:not(.checked)::before { content: ""; width: 10px; margin-left: -4px; }
    .msep { height: 1px; background: #3a3a3d; margin: 4px 6px; }
    .mhead { padding: 6px 10px 4px; color: #8a8a90; font-size: 11px; }
    .erow { display: block; width: 100%; padding: 6px 10px; border-radius: 6px; white-space: normal; }
    .erow:hover { background: #333337; }
    .erow .emsg { color: #ff8a8d; font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; word-break: break-word; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .erow.req .emsg { color: #f5b971; }
    .erow .ewhere { color: #8a8a90; font-size: 11px; margin-top: 2px; }
    .erow.act { color: #ececec; font-weight: 500; }
    .erow.act .emsg { color: inherit; font: inherit; }
    .erow.act:hover { background: #d97757; color: #fff; }
    .toast { position: fixed; max-width: min(520px, calc(100vw - 24px)); padding: 7px 12px; background: #2b2b2e; color: #fff; border: 1px solid #3a3a3d; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.4); opacity: 0; transform: translateY(4px); transition: opacity .15s, transform .15s; pointer-events: none; }
    .toast.show { opacity: 1; transform: none; }
    .layer { position: fixed; inset: 0; pointer-events: auto; cursor: crosshair; }
    .layer svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
    .abar { position: fixed; display: flex; align-items: center; gap: 6px; padding: 5px; background: #202022; border: 1px solid #3a3a3d; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.4); pointer-events: auto; width: min(760px, calc(100vw - 24px)); }
    .chip { padding: 5px 10px; border-radius: 7px; background: #2f2f32; color: #d4d4d8; white-space: nowrap; }
    .chip:hover { background: #3a3a3e; color: #fff; }
    .chip.on { background: #4a4a4f; color: #fff; }
    .chip.primary { background: #d97757; color: #fff; }
    .chip.primary:hover { background: #e2876a; }
    .chip[disabled] { opacity: .45; pointer-events: none; }
    .mlayer { position: fixed; inset: 0; pointer-events: none; }
    .mlayer > div { position: fixed; box-sizing: border-box; pointer-events: none; }
    .mlayer .box { border: 1px solid #0d99ff; }
    .mlayer .box.anchor { border: 1.5px solid #0d99ff; background: rgba(13,153,255,.06); }
    .mlayer .pad { background: rgba(98,200,110,.28); }
    .mlayer .mar { background: rgba(246,166,80,.28); }
    .mlayer .ln { background: #f24822; }
    .mlayer .guide { border: 0 dashed #f24822; opacity: .8; }
    .mlayer .lbl { padding: 1px 5px; border-radius: 4px; background: #f24822; color: #fff; font: 600 11px/16px -apple-system, sans-serif; white-space: nowrap; transform: translate(-50%, -50%); font-variant-numeric: tabular-nums; }
    .mlayer .lbl.size { background: #0d99ff; transform: translate(-50%, 0); }
    .mlayer .lbl.padl { background: #2f9e44; font-size: 10.5px; line-height: 14px; padding: 0 4px; }
    .mlayer .lbl.marl { background: #e8590c; font-size: 10.5px; line-height: 14px; padding: 0 4px; }
    .qrbox { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 10px 10px 6px; width: 236px; white-space: normal; }
    .qrbox .code { width: 196px; height: 196px; border-radius: 6px; overflow: hidden; background: #fff; }
    .qrbox .code svg { width: 100%; height: 100%; display: block; }
    .qrbox .url { font: 11.5px/1.35 ui-monospace, Menlo, monospace; color: #ececec; text-align: center; word-break: break-all; user-select: text; -webkit-user-select: text; }
    .qrbox .hint { color: #8a8a90; font-size: 11px; text-align: center; }
    .qrbox .warn { color: #f5b971; font-size: 11.5px; line-height: 1.4; }
    .abar input { all: unset; flex: 1; min-width: 80px; padding: 5px 8px; background: #151517; border: 1px solid #3a3a3d; border-radius: 7px; color: #fff; font: inherit; }
    .abar input:focus { border-color: #d97757; }
  `;

  let host = null;
  let root = null; // the .root element inside the shadow
  let bar = null;
  let dot = null;
  let pop = null;
  let toastEl = null;
  let sbar = null;
  const sw = {}; // width sweep controls
  const SPEEDS = [0.25, 0.5, 1, 2, 4];
  let state = { picking: false, errors: 0, multi: { on: false }, devtools: false, scheme: "", device: "", prefs: {}, bridge: true };
  const docked = () => !!document.querySelector('meta[name="cb-shell"]');
  const shell = () => window.__cbShell || null;

  // ---------- mounting ----------
  function mount() {
    if (host && host.isConnected) return;
    if (!document.documentElement) return;
    host = document.createElement("cb-browser-ui");
    host.setAttribute("popover", "manual");
    host.style.cssText =
      "all:initial !important; position:fixed !important; inset:0 auto auto 0 !important; width:0 !important; height:0 !important; margin:0 !important; padding:0 !important; border:0 !important; background:transparent !important; overflow:visible !important; display:block !important; pointer-events:none !important; z-index:2147483647 !important;";
    // Clicks and keys on the toolbar are ours: they don't bubble on to the page
    // (whose outside-click handlers would close its menus).
    for (const t of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "touchstart", "touchend", "keydown", "keyup", "keypress", "focusin", "focusout", "wheel"]) host.addEventListener(t, e => e.stopPropagation());
    const sr = host.attachShadow({ mode: "closed" });
    sr.innerHTML = `<style>${CSS}</style><div class="root"></div>`;
    root = sr.querySelector(".root");
    document.documentElement.appendChild(host);
    raise();
    build();
  }

  // The top layer keeps us above the page's own stacking; showing again moves
  // us back to the top after the page opens its own popover or dialog.
  function raise() {
    try {
      if (host.matches(":popover-open")) host.hidePopover();
      host.showPopover();
    } catch {}
  }

  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };

  function button(icon, title, onclick) {
    const b = el("button", "b", ICONS[icon]);
    b.title = title;
    b.onclick = e => {
      e.stopPropagation();
      onclick(b, e);
    };
    return b;
  }

  const btns = {};
  function build() {
    root.replaceChildren();
    bar = el("div", "bar" + (docked() ? " docked" : ""));
    if (!docked()) {
      const grip = el("div", "grip", ICONS.grip);
      grip.title = "Drag to move the toolbar";
      bindDrag(grip);
      bar.append(grip);
    }
    const k = isMac ? "⌥⇧" : "Alt+Shift+";
    btns.pick = button("pick", `Pick an element for Claude (${k}P). While picking: ↑ widens to the parent, ↓ narrows back, Shift-click keeps picking, Esc cancels.`, () => send({ a: "pick", on: !state.picking }));
    btns.annotate = button("annotate", `Mark up the page for Claude: draw rectangles or arrows, add a note, send (${k}S)`, () => setAnnotate(!annot.on));
    btns.multi = button("multi", `Side by side: mobile, tablet and desktop in this tab (${k}M)`, () => send({ a: "multi", on: !(state.multi && state.multi.on) }));
    btns.errors = el("button", "errs");
    btns.errors.onclick = e => {
      e.stopPropagation();
      toggleErrors();
    };
    btns.measure = button("measure", "Measure (or hold ⌥): hover for size, padding and margin; click an element, then hover another for the distance between them. Esc clears.", () => setMeasure(!measure.on));
    btns.phone = button("phone", "Open on my phone: a QR code of this page with localhost swapped for this Mac's network address", b => togglePhone(b));
    btns.fill = button("fill", "Fill this form with test data (the form you used last, else the biggest one on the page)", b => toggleFill(b));
    btns.sweep = button("sweep", "Sweep device sizes: the page goes from the window's size through common laptop, tablet and phone sizes (width and height) down to the first iPhone SE, 320×568", () => send({ a: "sweep", cmd: state.sweep && state.sweep.on ? "stop" : "start" }));
    btns.devtools = button("devtools", `DevTools for this tab — one panel for every pane (${isMac ? "⌥⌘I" : "F12"})`, () => send({ a: "devtools" }));
    btns.shot = button("shot", "Screenshot to the clipboard (also saved in ~/.claude-browser/screenshots)", async () => {
      const r = await send({ a: "screenshot" });
      if (r && r.error) toast(r.error);
      else if (r) toast(r.copied ? "Screenshot copied — paste it into the Claude prompt" : `Screenshot saved: ${r.path}`);
    });
    btns.more = button("more", "More: reload, device size, appearance, clear site data, restart…", b => toggleMenu(b));
    // Cursor mode: its browser toolbar has the DevTools button; ours can't open it there.
    bar.append(btns.pick, btns.annotate, btns.multi, ...(docked() ? [] : [btns.measure, btns.fill, btns.sweep]), btns.phone, el("span", "sep"), btns.errors, ...(window.__cbCursorMode ? [] : [btns.devtools]), btns.shot, btns.more);
    dot = el("button", "collapsed", ICONS.dot);
    dot.title = "Show the Claude Browser toolbar";
    dot.onclick = e => {
      e.stopPropagation();
      setCollapsed(false);
    };
    toastEl = el("div", "toast");
    buildSweep();
    mlayer = el("div", "mlayer");
    root.append(mlayer, bar, sbar, dot, toastEl);
    render();
    place();
  }

  function render() {
    if (!bar) return;
    const multiOn = !!(state.multi && state.multi.on);
    btns.pick.classList.toggle("on", !!state.picking);
    btns.annotate.classList.toggle("on", annot.on);
    btns.multi.classList.toggle("on", multiOn);
    btns.devtools.classList.toggle("on", !!state.devtools);
    renderSweep();
    btns.measure.classList.toggle("on", measure.on);
    const n = state.errors || 0;
    btns.errors.classList.toggle("show", n > 0);
    btns.errors.textContent = n > 99 ? "99+" : String(n);
    btns.errors.title = `${n} error${n === 1 ? "" : "s"} on this page — click to send to Claude`;
    const collapsed = !docked() && !!(state.prefs && state.prefs.collapsed);
    bar.classList.toggle("hidden", collapsed);
    dot.style.display = collapsed ? "flex" : "none";
    if (docked() && shell() && shell().setBarWidth) shell().setBarWidth(bar.offsetWidth);
  }

  // ---------- width sweep controls ----------
  function buildSweep() {
    sbar = el("div", "sbar");
    sbar.addEventListener("pointerdown", e => e.stopPropagation());
    sw.w = el("span", "w");
    sw.w.title = "Page size (CSS px)";
    sw.dev = el("span", "dev");
    sw.play = button("pause", "Pause / resume", () => {
      const s = state.sweep || {};
      send({ a: "sweep", cmd: s.paused || s.done ? "resume" : "pause" });
    });
    sw.replay = button("replay", "Start again from the window's width", () => send({ a: "sweep", cmd: "replay" }));
    sw.slower = button("pause", "Slower", () => setSpeed(-1));
    sw.slower.innerHTML = '<span class="pm">−</span>';
    sw.spd = el("span", "spd");
    sw.spd.title = "Speed (kept for next time)";
    sw.faster = button("pause", "Faster", () => setSpeed(1));
    sw.faster.innerHTML = '<span class="pm">+</span>';
    sw.close = button("close", "Back to the window's width", () => send({ a: "sweep", cmd: "stop" }));
    const info = el("div", "info");
    info.append(sw.w, sw.dev);
    const row = el("div", "row");
    row.append(sw.play, sw.replay, el("span", "sep"), sw.slower, sw.spd, sw.faster, el("span", "sep"), sw.close);
    sbar.append(info, row);
  }

  const speedNow = () => {
    const v = Number(state.prefs && state.prefs.sweepSpeed);
    return SPEEDS.includes(v) ? v : 1;
  };

  function setSpeed(dir) {
    const i = SPEEDS.indexOf(speedNow());
    const v = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, i + dir))];
    state.prefs = { ...(state.prefs || {}), sweepSpeed: v };
    renderSweep();
    send({ a: "sweep", cmd: "speed", speed: v });
  }

  function renderSweep() {
    if (!sbar) return;
    const s = state.sweep || {};
    const on = !!s.on && !docked();
    btns.sweep.classList.toggle("on", on);
    sbar.classList.toggle("show", on);
    if (!on) return;
    sw.play.innerHTML = ICONS[s.paused || s.done ? "play" : "pause"];
    sw.play.title = s.done ? "Start again" : s.paused ? "Resume" : "Pause";
    const v = speedNow();
    sw.spd.textContent = (v === 0.25 ? "¼" : v === 0.5 ? "½" : String(v)) + "×";
    sw.slower.disabled = v === SPEEDS[0];
    sw.faster.disabled = v === SPEEDS[SPEEDS.length - 1];
    sw.w.textContent = `${innerWidth} × ${innerHeight}`;
    sw.dev.textContent = s.label || "";
    placeSweep();
  }

  // Above the toolbar when there's room, else below it.
  function placeSweep() {
    if (!sbar || !sbar.classList.contains("show") || !bar) return;
    const r = bar.getBoundingClientRect();
    const w = sbar.offsetWidth;
    const h = sbar.offsetHeight;
    const left = Math.max(6, Math.min(innerWidth - w - 6, r.left + r.width / 2 - w / 2));
    const top = r.top - h - 6 >= 6 ? r.top - h - 6 : Math.min(innerHeight - h - 6, r.bottom + 6);
    sbar.style.left = Math.round(left) + "px";
    sbar.style.top = Math.round(top) + "px";
  }

  // ---------- position (floating bar) ----------
  function place() {
    if (!bar) return;
    if (docked()) return;
    const p = (state.prefs && state.prefs.pos) || { fx: 0.5, fy: 1 };
    const w = bar.offsetWidth || 260;
    const h = bar.offsetHeight || 38;
    const left = Math.round(Math.max(6, Math.min(innerWidth - w - 6, p.fx * innerWidth - w / 2)));
    const top = Math.round(Math.max(6, Math.min(innerHeight - h - 6, p.fy * innerHeight - h / 2)));
    bar.style.left = left + "px";
    bar.style.top = top + "px";
    // The collapsed dot sits where the bar's grip was.
    dot.style.left = Math.max(6, Math.min(innerWidth - 36, left)) + "px";
    dot.style.top = Math.max(6, Math.min(innerHeight - 36, top + (h - 30) / 2)) + "px";
    placeSweep();
  }

  function bindDrag(grip) {
    let start = null;
    grip.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const r = bar.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      closePop();
    });
    grip.addEventListener("pointermove", e => {
      if (!start) return;
      const w = bar.offsetWidth;
      const h = bar.offsetHeight;
      const left = Math.max(6, Math.min(innerWidth - w - 6, start.left + e.clientX - start.x));
      const top = Math.max(6, Math.min(innerHeight - h - 6, start.top + e.clientY - start.y));
      bar.style.left = left + "px";
      bar.style.top = top + "px";
      placeSweep();
    });
    const end = () => {
      if (!start) return;
      start = null;
      const r = bar.getBoundingClientRect();
      const pos = { fx: (r.left + r.width / 2) / innerWidth, fy: (r.top + r.height / 2) / innerHeight };
      state.prefs = { ...(state.prefs || {}), pos };
      send({ a: "prefs", prefs: state.prefs });
      place();
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  }

  function setCollapsed(on) {
    state.prefs = { ...(state.prefs || {}), collapsed: !!on };
    send({ a: "prefs", prefs: state.prefs });
    closePop();
    render();
    place();
  }

  // ---------- popups (menu, error list) ----------
  let popFor = null;
  function closePop() {
    if (pop) pop.remove();
    pop = null;
    popFor = null;
  }

  function openPop(anchor, kids, kind) {
    closePop();
    pop = el("div", "pop");
    pop.append(...kids);
    root.append(pop);
    popFor = kind;
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const below = r.bottom + 6 + h < innerHeight || r.top < h + 12;
    pop.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
    pop.style.top = (below ? Math.min(innerHeight - h - 8, r.bottom + 6) : Math.max(8, r.top - h - 6)) + "px";
  }

  function item(label, hint, run, checked) {
    const b = el("button", "mi" + (checked ? " checked" : ""));
    const l = el("span");
    l.textContent = label;
    const h = el("span", "hint");
    h.textContent = hint || "";
    b.append(l, h);
    b.onclick = e => {
      e.stopPropagation();
      closePop();
      run();
    };
    return b;
  }
  const msep = () => el("div", "msep");
  const mhead = t => {
    const d = el("div", "mhead");
    d.textContent = t;
    return d;
  };

  const DEVICES = [
    ["", "Fit the window"],
    ["375x667m", "iPhone SE · 375×667"],
    ["393x852m", "iPhone 15 · 393×852"],
    ["412x915m", "Pixel 8 · 412×915"],
    ["820x1180m", "iPad Air · 820×1180"],
    ["1280x800", "Laptop · 1280×800"],
    ["1440x900", "Desktop · 1440×900"],
  ];

  // ---------- measure: sizes, padding, margin and distances ----------
  let mlayer = null;
  const measure = { on: false, alt: false, anchor: null, x: -1, y: -1, raf: 0, cursor: null };
  const measuring = () => measure.on || measure.alt;

  function setMeasure(on) {
    measure.on = !!on;
    if (!measuring()) measure.anchor = null;
    if (measure.on && !measure.cursor) {
      measure.cursor = document.createElement("style");
      measure.cursor.textContent = "html, html * { cursor: crosshair !important; }";
      (document.head || document.documentElement).appendChild(measure.cursor);
    } else if (!measure.on && measure.cursor) {
      measure.cursor.remove();
      measure.cursor = null;
    }
    render();
    loopMeasure();
  }
  function setAlt(on) {
    if (measure.alt === on) return;
    measure.alt = on;
    if (!measuring()) measure.anchor = null;
    loopMeasure();
  }

  // The element under the pointer, inside open shadow roots too; never our own UI.
  function hitAt(x, y) {
    let e = document.elementFromPoint(x, y);
    if (!e || e === host) return null;
    for (let i = 0; i < 10 && e.shadowRoot; i++) {
      const inner = e.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === e) break;
      e = inner;
    }
    return e;
  }

  function loopMeasure() {
    cancelAnimationFrame(measure.raf);
    if (!measuring()) {
      if (mlayer) mlayer.replaceChildren();
      return;
    }
    const tick = () => {
      drawMeasure();
      if (measuring()) measure.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  const fmt = v => String(Math.round(v * 10) / 10);
  function drawMeasure() {
    if (!mlayer) return;
    const parts = [];
    const div = (cls, x, y, w, h, extra) => {
      const d = document.createElement("div");
      d.className = cls;
      d.style.left = x + "px";
      d.style.top = y + "px";
      if (w != null) d.style.width = Math.max(0, w) + "px";
      if (h != null) d.style.height = Math.max(0, h) + "px";
      if (extra) Object.assign(d.style, extra);
      parts.push(d);
      return d;
    };
    const label = (text, x, y, cls = "lbl") => {
      const d = div(cls, x, y);
      d.textContent = text;
    };
    if (measure.anchor && !measure.anchor.isConnected) measure.anchor = null;
    const H = measure.x >= 0 ? hitAt(measure.x, measure.y) : null;
    const A = measure.anchor;
    if (H && (!A || H === A)) {
      // One element: its box, padding (green) and margin (orange), and its size.
      const r = H.getBoundingClientRect();
      const cs = getComputedStyle(H);
      const n = p => Math.max(0, parseFloat(cs[p]) || 0);
      const [mt, mr, mb, ml] = ["marginTop", "marginRight", "marginBottom", "marginLeft"].map(n);
      const [bt, br, bb, bl] = ["borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"].map(n);
      const [pt, pr, pb, pl] = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].map(n);
      div("mar", r.left - ml, r.top - mt, r.width + ml + mr, mt);
      div("mar", r.left - ml, r.bottom, r.width + ml + mr, mb);
      div("mar", r.left - ml, r.top, ml, r.height);
      div("mar", r.right, r.top, mr, r.height);
      const ix = r.left + bl;
      const iy = r.top + bt;
      const iw = r.width - bl - br;
      const ih = r.height - bt - bb;
      div("pad", ix, iy, iw, pt);
      div("pad", ix, iy + ih - pb, iw, pb);
      div("pad", ix, iy + pt, pl, ih - pt - pb);
      div("pad", ix + iw - pr, iy + pt, pr, ih - pt - pb);
      div("box" + (H === A ? " anchor" : ""), r.left, r.top, r.width, r.height);
      // Each side's padding and margin, in the middle of its band.
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const side = (v, x, y, cls) => v >= 0.5 && label(fmt(v), x, y, "lbl " + cls);
      // A band too thin for its label: margin labels move out, padding labels in, so they never overlap.
      side(mt, cx, Math.min(r.top - mt / 2, r.top - 8), "marl");
      side(mb, cx, Math.max(r.bottom + mb / 2, r.bottom + 8), "marl");
      side(ml, Math.min(r.left - ml / 2, r.left - 11), cy, "marl");
      side(mr, Math.max(r.right + mr / 2, r.right + 11), cy, "marl");
      side(pt, cx, Math.max(iy + pt / 2, iy + 8), "padl");
      side(pb, cx, Math.min(iy + ih - pb / 2, iy + ih - 8), "padl");
      side(pl, Math.max(ix + pl / 2, ix + 11), cy, "padl");
      side(pr, Math.min(ix + iw - pr / 2, ix + iw - 11), cy, "padl");
      // The size, outside the margin so the labels don't overlap.
      const out = Math.max(mb, mb >= 0.5 ? 16 : 0);
      const outTop = Math.max(mt, mt >= 0.5 ? 16 : 0);
      const below = r.bottom + out + 22 < innerHeight;
      label(`${fmt(r.width)} × ${fmt(r.height)}`, cx, below ? r.bottom + out + 4 : Math.max(2, r.top - outTop - 20), "lbl size");
    } else if (H && A) {
      // Two elements: the distances between them (or from the inner to the outer one).
      const a = A.getBoundingClientRect();
      const h = H.getBoundingClientRect();
      div("box anchor", a.left, a.top, a.width, a.height);
      div("box", h.left, h.top, h.width, h.height);
      const hline = (x1, x2, y) => {
        if (x2 - x1 < 0.5) return;
        div("ln", x1, y, x2 - x1, 1);
        label(fmt(x2 - x1), (x1 + x2) / 2, y);
      };
      const vline = (y1, y2, x) => {
        if (y2 - y1 < 0.5) return;
        div("ln", x, y1, 1, y2 - y1);
        label(fmt(y2 - y1), x, (y1 + y2) / 2);
      };
      const inside = (i, o) => i.left >= o.left - 0.5 && i.right <= o.right + 0.5 && i.top >= o.top - 0.5 && i.bottom <= o.bottom + 0.5;
      const pair = inside(a, h) ? [a, h] : inside(h, a) ? [h, a] : null;
      if (pair) {
        const [i, o] = pair;
        const cx = i.left + i.width / 2;
        const cy = i.top + i.height / 2;
        vline(o.top, i.top, cx);
        vline(i.bottom, o.bottom, cx);
        hline(o.left, i.left, cy);
        hline(i.right, o.right, cy);
      } else {
        const oy1 = Math.max(a.top, h.top);
        const oy2 = Math.min(a.bottom, h.bottom);
        const ox1 = Math.max(a.left, h.left);
        const ox2 = Math.min(a.right, h.right);
        const ay = a.top + a.height / 2;
        const ax = a.left + a.width / 2;
        // Side by side: the horizontal gap, at their shared height (or the anchor's middle).
        if (a.right <= h.left || h.right <= a.left) {
          const [x1, x2, edge] = a.right <= h.left ? [a.right, h.left, h.left] : [h.right, a.left, h.right];
          const y = oy2 > oy1 ? (oy1 + oy2) / 2 : ay;
          hline(x1, x2, y);
          if (!(oy2 > oy1)) div("guide", edge, Math.min(y, h.top), 0, Math.abs((y < h.top ? h.top : h.bottom) - y), { borderLeftWidth: "1px" });
        }
        // Above each other: the vertical gap.
        if (a.bottom <= h.top || h.bottom <= a.top) {
          const [y1, y2, edge] = a.bottom <= h.top ? [a.bottom, h.top, h.top] : [h.bottom, a.top, h.bottom];
          const x = ox2 > ox1 ? (ox1 + ox2) / 2 : ax;
          vline(y1, y2, x);
          if (!(ox2 > ox1)) div("guide", Math.min(x, h.left), edge, Math.abs((x < h.left ? h.left : h.right) - x), 0, { borderTopWidth: "1px" });
        }
      }
    } else if (A) {
      const a = A.getBoundingClientRect();
      div("box anchor", a.left, a.top, a.width, a.height);
    }
    mlayer.replaceChildren(...parts);
  }

  window.addEventListener(
    "pointermove",
    e => {
      measure.x = e.clientX;
      measure.y = e.clientY;
    },
    true
  );
  // While measuring, a click picks the element to measure from instead of reaching the page.
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick", "auxclick", "contextmenu"]) {
    window.addEventListener(
      type,
      e => {
        if (!measuring() || e.composedPath().includes(host)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (type === "click") {
          const t = hitAt(e.clientX, e.clientY);
          measure.anchor = t && t !== measure.anchor ? t : null;
        }
      },
      true
    );
  }
  window.addEventListener(
    "keydown",
    e => {
      if (e.key === "Alt" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.repeat) setAlt(true);
      else if (e.key !== "Alt" && measure.alt) setAlt(false); // ⌥ was part of a shortcut or a character
      if (e.key === "Escape" && measuring()) {
        if (measure.anchor) measure.anchor = null;
        else setMeasure(false);
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true
  );
  window.addEventListener(
    "keyup",
    e => {
      if (e.key === "Alt") setAlt(false);
    },
    true
  );
  window.addEventListener("blur", () => setAlt(false));

  // ---------- open on my phone ----------
  async function togglePhone(anchor) {
    if (popFor === "phone") return closePop();
    const r = await send({ a: "phone" });
    if (!r || r.error) return toast((r && r.error) || "Couldn't make a link for this page");
    const box = el("div", "qrbox");
    const code = el("div", "code", r.svg); // our own SVG, made by the engine
    const url = el("div", "url");
    url.textContent = r.url;
    const hint = el("div", "hint");
    hint.textContent = r.lan ? "Scan with the phone's camera (same Wi-Fi)" : "Scan with the phone's camera";
    box.append(code, url, hint);
    if (r.warn) {
      const w = el("div", "warn");
      w.textContent = r.warn;
      box.append(w);
    }
    openPop(anchor, [box, msep(), item("Copy this address", "", () => send({ a: "copyText", text: r.url }).then(ok => ok && toast("Address copied")))], "phone");
  }

  // ---------- fill this form ----------
  let lastField = null; // the form field used last: its form gets filled
  document.addEventListener(
    "focusin",
    e => {
      const t = e.composedPath()[0];
      if (t && t.matches && t.matches("input, textarea, select")) lastField = t;
    },
    true
  );
  function runFill(mode) {
    if (!window.__cbFill) return toast("Form filling isn't loaded on this page; reload it");
    const r = window.__cbFill(mode, lastField);
    if (!r.total) return toast("No form fields on this page");
    toast(mode === "clear" ? `Cleared ${r.filled} field${r.filled === 1 ? "" : "s"}` : `Filled ${r.filled} of ${r.total} field${r.total === 1 ? "" : "s"}`);
  }
  function toggleFill(anchor) {
    if (popFor === "fill") return closePop();
    openPop(anchor, [
      item("Fill with test data", "", () => runFill("valid")),
      item("Fill with long text", "", () => runFill("long")),
      item("Clear the form", "", () => runFill("clear")),
    ], "fill");
  }

  function toggleMenu(anchor) {
    if (popFor === "menu") return closePop();
    const m = isMac ? "⌘" : "Ctrl+";
    const kids = [
      item("Reload, ignoring the cache", `${m}⇧R`, () => send({ a: "hardReload" })),
      item("Copy page address", "", () => send({ a: "copyUrl" }).then(r => r && toast("Address copied"))),
      msep(),
    ];
    if (!(state.multi && state.multi.on)) {
      kids.push(mhead("Device size"));
      for (const [v, label] of DEVICES) kids.push(item(label, "", () => send({ a: "device", value: v }), (state.device || "") === v));
      kids.push(msep());
    }
    kids.push(
      mhead("Appearance (prefers-color-scheme)"),
      item("System", "", () => send({ a: "scheme", value: "" }), !state.scheme),
      item("Light", "", () => send({ a: "scheme", value: "light" }), state.scheme === "light"),
      item("Dark", "", () => send({ a: "scheme", value: "dark" }), state.scheme === "dark"),
      msep(),
      item("Clear cookies & storage for this site", "", () => send({ a: "clearSite" })),
      item("Restart browser", "", () => send({ a: "restart" }))
    );
    if (!docked()) kids.push(msep(), item("Hide toolbar", isMac ? "⌥⇧T" : "Alt+Shift+T", () => setCollapsed(true)));
    openPop(anchor, kids, "menu");
  }

  async function toggleErrors() {
    if (popFor === "errors") return closePop();
    const m = await send({ a: "errors" });
    if (!m) return;
    const row = (cls, main, sub, run) => {
      const b = el("button", "erow " + cls);
      const a = el("div", "emsg");
      a.textContent = main;
      b.append(a);
      if (sub) {
        const s = el("div", "ewhere");
        s.textContent = sub;
        b.append(s);
      }
      b.onclick = e => {
        e.stopPropagation();
        closePop();
        run();
      };
      return b;
    };
    const kids = [mhead(m.items.length ? "Click an error to send it to Claude" : "No errors on this page")];
    for (const it of m.items) kids.push(row("err", (it.count > 1 ? `×${it.count}  ` : "") + it.text, it.where || (it.kind === "exception" ? "uncaught exception" : "console.error"), () => sendErrors([it.id])));
    for (const r of m.requests) kids.push(row("req", `${r.status} ${r.method} ${r.url}`, "failed request — sent along with any error", () => sendErrors(null)));
    kids.push(msep());
    if (m.items.length > 1) kids.push(row("act", `Send all ${m.items.length} to Claude`, "", () => sendErrors(null)));
    if (!window.__cbCursorMode) kids.push(row("act", "Open DevTools", "", () => send({ a: "devtools", open: true })));
    openPop(btns.errors, kids, "errors");
  }

  async function sendErrors(ids) {
    const r = await send({ a: "sendErrors", ids });
    if (r && r.text) toast(r.text);
  }

  // ---------- toast ----------
  let toastTimer = null;
  function toast(text, ms = 3200) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.classList.add("show");
    const anchor = bar && !bar.classList.contains("hidden") ? bar.getBoundingClientRect() : dot ? dot.getBoundingClientRect() : { left: innerWidth / 2, right: innerWidth / 2, top: innerHeight - 40, bottom: innerHeight - 40, width: 0 };
    const w = toastEl.offsetWidth;
    const h = toastEl.offsetHeight;
    const above = anchor.top > h + 16 && !docked();
    toastEl.style.left = Math.max(12, Math.min(innerWidth - w - 12, anchor.left + (anchor.right - anchor.left) / 2 - w / 2)) + "px";
    toastEl.style.top = (above ? anchor.top - h - 8 : anchor.bottom + 8) + "px";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
  }

  // ---------- mark-up: draw on the page, send the picture to Claude ----------
  const ACCENT = "#e5484d";
  const annot = { on: false, tool: "rect", marks: [], draft: null, pane: null, layer: null, svg: null, abar: null, note: null, sendBtn: null };

  function setAnnotate(on) {
    if (on === annot.on) return;
    annot.on = !!on;
    annot.marks = [];
    annot.draft = null;
    annot.pane = null;
    closePop();
    if (annot.layer) annot.layer.remove();
    if (annot.abar) annot.abar.remove();
    annot.layer = annot.abar = null;
    if (on) {
      if (state.picking) send({ a: "pick", on: false });
      buildAnnot();
    }
    render();
  }

  function buildAnnot() {
    const layer = el("div", "layer");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    layer.append(svg);
    const abar = el("div", "abar");
    const tools = [];
    const tool = (t, label, title) => {
      const c = el("button", "chip" + (annot.tool === t ? " on" : ""));
      c.textContent = label;
      c.title = title;
      c.onclick = () => {
        annot.tool = t;
        for (const x of tools) x.classList.toggle("on", x === c);
        annot.note.focus();
      };
      tools.push(c);
      return c;
    };
    const note = el("input");
    note.placeholder = docked() ? "Drag inside a pane to mark it (⌥ = arrow), then say what should change — Enter sends" : "Drag to mark an area (⌥ = arrow), then say what should change — Enter sends";
    note.spellcheck = false;
    note.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        sendAnnotation();
      } else if (e.key === "Escape") {
        e.preventDefault();
        setAnnotate(false);
      } else if (e.key === "z" && (e.metaKey || e.ctrlKey) && !note.value) {
        e.preventDefault();
        undo();
      }
    });
    for (const t of ["keyup", "keypress", "input"]) note.addEventListener(t, e => e.stopPropagation());
    const undoB = el("button", "chip");
    undoB.textContent = "Undo";
    undoB.onclick = undo;
    const cancel = el("button", "chip");
    cancel.textContent = "Cancel";
    cancel.onclick = () => setAnnotate(false);
    const sendB = el("button", "chip primary");
    sendB.textContent = "Send to Claude";
    sendB.disabled = true;
    sendB.onclick = sendAnnotation;
    abar.append(tool("rect", "Rectangle", "Drag to mark an area (hold ⌥ for an arrow)"), tool("arrow", "Arrow", "Drag towards the thing you mean (hold ⌥ for a rectangle)"), note, undoB, cancel, sendB);
    root.insertBefore(layer, bar);
    root.append(abar);
    Object.assign(annot, { layer, svg, abar, note, sendBtn: sendB });
    const w = abar.offsetWidth;
    abar.style.left = Math.round((innerWidth - w) / 2) + "px";
    abar.style.top = (docked() ? 48 : 12) + "px";
    note.focus();

    layer.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      e.preventDefault();
      let pane = null;
      if (docked()) {
        pane = shell() && shell().paneAt(e.clientX, e.clientY);
        if (!pane) return;
        // One picture per send: marks stay within the pane they started in.
        if (!annot.pane || annot.pane.key !== pane.key) annot.marks = [];
        annot.pane = pane;
      }
      layer.setPointerCapture(e.pointerId);
      const p = clampPt(e.clientX, e.clientY);
      const alt = e.altKey;
      annot.draft = { kind: alt ? (annot.tool === "rect" ? "arrow" : "rect") : annot.tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
      draw();
    });
    layer.addEventListener("pointermove", e => {
      if (!annot.draft) return;
      const p = clampPt(e.clientX, e.clientY);
      annot.draft.x2 = p.x;
      annot.draft.y2 = p.y;
      draw();
    });
    const end = () => {
      const d = annot.draft;
      annot.draft = null;
      if (!d) return;
      if (Math.hypot(d.x2 - d.x1, d.y2 - d.y1) >= 6) {
        annot.marks.push(d.kind === "arrow" ? d : { kind: "rect", x: Math.min(d.x1, d.x2), y: Math.min(d.y1, d.y2), w: Math.abs(d.x2 - d.x1), h: Math.abs(d.y2 - d.y1) });
      }
      draw();
      annot.note.focus();
    };
    layer.addEventListener("pointerup", end);
    layer.addEventListener("pointercancel", end);
    layer.addEventListener("wheel", e => e.preventDefault(), { passive: false });
  }

  function clampPt(x, y) {
    const r = annot.pane ? annot.pane.rect : { x: 0, y: 0, width: innerWidth, height: innerHeight };
    return { x: Math.max(r.x, Math.min(r.x + r.width, x)), y: Math.max(r.y, Math.min(r.y + r.height, y)) };
  }

  function undo() {
    annot.marks.pop();
    draw();
  }

  function draw() {
    if (!annot.svg) return;
    const ns = "http://www.w3.org/2000/svg";
    const g = [];
    const mk = (tag, attrs) => {
      const n = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      return n;
    };
    const paint = (m, i, draft) => {
      const common = { stroke: ACCENT, "stroke-width": 2.5, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" };
      if (draft) common["stroke-dasharray"] = "6 4";
      let lx;
      let ly;
      if (m.kind === "arrow") {
        const a = Math.atan2(m.y2 - m.y1, m.x2 - m.x1);
        const head = 12;
        g.push(mk("line", { x1: m.x1, y1: m.y1, x2: m.x2, y2: m.y2, ...common }));
        const pts = [
          [m.x2, m.y2],
          [m.x2 - head * Math.cos(a - 0.45), m.y2 - head * Math.sin(a - 0.45)],
          [m.x2 - head * Math.cos(a + 0.45), m.y2 - head * Math.sin(a + 0.45)],
        ];
        g.push(mk("polygon", { points: pts.map(p => p.join(",")).join(" "), fill: ACCENT }));
        lx = m.x1;
        ly = m.y1;
      } else {
        const r = m.x1 !== undefined ? { x: Math.min(m.x1, m.x2), y: Math.min(m.y1, m.y2), w: Math.abs(m.x2 - m.x1), h: Math.abs(m.y2 - m.y1) } : m;
        g.push(mk("rect", { x: r.x, y: r.y, width: r.w, height: r.h, ...common, fill: "rgba(229,72,77,.08)" }));
        lx = r.x;
        ly = r.y;
      }
      if (draft) return;
      g.push(mk("circle", { cx: lx, cy: ly, r: 10, fill: ACCENT }));
      const t = mk("text", { x: lx, y: ly + 0.5, fill: "#fff", "font-size": 12, "font-weight": 600, "font-family": "-apple-system, BlinkMacSystemFont, sans-serif", "text-anchor": "middle", "dominant-baseline": "central" });
      t.textContent = String(i + 1);
      g.push(t);
    };
    annot.marks.forEach((m, i) => paint(m, i, false));
    if (annot.draft) paint(annot.draft, 0, true);
    annot.svg.replaceChildren(...g);
    if (annot.sendBtn) annot.sendBtn.disabled = !annot.marks.length;
  }

  async function sendAnnotation() {
    if (!annot.marks.length) return toast("Draw a rectangle or an arrow first");
    const marks = annot.marks;
    const pane = annot.pane ? annot.pane.key : null;
    const note = annot.note ? annot.note.value : "";
    if (annot.sendBtn) annot.sendBtn.disabled = true;
    const r = await send({ a: "annotate", marks, note, pane });
    setAnnotate(false);
    if (r && r.text) toast(r.text, 4500);
  }

  // Hides what must not be in a screenshot. "marks": everything but the
  // drawn marks; "all": everything. Resolves once the change is painted.
  function capture(mode) {
    if (!root) return Promise.resolve(true);
    root.classList.toggle("capture", !!mode);
    root.classList.toggle("capture-all", mode === "all");
    return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))));
  }

  // ---------- keyboard ----------
  window.addEventListener(
    "keydown",
    e => {
      if (!e.altKey || !e.shiftKey || e.metaKey || e.ctrlKey) return;
      if (e.code === "KeyS") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setAnnotate(!annot.on);
      } else if (e.code === "KeyT" && !docked()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setCollapsed(!(state.prefs && state.prefs.collapsed));
      }
    },
    true
  );
  window.addEventListener(
    "keydown",
    e => {
      if (e.key === "Escape" && pop) closePop();
    },
    true
  );
  window.addEventListener("pointerdown", e => {
    // The shadow root is closed: from here a click inside it only shows the host.
    if (pop && !e.composedPath().includes(host)) closePop();
  }, true);
  window.addEventListener("blur", closePop);
  window.addEventListener("resize", () => {
    if (sw.w && state.sweep && state.sweep.on) sw.w.textContent = `${innerWidth} × ${innerHeight}`;
    place();
    if (annot.on) setAnnotate(false);
  });

  // ---------- engine → toolbar ----------
  window.__cbUi = {
    state(s) {
      const before = JSON.stringify(state.prefs);
      state = { ...state, ...s };
      if (!host || !host.isConnected) mount();
      render();
      if (JSON.stringify(state.prefs) !== before) place();
      return true;
    },
    toast,
    capture,
    annotate: on => setAnnotate(on === undefined ? !annot.on : !!on),
    raise: () => host && raise(),
  };

  async function start() {
    const s = await send({ a: "state" });
    if (s) state = { ...state, ...s };
    mount();
    // Keep the toolbar attached and on top when the page rebuilds its document
    // or opens a popover/dialog of its own.
    new MutationObserver(() => {
      if (!host || !host.isConnected) mount();
    }).observe(document.documentElement, { childList: true });
    document.addEventListener(
      "toggle",
      e => {
        if (e.target !== host && e.newState === "open") setTimeout(() => host && raise(), 0);
      },
      true
    );
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();

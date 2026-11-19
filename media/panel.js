// Claude Browser viewer: renders the engine's screencast and forwards input.
// Runs inside the editor webview, or standalone (?port=…&token=…) for testing.
(() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const cfg = Object.assign({ port: params.get("port") || 47321, token: params.get("token") || "" }, window.CB_CONFIG || {});
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  const $ = id => document.getElementById(id);
  const stage = $("stage");
  const screen = $("screen");
  const canvas = $("canvas");
  const kbd = $("kbd");
  const urlInput = $("url");
  const overlay = $("overlay");
  const fx = $("fx");

  let ws = null;
  let clientId = null;
  let connected = false;
  let eff = { width: 0, height: 0, dpr: 1, mobile: false };
  let override = null;
  let nav = { url: "", title: "", canGoBack: false, canGoForward: false, loading: false };
  let picking = false;
  let reconnectTimer = null;

  // ---------- persisted UI state ----------
  const saved = (() => {
    try {
      return (vscode ? vscode.getState() : JSON.parse(localStorage.getItem("cb-state") || "null")) || {};
    } catch {
      return {};
    }
  })();
  function saveState(patch) {
    Object.assign(saved, patch);
    try {
      if (vscode) vscode.setState(saved);
      else localStorage.setItem("cb-state", JSON.stringify(saved));
    } catch {}
  }

  // ---------- DevTools drawer ----------
  const drawer = $("drawer");
  const dtframe = $("dtframe");
  let devtoolsPath = null;
  let dtOpen = !!saved.dtOpen;

  function loadDevtools() {
    drawer.classList.toggle("nodt", !devtoolsPath);
    if (!devtoolsPath) return;
    const src = `http://127.0.0.1:${cfg.port}${devtoolsPath}`;
    if (dtframe.dataset.src !== src) {
      dtframe.dataset.src = src;
      dtframe.src = src;
    }
  }

  function setDevtoolsPath(p) {
    devtoolsPath = p || null;
    if (dtOpen) loadDevtools();
  }

  function toggleDevtools(open) {
    dtOpen = typeof open === "boolean" ? open : !dtOpen;
    drawer.hidden = !dtOpen;
    $("dock").hidden = !dtOpen;
    $("devtools").classList.toggle("on", dtOpen);
    if (dtOpen) loadDevtools();
    saveState({ dtOpen });
  }

  // Dock side: "side" (right, default) or "bottom".
  let dock = saved.dtDock === "bottom" ? "bottom" : "side";
  const isSide = () => dock === "side";

  function setDock(side) {
    dock = side;
    document.body.classList.toggle("side", isSide());
    $("dock").title = isSide() ? "Dock DevTools to the bottom" : "Dock DevTools to the side";
    setDrawerSize(isSide() ? saved.dtWidth || 420 : saved.dtHeight || 320);
    saveState({ dtDock: dock });
  }

  function setDrawerSize(px) {
    if (isSide()) {
      const max = Math.max(220, window.innerWidth - 200);
      const width = Math.round(Math.min(max, Math.max(200, px)));
      drawer.style.width = width + "px";
      drawer.style.height = "";
      return width;
    }
    const max = Math.max(120, window.innerHeight - 140);
    const height = Math.round(Math.min(max, Math.max(80, px)));
    drawer.style.height = height + "px";
    drawer.style.width = "";
    return height;
  }
  const dragSize = e => (isSide() ? window.innerWidth - e.clientX : window.innerHeight - e.clientY);
  setDock(dock);
  $("dock").onclick = () => setDock(isSide() ? "bottom" : "side");

  const splitter = $("splitter");
  splitter.addEventListener("pointerdown", e => {
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add("drag");
    dtframe.style.pointerEvents = "none";
  });
  splitter.addEventListener("pointermove", e => {
    if (splitter.hasPointerCapture(e.pointerId)) setDrawerSize(dragSize(e));
  });
  const endDrag = e => {
    if (!splitter.classList.contains("drag")) return;
    splitter.classList.remove("drag");
    dtframe.style.pointerEvents = "";
    const size = setDrawerSize(dragSize(e));
    saveState(isSide() ? { dtWidth: size } : { dtHeight: size });
  };
  splitter.addEventListener("pointerup", endDrag);
  splitter.addEventListener("pointercancel", endDrag);

  // ---------- connection ----------
  function connect() {
    clearTimeout(reconnectTimer);
    if (!cfg.token) {
      showOverlay("Waiting for the browser engine…");
      return;
    }
    try {
      ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/ws?token=${encodeURIComponent(cfg.token)}`);
    } catch (e) {
      scheduleReconnect();
      return;
    }
    const sock = ws;
    sock.binaryType = "arraybuffer";
    sock.onopen = () => {
      if (ws !== sock) return;
      connected = true;
      lastPong = performance.now();
      sendViewport(true);
    };
    sock.onmessage = ev => {
      if (ws !== sock) return;
      if (typeof ev.data !== "string") return onFrame(ev.data);
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      onMessage(msg);
    };
    sock.onclose = () => {
      // A socket we already replaced must not disturb the live one.
      if (ws !== sock) return;
      const was = connected;
      connected = false;
      showOverlay(was ? "Browser engine disconnected — reconnecting…" : "Starting the browser engine…", true);
      if (vscode) vscode.postMessage({ type: "engineDown" });
      scheduleReconnect();
    };
    sock.onerror = () => {};
  }

  // The engine answers pings; silence means it is stuck, so drop the socket
  // and let the editor replace the engine.
  let lastPong = 0;
  let pingN = 0;
  setInterval(() => {
    if (!ws || ws.readyState !== 1) return;
    if (performance.now() - lastPong > 12000) {
      const dead = ws;
      ws = null;
      connected = false;
      try {
        dead.close();
      } catch {}
      showOverlay("The browser engine stopped responding — restarting it…", true);
      if (vscode) vscode.postMessage({ type: "engineStuck" });
      scheduleReconnect();
      return;
    }
    send({ t: "ping", n: ++pingN });
  }, 4000);

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1000);
  }

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function showOverlay(text, withRestart, progress) {
    $("overlaymsg").textContent = text;
    $("overlayrestart").hidden = !withRestart;
    const bar = $("overlaybar");
    bar.hidden = typeof progress !== "number";
    if (typeof progress === "number") bar.firstElementChild.style.width = Math.round(progress * 100) + "%";
    overlay.classList.remove("hidden");
  }
  function hideOverlay() {
    overlay.classList.add("hidden");
  }

  function restartBrowser() {
    showOverlay("Restarting the browser…");
    if (ws && ws.readyState === 1) send({ t: "restart" });
    else if (vscode) vscode.postMessage({ type: "engineStuck" });
  }

  // ---------- frames ----------
  // Each frame: 16-byte header (u32 seq, u16 flags, u16 -, f32 cssWidth,
  // f32 cssHeight) followed by the image. See packFrame() in the engine.
  let gotFrame = false;

  // A pane is one page view: the shared tab (pane 0) and, in the side-by-side
  // view, one more per extra device. Each has its own canvas and frame queue.
  // frameCss is the CSS size of the page area the frame on screen covers:
  // pointer positions are mapped with it, so they stay right at any size.
  function makePane(index, el) {
    const cv = el.querySelector("canvas");
    return { index, el, label: el.querySelector(".panelabel"), screen: el.querySelector(".screen"), canvas: cv, ctx: cv.getContext("2d", { alpha: false, desynchronized: true }), fx: el.querySelector(".fx"), popup: el.querySelector(".popup"), frameCss: { w: 0, h: 0 }, pending: null, decoding: false, info: null };
  }
  const panes = [makePane(0, $("pane0"))];
  const paneOf = target => panes.find(p => p && p.canvas === target) || null;
  let inputPane = 0; // where keyboard input goes

  function onFrame(buf) {
    if (buf.byteLength < 17) return;
    const head = new DataView(buf, 0, 16);
    const flags = head.getUint16(4, true);
    const seq = head.getUint32(0, true);
    const pane = panes[head.getUint16(6, true)];
    if (!pane) return send({ t: "ack", seq });
    const frame = { seq, w: head.getFloat32(8, true), h: head.getFloat32(12, true), blob: new Blob([new Uint8Array(buf, 16)], { type: flags & 2 ? "image/png" : "image/jpeg" }) };
    // A newer frame replaces one that has not been drawn yet; tell the engine
    // the skipped one is done with.
    if (pane.pending) send({ t: "ack", seq: pane.pending.seq });
    pane.pending = frame;
    if (!pane.decoding) drawNext(pane);
  }

  async function drawNext(pane) {
    const frame = pane.pending;
    pane.pending = null;
    if (!frame) return;
    pane.decoding = true;
    try {
      const bmp = await createImageBitmap(frame.blob);
      const cv = pane.canvas;
      if (cv.width !== bmp.width || cv.height !== bmp.height) {
        cv.width = bmp.width;
        cv.height = bmp.height;
      }
      pane.ctx.drawImage(bmp, 0, 0);
      bmp.close && bmp.close();
      const changed = frame.w !== pane.frameCss.w || frame.h !== pane.frameCss.h;
      if (frame.w && frame.h) pane.frameCss = { w: frame.w, h: frame.h };
      // Show the frame at its real size; never stretch an old frame to a
      // new panel size while Chrome catches up with a resize.
      if (changed) layout();
      if (!gotFrame) {
        gotFrame = true;
        if (!statusShown) hideOverlay();
      }
    } catch {}
    send({ t: "ack", seq: frame.seq });
    pane.decoding = false;
    if (pane.pending) drawNext(pane);
  }

  // ---------- side-by-side view ----------
  let multi = { on: false, keys: [], panes: [] };
  let multiScale = saved.multiScale || "fit";

  function onMulti(m) {
    multi = m && m.on ? m : { on: false, keys: [], panes: [] };
    const stageEl = stage;
    // Drop panes that are gone, add the new ones.
    for (let i = panes.length - 1; i >= 1; i--) {
      if (!multi.panes.some(p => p.pane === i)) {
        panes[i] && panes[i].el.remove();
        panes.length = Math.min(panes.length, i);
      }
    }
    for (const info of multi.panes) {
      if (info.pane > 0 && !panes[info.pane]) {
        const el = document.createElement("div");
        el.className = "pane";
        el.innerHTML = '<div class="panelabel"></div><div class="screen"><canvas></canvas><div class="fx"></div><div class="popup"></div></div>';
        stageEl.insertBefore(el, $("pane0"));
        panes[info.pane] = makePane(info.pane, el);
        bindPane(panes[info.pane]);
      }
      const p = panes[info.pane];
      if (p) {
        p.info = info;
        p.el.style.order = String(info.pane === 0 ? 99 : info.pane);
        p.label.textContent = `${info.label} · ${info.name ? info.name + " · " : ""}${info.width}×${info.height} ▾`;
        p.label.title = "Choose another size";
        p.label.onclick = e => {
          e.stopPropagation();
          showSizeMenu(p);
        };
      }
    }
    if (!multi.on) panes[0].info = null;
    if (inputPane >= panes.length) inputPane = 0;
    stageEl.classList.toggle("multi", multi.on);
    $("multi").classList.toggle("on", multi.on);
    $("multibar").hidden = !multi.on;
    for (const chip of document.querySelectorAll("#multibar .chip")) chip.classList.toggle("on", multi.keys.includes(chip.dataset.key));
    $("multiscale").value = multiScale;
    markInputPane();
    layout();
  }

  function markInputPane() {
    panes.forEach(p => p && p.el.classList.toggle("focus", multi.on && p.index === inputPane));
  }

  let lastMultiScaleSent = 0;
  function layoutMulti() {
    const s = stageSize();
    const shown = panes.filter(p => p && p.info);
    if (!shown.length) return;
    const pad = 16;
    const gap = 16;
    const labelH = 22;
    const sumW = shown.reduce((a, p) => a + p.info.width, 0);
    const maxH = Math.max(...shown.map(p => p.info.height));
    const fit = Math.min(1, (s.width - pad * 2 - gap * (shown.length - 1)) / sumW, (s.height - pad * 2 - labelH) / maxH);
    const scale = multiScale === "fit" ? Math.max(0.1, fit) : Number(multiScale) || 1;
    for (const p of shown) {
      p.screen.style.width = Math.round(p.info.width * scale) + "px";
      p.screen.style.height = Math.round(p.info.height * scale) + "px";
    }
    $("multifit").textContent = multiScale === "fit" ? `${Math.round(scale * 100)}%` : "";
    // The engine renders the panes at this scale so they are sharp, not shrunk.
    const q = Math.min(1, Math.round(scale * 1000) / 1000);
    if (q !== lastMultiScaleSent) {
      lastMultiScaleSent = q;
      send({ t: "multiScale", scale: q });
    }
  }

  $("multi").onclick = () => send({ t: "multi", on: !multi.on, keys: saved.multiKeys || ["mobile", "tablet", "desktop"] });
  for (const chip of document.querySelectorAll("#multibar .chip")) {
    chip.onclick = () => {
      const keys = new Set(multi.keys);
      if (keys.has(chip.dataset.key)) keys.delete(chip.dataset.key);
      else keys.add(chip.dataset.key);
      if (keys.size < 2) return toast("Keep at least two sizes, or turn the side-by-side view off");
      saveState({ multiKeys: [...keys] });
      send({ t: "multi", on: true, keys: [...keys] });
    };
  }
  $("multiscale").onchange = e => {
    multiScale = e.target.value;
    saveState({ multiScale });
    layout();
    kbd.focus({ preventScroll: true });
  };
  $("multioff").onclick = () => send({ t: "multi", on: false });

  // ---------- messages from the engine ----------
  function onMessage(msg) {
    switch (msg.t) {
      case "suggestions":
        onSuggestions(msg);
        break;
      case "hello":
        clientId = msg.id;
        lastMultiScaleSent = 0;
        lastPong = performance.now();
        if (msg.tabs) renderTabs(msg.tabs);
        setDevtoolsPath(msg.devtools);
        if (msg.nav) setNav(msg.nav);
        if (msg.cursor) canvas.style.cursor = msg.cursor;
        onMulti(msg.multi);
        override = msg.override;
        if (msg.effective) eff = msg.effective;
        setViewState(msg);
        browserInfo = msg.browser || null;
        setErrors(msg.errors || 0);
        setHung(!!msg.hung);
        setPicking(!!msg.picking);
        layout();
        if (msg.status) onStatus(msg.status);
        else if (msg.tabs && msg.tabs.length) onStatus({ state: "ok" });
        sendViewport(true);
        break;
      case "pong":
        lastPong = performance.now();
        break;
      case "status":
        onStatus(msg);
        break;
      case "hung":
        setHung(!!msg.on);
        break;
      case "errors":
        setErrors(msg.count || 0);
        break;
      case "errorList":
        showErrorList(msg);
        break;
      case "context":
        if (msg.requester === clientId || !msg.requester) showContextMenu(msg);
        break;
      case "shot":
        onShot(msg);
        break;
      case "nav":
        setNav(msg);
        break;
      case "devtools":
        setDevtoolsPath(msg.path);
        break;
      case "viewportState":
        eff = msg.effective;
        override = msg.override;
        setViewState(msg);
        layout();
        break;
      case "cursor":
        (panes[msg.pane || 0] || panes[0]).canvas.style.cursor = msg.v || "default";
        break;
      case "multi":
        onMulti(msg);
        break;
      case "pickState":
        setPicking(msg.on);
        break;
      case "picked":
        if (!msg.keep && !msg.kind) setPicking(false);
        if (msg.requester === clientId) {
          if (vscode) vscode.postMessage({ type: "picked", pick: msg });
          else {
            writeClipboard(msg.report);
            toast("Element copied to clipboard");
          }
        }
        break;
      case "clipboard":
        if (msg.text) writeClipboard(msg.text);
        break;
      case "toast":
        toast(msg.text);
        break;
      case "agent":
        agentActivity(msg);
        break;
      case "tabs":
        renderTabs(msg.tabs);
        break;
      case "popup":
        if (msg.requester === clientId || !msg.requester) showPopup(msg);
        break;
      case "fileChooser":
        if (msg.requester === clientId) chooseFiles(msg.multiple);
        break;
      case "download":
        onDownload(msg);
        break;
      case "permission":
        showPermission(msg);
        break;
      case "permissionDone":
        if (permId === msg.id) hidePermission();
        break;
      case "media": {
        const parts = [msg.camera && "Camera", msg.mic && "Mic"].filter(Boolean);
        $("media").hidden = !parts.length;
        $("media").textContent = parts.join(" · ");
        break;
      }
    }
  }

  // ---------- engine / page state ----------
  let statusShown = false;
  let browserInfo = null;
  let zoom = 1;
  let colorScheme = "";

  function onStatus(m) {
    if (!m || m.state === "ok") {
      statusShown = false;
      if (connected) hideOverlay();
      return;
    }
    statusShown = true;
    showOverlay(m.text || "Working…", m.state === "failed" || m.state === "stopped", m.state === "downloading" ? m.progress || 0 : undefined);
  }

  function setViewState(m) {
    if (typeof m.zoom === "number") zoom = m.zoom;
    if (typeof m.colorScheme === "string") colorScheme = m.colorScheme;
    const z = $("zoom");
    z.hidden = Math.abs(zoom - 1) < 0.001;
    z.textContent = Math.round(zoom * 100) + "%";
  }

  function setErrors(n) {
    const el = $("errors");
    el.hidden = !n;
    el.textContent = n > 99 ? "99+" : String(n);
    el.title = `${n} error${n === 1 ? "" : "s"} on this page — open the console`;
  }

  function setHung(on) {
    $("hungbar").hidden = !on;
  }
  $("hungwait").onclick = () => setHung(false);
  $("hungreload").onclick = () => {
    setHung(false);
    send({ t: "action", name: "replaceTab" });
  };
  $("overlayrestart").onclick = restartBrowser;
  // The badge opens a list of the page's errors; a click sends one (or all)
  // to Claude with its stack mapped to source lines.
  const errbox = $("errbox");
  function closeErrors() {
    errbox.hidden = true;
    errbox.replaceChildren();
  }
  $("errors").onclick = e => {
    e.stopPropagation();
    if (!errbox.hidden) return closeErrors();
    send({ t: "errorList" });
  };
  function showErrorList(m) {
    const row = (cls, main, sub, run) => {
      const el = document.createElement("button");
      el.className = "erow " + cls;
      const a = document.createElement("div");
      a.className = "emsg";
      a.textContent = main;
      el.append(a);
      if (sub) {
        const b = document.createElement("div");
        b.className = "ewhere";
        b.textContent = sub;
        el.append(b);
      }
      el.onclick = () => {
        closeErrors();
        run();
        kbd.focus({ preventScroll: true });
      };
      return el;
    };
    const head = document.createElement("div");
    head.className = "ehead";
    head.textContent = m.items.length ? "Click an error to send it to Claude" : "No errors on this page";
    const kids = [head];
    for (const it of m.items) kids.push(row("err", (it.count > 1 ? `×${it.count}  ` : "") + it.text, it.where || (it.kind === "exception" ? "uncaught exception" : "console.error"), () => send({ t: "sendErrors", ids: [it.id] })));
    for (const r of m.requests) kids.push(row("req", `${r.status} ${r.method} ${r.url}`, "failed request — sent along with any error", () => send({ t: "sendErrors" })));
    const foot = document.createElement("div");
    foot.className = "efoot";
    if (m.items.length > 1) foot.append(row("act", `Send all ${m.items.length} to Claude`, "", () => send({ t: "sendErrors" })));
    foot.append(row("act", "Open console", "", () => toggleDevtools(true)));
    kids.push(foot);
    errbox.replaceChildren(...kids);
    errbox.hidden = false;
  }
  window.addEventListener("mousedown", e => {
    if (!errbox.hidden && !errbox.contains(e.target) && e.target !== $("errors")) closeErrors();
  });
  window.addEventListener("blur", closeErrors);
  $("zoom").onclick = () => send({ t: "zoom", dir: 0 });

  function onShot(m) {
    const done = how => toast(`Screenshot ${how} — click to show the file`, () => vscode && vscode.postMessage({ type: "reveal", path: m.path }), 5000);
    const viaEditor = () => {
      if (vscode) vscode.postMessage({ type: "clipboard", text: m.path });
      done("saved, path copied");
    };
    try {
      const bin = atob(m.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) })]).then(() => done("copied — paste it into the Claude prompt"), viaEditor);
    } catch {
      viaEditor();
    }
  }

  function setNav(n) {
    nav = Object.assign(nav, n);
    $("back").disabled = !nav.canGoBack;
    $("forward").disabled = !nav.canGoForward;
    if (document.activeElement !== urlInput) urlInput.value = nav.url === "about:blank" || nav.start ? "" : nav.url || "";
    $("progress").classList.toggle("on", !!nav.loading);
    document.title = nav.title || "Claude Browser";
    if (vscode) vscode.postMessage({ type: "nav", url: nav.url, title: nav.start ? "" : nav.title });
  }

  function setPicking(on) {
    picking = !!on;
    $("pick").classList.toggle("on", picking);
  }

  // ---------- layout & viewport ----------
  function stageSize() {
    const r = stage.getBoundingClientRect();
    return { width: Math.floor(r.width), height: Math.floor(r.height) };
  }

  function layout() {
    if (multi.on) {
      $("devicewrap").classList.remove("on");
      return layoutMulti();
    }
    const s = stageSize();
    const fixed = !!override;
    stage.classList.toggle("device", fixed);
    $("devicewrap").classList.toggle("on", fixed);
    let w = s.width;
    let h = s.height;
    const frameCss = panes[0].frameCss;
    if (!fixed && frameCss.w) {
      // The frame's own size (times zoom, which makes the page area smaller).
      w = Math.round(frameCss.w * zoom);
      h = Math.round(frameCss.h * zoom);
    }
    if (fixed && eff.width && eff.height) {
      const pad = 24;
      const scale = Math.min(1, (s.width - pad) / eff.width, (s.height - pad) / eff.height);
      w = Math.floor(eff.width * scale);
      h = Math.floor(eff.height * scale);
    }
    screen.style.width = w + "px";
    screen.style.height = h + "px";
    const sel = $("device");
    const key = override ? `${override.width}x${override.height}${override.mobile ? "m" : ""}` : "";
    if ([...sel.options].some(o => o.value === key)) sel.value = key;
    else if (override) {
      const o = new Option(`${override.width}×${override.height}`, key);
      sel.add(o);
      sel.value = key;
    }
  }

  let lastSent = "";
  function sendViewport(force) {
    const s = stageSize();
    const v = { t: "viewport", width: s.width, height: s.height, dpr: window.devicePixelRatio || 1 };
    const key = JSON.stringify(v);
    if (!force && key === lastSent) return;
    lastSent = key;
    send(Object.assign(v, { active: document.hasFocus() || force === true }));
  }

  // Resize Chrome live while dragging: one message per frame, and the engine
  // only ever applies the newest size.
  let resizeQueued = false;
  new ResizeObserver(() => {
    layout();
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      sendViewport(false);
    });
  }).observe(stage);

  (function watchDpr() {
    const mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener("change", () => {
      sendViewport(false);
      watchDpr();
    }, { once: true });
  })();

  window.addEventListener("focus", () => send({ t: "focus" }));

  $("device").addEventListener("change", e => {
    const v = e.target.value;
    if (!v) send({ t: "device", device: null });
    else {
      const m = /^(\d+)x(\d+)(m?)$/.exec(v);
      send({ t: "device", device: { width: +m[1], height: +m[2], mobile: !!m[3] } });
    }
    kbd.focus({ preventScroll: true });
  });

  // ---------- toolbar ----------
  $("back").onclick = () => send({ t: "nav", action: "back" });
  $("forward").onclick = () => send({ t: "nav", action: "forward" });
  $("reload").onclick = () => send({ t: "nav", action: "reload" });
  $("pick").onclick = () => togglePick();
  $("devtools").onclick = () => toggleDevtools();
  window.addEventListener("keydown", e => {
    // When focus is on the toolbar (not the page), still honour the toggle.
    if (e.target === kbd) return;
    if (e.key === "F12" || ((isMac ? e.metaKey : e.ctrlKey) && e.altKey && e.code === "KeyI")) {
      e.preventDefault();
      toggleDevtools();
    }
  });
  $("urlform").addEventListener("submit", e => {
    e.preventDefault();
    hideSuggest();
    const url = urlInput.value.trim();
    if (url) send({ t: "nav", action: "goto", url });
    urlInput.blur();
    kbd.focus({ preventScroll: true });
  });
  urlInput.addEventListener("focus", () => urlInput.select());
  urlInput.addEventListener("keydown", e => {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && sugItems.length) {
      e.preventDefault();
      const n = sugItems.length;
      sugIndex = e.key === "ArrowDown" ? (sugIndex + 1 >= n ? -1 : sugIndex + 1) : sugIndex - 1 < -1 ? n - 1 : sugIndex - 1;
      urlInput.value = sugIndex >= 0 ? sugItems[sugIndex].url : typed;
      renderSuggest();
      return;
    }
    if (e.key === "Delete" && e.shiftKey && sugIndex >= 0) {
      // Shift+Delete removes the highlighted entry from history (like Chrome).
      e.preventDefault();
      send({ t: "forget", url: sugItems[sugIndex].url });
      sugItems.splice(sugIndex, 1);
      sugIndex = Math.min(sugIndex, sugItems.length - 1);
      urlInput.value = sugIndex >= 0 ? sugItems[sugIndex].url : typed;
      renderSuggest();
      return;
    }
    if (e.key === "Escape") {
      if (!suggestBox.hidden) {
        e.preventDefault();
        urlInput.value = typed;
        hideSuggest();
        return;
      }
      urlInput.value = nav.url || "";
      urlInput.blur();
      kbd.focus({ preventScroll: true });
    }
  });

  // ---------- address bar suggestions (from the engine's URL history) ----------
  const suggestBox = $("suggest");
  let sugItems = [];
  let sugIndex = -1;
  let sugSeq = 0;
  let typed = "";
  let lastInputDeleted = false;

  function hideSuggest() {
    suggestBox.hidden = true;
    suggestBox.textContent = "";
    sugItems = [];
    sugIndex = -1;
  }

  function renderSuggest() {
    suggestBox.textContent = "";
    if (!sugItems.length) {
      suggestBox.hidden = true;
      return;
    }
    sugItems.forEach((it, i) => {
      const row = document.createElement("div");
      row.className = "sug" + (i === sugIndex ? " sel" : "");
      row.setAttribute("role", "option");
      const u = document.createElement("span");
      u.className = "sug-url";
      u.textContent = it.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
      row.append(u);
      if (it.title) {
        const t = document.createElement("span");
        t.className = "sug-title";
        t.textContent = it.title;
        row.append(t);
      }
      row.addEventListener("mousedown", ev => {
        ev.preventDefault();
        urlInput.value = it.url;
        $("urlform").requestSubmit();
      });
      suggestBox.append(row);
    });
    suggestBox.hidden = false;
  }

  // What to append to the typed text so it reads as the start of `url`.
  function completionFor(url, q) {
    const lower = q.toLowerCase();
    for (const cand of [url.replace(/^https?:\/\/(www\.)?/i, ""), url.replace(/^https?:\/\//i, ""), url]) {
      if (cand.toLowerCase().startsWith(lower) && cand.length > q.length) return cand.slice(q.length);
    }
    return "";
  }

  function onSuggestions(msg) {
    if (msg.seq !== sugSeq || document.activeElement !== urlInput) return;
    sugItems = msg.items || [];
    sugIndex = -1;
    renderSuggest();
    const top = sugItems[0];
    const caretAtEnd = urlInput.selectionStart === urlInput.value.length && urlInput.selectionEnd === urlInput.value.length;
    if (top && top.prefix && !lastInputDeleted && urlInput.value === typed && caretAtEnd) {
      const rest = completionFor(top.url, typed);
      if (rest) {
        urlInput.value = typed + rest;
        urlInput.setSelectionRange(typed.length, urlInput.value.length);
      }
    }
  }

  urlInput.addEventListener("input", e => {
    typed = urlInput.value;
    lastInputDeleted = /^delete/.test(e.inputType || "");
    sugIndex = -1;
    if (!typed.trim()) return hideSuggest();
    send({ t: "suggest", q: typed, seq: ++sugSeq });
  });
  urlInput.addEventListener("blur", () => setTimeout(hideSuggest, 0));

  function togglePick(force) {
    const on = typeof force === "boolean" ? force : !picking;
    setPicking(on);
    send({ t: "pick", on });
    kbd.focus({ preventScroll: true });
  }

  // ---------- pointer input ----------
  const modifiers = e => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  const BUTTONS = ["left", "middle", "right", "back", "forward"];

  function toPage(e, pane) {
    const r = pane.canvas.getBoundingClientRect();
    const d = pageDims(r, pane);
    return { x: ((e.clientX - r.left) * d.w) / r.width, y: ((e.clientY - r.top) * d.h) / r.height };
  }

  // CSS-pixel size of the page the pane's current frame shows.
  function pageDims(r, pane) {
    if (pane.frameCss.w) return pane.frameCss;
    return { w: eff.width || r.width, h: eff.height || r.height };
  }

  let pressed = 0;
  let pressPane = panes[0];
  let moveEvent = null;
  let movePane = null;
  let moveQueued = false;

  function bindPane(pane) {
    pane.canvas.addEventListener("mousedown", e => {
      e.preventDefault();
      send({ t: "focus" });
      const p = toPage(e, pane);
      pressed++;
      pressPane = pane;
      if (inputPane !== pane.index) {
        inputPane = pane.index;
        markInputPane();
      }
      send({ t: "mouse", pane: pane.index, type: "mousePressed", x: p.x, y: p.y, button: BUTTONS[e.button] || "left", buttons: e.buttons, clickCount: e.detail || 1, modifiers: modifiers(e) });
      kbd.focus({ preventScroll: true });
    });
    pane.canvas.addEventListener("contextmenu", e => e.preventDefault());
    let wheel = null;
    pane.canvas.addEventListener(
      "wheel",
      e => {
        e.preventDefault();
        const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? eff.height || 600 : 1;
        const p = toPage(e, pane);
        if (!wheel) {
          wheel = { pane: pane.index, x: p.x, y: p.y, dx: 0, dy: 0, modifiers: modifiers(e) };
          requestAnimationFrame(() => {
            const w = wheel;
            wheel = null;
            send({ t: "wheel", ...w });
          });
        }
        wheel.x = p.x;
        wheel.y = p.y;
        wheel.dx += e.deltaX * k;
        wheel.dy += e.deltaY * k;
      },
      { passive: false }
    );
  }
  bindPane(panes[0]);

  window.addEventListener("mouseup", e => {
    if (!pressed) return;
    pressed = Math.max(0, pressed - 1);
    flushMove();
    const p = toPage(e, pressPane);
    send({ t: "mouse", pane: pressPane.index, type: "mouseReleased", x: p.x, y: p.y, button: BUTTONS[e.button] || "left", buttons: e.buttons, clickCount: e.detail || 1, modifiers: modifiers(e) });
  });

  const onMove = e => {
    // A drag keeps going to the pane it started in, even outside it.
    const pane = pressed ? pressPane : paneOf(e.target);
    if (!pane) return;
    moveEvent = e;
    movePane = pane;
    if (!moveQueued) {
      moveQueued = true;
      requestAnimationFrame(flushMove);
    }
  };
  window.addEventListener("mousemove", onMove);

  function flushMove() {
    moveQueued = false;
    const e = moveEvent;
    moveEvent = null;
    if (!e || !movePane || !panes.includes(movePane)) return;
    const p = toPage(e, movePane);
    const buttons = e.buttons;
    const button = buttons & 1 ? "left" : buttons & 2 ? "right" : buttons & 4 ? "middle" : "none";
    send({ t: "mouse", pane: movePane.index, type: "mouseMoved", x: p.x, y: p.y, button, buttons, modifiers: modifiers(e) });
  }

  // ---------- keyboard ----------
  // Keys whose default editing behaviour macOS normally supplies via the OS
  // text system (which CDP bypasses) — map them to Blink editing commands.
  function macCommands(e) {
    if (!isMac) return undefined;
    const sel = e.shiftKey ? "AndModifySelection" : "";
    const k = e.key;
    if (e.metaKey && !e.altKey && !e.ctrlKey) {
      if (k === "ArrowLeft") return [`moveToBeginningOfLine${sel}`];
      if (k === "ArrowRight") return [`moveToEndOfLine${sel}`];
      if (k === "ArrowUp") return [`moveToBeginningOfDocument${sel}`];
      if (k === "ArrowDown") return [`moveToEndOfDocument${sel}`];
      if (k === "Backspace") return ["deleteToBeginningOfLine"];
      if (k === "Delete") return ["deleteToEndOfLine"];
    }
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      if (k === "ArrowLeft") return [`moveWordLeft${sel}`];
      if (k === "ArrowRight") return [`moveWordRight${sel}`];
      if (k === "Backspace") return ["deleteWordBackward"];
      if (k === "Delete") return ["deleteWordForward"];
    }
    return undefined;
  }

  const forwardedDown = new Set();

  function sendKey(type, e, extra) {
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
    const text = type === "keyUp" ? undefined : printable ? e.key : e.key === "Enter" ? "\r" : undefined;
    send(
      Object.assign(
        {
          t: "key",
          pane: inputPane,
          type: type === "keyUp" ? "keyUp" : text ? "keyDown" : "rawKeyDown",
          key: e.key,
          code: e.code,
          windowsVirtualKeyCode: e.keyCode,
          nativeVirtualKeyCode: e.keyCode,
          modifiers: modifiers(e),
          autoRepeat: !!e.repeat,
          location: e.location,
          text,
          unmodifiedText: text,
        },
        extra || {}
      )
    );
  }

  kbd.addEventListener("keydown", e => {
    if (e.isComposing || e.keyCode === 229 || e.key === "Dead") return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();

    // Panel shortcuts.
    if (e.key === "F12" || (mod && e.altKey && e.code === "KeyI")) {
      e.preventDefault();
      return toggleDevtools();
    }
    if (mod && e.shiftKey && key === "c") {
      e.preventDefault();
      return togglePick();
    }
    if (mod && e.shiftKey && key === "s") {
      e.preventDefault();
      return setAnnotate(!annot.on);
    }
    if (annot.on && e.key === "Escape") {
      e.preventDefault();
      return setAnnotate(false);
    }
    if (mod && e.shiftKey && key === "r") {
      e.preventDefault();
      return send({ t: "action", name: "hardReload" });
    }
    if (mod && !e.altKey && (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "0")) {
      e.preventDefault();
      return send({ t: "zoom", dir: e.key === "0" ? 0 : e.key === "-" ? -1 : 1 });
    }
    if (mod && !e.shiftKey && !e.altKey) {
      if (key === "t") {
        e.preventDefault();
        send({ t: "tab", action: "new" });
        return setTimeout(() => urlInput.focus(), 150);
      }
      if (key === "w" && tabs.length > 1) {
        e.preventDefault();
        const cur = tabs.find(t => t.active);
        return cur && send({ t: "tab", action: "close", id: cur.id });
      }
      if (key === "l") {
        e.preventDefault();
        return urlInput.focus();
      }
      if (key === "r") {
        e.preventDefault();
        return send({ t: "nav", action: "reload" });
      }
      if (key === "[") {
        e.preventDefault();
        return send({ t: "nav", action: "back" });
      }
      if (key === "]") {
        e.preventDefault();
        return send({ t: "nav", action: "forward" });
      }
      if (key === "c" || key === "x") {
        e.preventDefault();
        return send({ t: "copy", pane: inputPane, cut: key === "x" });
      }
      if (key === "v") return; // native paste event → insertText
      if (key === "a") {
        e.preventDefault();
        return sendKey("down", e, { commands: ["selectAll"] });
      }
      if (key === "z") {
        e.preventDefault();
        return sendKey("down", e, { commands: ["undo"] });
      }
    }
    if (mod && e.shiftKey && key === "z") {
      e.preventDefault();
      return sendKey("down", e, { commands: ["redo"] });
    }
    // Other ⌘ shortcuts belong to the editor (⌘W, ⌘P, …).
    if (isMac && e.metaKey && !macCommands(e)) return;
    if (picking && e.key === "Escape") {
      e.preventDefault();
      return togglePick(false);
    }

    e.preventDefault();
    forwardedDown.add(e.code);
    sendKey("down", e, { commands: macCommands(e) });
  });

  kbd.addEventListener("keyup", e => {
    if (!forwardedDown.has(e.code)) return;
    forwardedDown.delete(e.code);
    e.preventDefault();
    sendKey("keyUp", e);
  });

  kbd.addEventListener("compositionend", e => {
    if (e.data) send({ t: "text", pane: inputPane, text: e.data });
    kbd.value = "";
  });

  kbd.addEventListener("input", e => {
    if (e.isComposing) return;
    if (kbd.value) send({ t: "text", pane: inputPane, text: kbd.value });
    kbd.value = "";
  });

  kbd.addEventListener("paste", e => {
    e.preventDefault();
    const text = e.clipboardData && e.clipboardData.getData("text/plain");
    if (text) send({ t: "text", pane: inputPane, text });
  });

  kbd.addEventListener("blur", () => {
    // Release anything held so the page never sees a stuck key.
    for (const code of forwardedDown) send({ t: "key", pane: inputPane, type: "keyUp", code, key: "" });
    forwardedDown.clear();
  });

  // ---------- feedback ----------
  let toastTimer = null;
  function toast(text, action, ms) {
    const el = $("toast");
    el.textContent = text;
    el.classList.add("on");
    el.classList.toggle("action", !!action);
    el.onclick = action
      ? () => {
          el.classList.remove("on");
          action();
        }
      : null;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("on", "action"), ms || (action ? 6000 : 2600));
  }

  // ---------- camera / mic permission ----------
  let permId = null;
  function showPermission(msg) {
    permId = msg.id;
    let host = msg.origin;
    try {
      host = new URL(msg.origin).host;
    } catch {}
    const what = msg.kinds.includes("camera") && msg.kinds.includes("microphone") ? "your camera and microphone" : msg.kinds.includes("camera") ? "your camera" : "your microphone";
    $("permtext").textContent = `${host} wants to use ${what}`;
    $("permremember").checked = false;
    $("permbar").hidden = false;
  }
  function hidePermission() {
    permId = null;
    $("permbar").hidden = true;
  }
  function answerPermission(allow) {
    if (permId === null) return;
    send({ t: "permissionReply", id: permId, allow, remember: $("permremember").checked });
    hidePermission();
    kbd.focus({ preventScroll: true });
  }
  $("permallow").onclick = () => answerPermission(true);
  $("permblock").onclick = () => answerPermission(false);

  // ---------- tabs ----------
  let tabs = [];
  function renderTabs(list) {
    tabs = list || [];
    const strip = $("tabs");
    strip.hidden = tabs.length < 2;
    strip.replaceChildren(
      ...tabs.map(t => {
        const el = document.createElement("div");
        el.className = "tab" + (t.active ? " active" : "");
        el.title = `${t.title}\n${t.url}`;
        if (t.loading) {
          const sp = document.createElement("span");
          sp.className = "spin";
          el.appendChild(sp);
        } else if (t.media) {
          const dot = document.createElement("span");
          dot.className = "rec";
          dot.title = "Using camera / microphone";
          el.appendChild(dot);
        }
        const title = document.createElement("span");
        title.className = "title";
        title.textContent = t.title || t.url || "New Tab";
        const x = document.createElement("button");
        x.className = "x";
        x.textContent = "×";
        x.title = "Close tab";
        x.onclick = e => {
          e.stopPropagation();
          send({ t: "tab", action: "close", id: t.id });
        };
        el.append(title, x);
        el.onmousedown = e => {
          if (e.button === 1) {
            e.preventDefault();
            send({ t: "tab", action: "close", id: t.id });
          } else if (e.button === 0 && !t.active) send({ t: "tab", action: "switch", id: t.id });
        };
        return el;
      })
    );
  }
  $("newtab").onclick = () => {
    send({ t: "tab", action: "new" });
    setTimeout(() => urlInput.focus(), 150);
  };

  // ---------- popups for <select>, date/time/color (headless can't paint them) ----------
  let popupLayer = panes[0].popup;
  function closePopup() {
    for (const p of panes) p && p.popup.replaceChildren();
  }

  function showPopup(msg) {
    closePopup();
    const pane = panes[msg.pane || 0] || panes[0];
    popupLayer = pane.popup;
    const r = pane.canvas.getBoundingClientRect();
    const d = pageDims(r, pane);
    const k = r.width / d.w;
    const x = msg.rect.x * k;
    const y = msg.rect.y * k;
    const w = msg.rect.width * k;
    const h = msg.rect.height * k;
    const done = value => {
      closePopup();
      if (value !== undefined) send({ t: "popupResult", pane: pane.index, ref: msg.ref, value });
      kbd.focus({ preventScroll: true });
    };

    if (msg.kind === "input") {
      const input = document.createElement("input");
      input.type = msg.inputType;
      input.className = "picker";
      for (const a of ["min", "max", "step"]) if (msg[a]) input[a] = msg[a];
      input.value = msg.value || "";
      Object.assign(input.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
      popupLayer.appendChild(input);
      input.addEventListener("change", () => done(input.value));
      input.addEventListener("blur", () => setTimeout(() => input.isConnected && done(), 200));
      input.addEventListener("keydown", e => e.key === "Escape" && done());
      input.focus();
      try {
        input.showPicker();
      } catch {
        toast("Use the field's keyboard input — the picker could not open here");
      }
      return;
    }

    const list = document.createElement("div");
    list.className = "list";
    list.tabIndex = 0;
    if (msg.dir) list.style.direction = msg.dir;
    const items = [];
    for (const o of msg.options) {
      const el = document.createElement("div");
      if (o.group !== undefined) {
        el.className = "grp";
        el.textContent = o.group;
      } else {
        el.className = "opt" + (o.index === msg.selectedIndex ? " sel" : "") + (o.disabled ? " dis" : "");
        el.textContent = o.label || "\u00a0";
        if (!o.disabled) {
          items.push({ el, o });
          el.onmouseenter = () => highlight(items.findIndex(i => i.el === el));
          el.onmousedown = e => {
            e.preventDefault();
            done(o.value);
          };
        }
      }
      list.appendChild(el);
    }
    popupLayer.appendChild(list);
    const stageR = stage.getBoundingClientRect();
    const below = stageR.bottom - (r.top + y + h);
    const listH = Math.min(320, list.scrollHeight + 2);
    const top = below >= listH || below > r.top + y - stageR.top ? y + h + 2 : Math.max(0, y - listH - 2);
    Object.assign(list.style, { left: Math.max(0, Math.min(x, r.width - Math.max(w, 120))) + "px", top: top + "px", minWidth: w + "px" });

    let hl = Math.max(0, items.findIndex(i => i.o.index === msg.selectedIndex));
    function highlight(i) {
      if (i < 0 || i >= items.length) return;
      items[hl] && items[hl].el.classList.remove("hl");
      hl = i;
      items[hl].el.classList.add("hl");
      items[hl].el.scrollIntoView({ block: "nearest" });
    }
    highlight(hl);
    list.addEventListener("keydown", e => {
      if (e.key === "ArrowDown") highlight(Math.min(items.length - 1, hl + 1));
      else if (e.key === "ArrowUp") highlight(Math.max(0, hl - 1));
      else if (e.key === "Home") highlight(0);
      else if (e.key === "End") highlight(items.length - 1);
      else if (e.key === "Enter" || e.key === " ") items[hl] && done(items[hl].o.value);
      else if (e.key === "Escape" || e.key === "Tab") done();
      else if (e.key.length === 1) {
        const ch = e.key.toLowerCase();
        const start = (hl + 1) % items.length;
        for (let n = 0; n < items.length; n++) {
          const i = (start + n) % items.length;
          if (items[i].o.label.trim().toLowerCase().startsWith(ch)) {
            highlight(i);
            break;
          }
        }
      } else return;
      e.preventDefault();
    });
    list.addEventListener("blur", () => setTimeout(() => list.isConnected && done(), 150));
    list.focus({ preventScroll: true });
  }

  // ---------- file uploads ----------
  function chooseFiles(multiple) {
    if (vscode) return vscode.postMessage({ type: "openFiles", multiple });
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = !!multiple;
    input.onchange = async () => {
      const files = await Promise.all(
        [...input.files].map(
          f =>
            new Promise(res => {
              const fr = new FileReader();
              fr.onload = () => res({ name: f.name, data: String(fr.result).split(",")[1] || "" });
              fr.readAsDataURL(f);
            })
        )
      );
      send({ t: "filesData", files });
    };
    input.click();
  }

  // ---------- downloads ----------
  function onDownload(d) {
    if (d.state === "inProgress") toast(`Downloading ${d.name}…`);
    else if (d.state === "completed")
      toast(`Downloaded ${d.name} — click to show`, () => {
        if (vscode) vscode.postMessage({ type: "reveal", path: d.path });
      });
    else if (d.state === "canceled") toast(`Download canceled: ${d.name}`);
  }

  function writeClipboard(text) {
    if (vscode) return vscode.postMessage({ type: "clipboard", text });
    navigator.clipboard && navigator.clipboard.writeText(text).catch(() => {});
  }

  let agentTimer = null;
  function agentActivity(msg) {
    const badge = $("agent");
    badge.classList.add("on");
    clearTimeout(agentTimer);
    agentTimer = setTimeout(() => badge.classList.remove("on"), 1800);
    if ((msg.kind === "click" || msg.kind === "hover") && eff.width) {
      const r = canvas.getBoundingClientRect();
      const d = pageDims(r, panes[0]);
      const dot = document.createElement("div");
      dot.className = "ripple" + (msg.kind === "hover" ? " hover" : "");
      dot.style.left = (msg.x * r.width) / d.w + "px";
      dot.style.top = (msg.y * r.height) / d.h + "px";
      panes[0].fx.appendChild(dot);
      setTimeout(() => dot.remove(), 800);
    }
  }

  // ---------- right-click menu ----------
  const ctx = $("ctxmenu");
  function closeContext() {
    ctx.hidden = true;
    ctx.replaceChildren();
  }
  function showContextMenu(m) {
    const pane = panes[m.pane || 0] || panes[0];
    const r = pane.canvas.getBoundingClientRect();
    const k = r.width / (pageDims(r, pane).w || r.width);
    const at = { pane: pane.index, x: m.x, y: m.y };
    const act = (name, extra) => () => send(Object.assign({ t: "action", name }, at, extra || {}));
    const item = (label, run, disabled) => {
      const el = document.createElement("button");
      el.className = "mi";
      el.disabled = !!disabled;
      const l = document.createElement("span");
      l.textContent = label;
      el.append(l);
      el.onclick = () => {
        closeContext();
        run();
        kbd.focus({ preventScroll: true });
      };
      return el;
    };
    const sep = () => {
      const el = document.createElement("div");
      el.className = "sep";
      return el;
    };
    const kids = [];
    if (m.link) {
      kids.push(item("Open link in new tab", act("openTab", { url: m.link })), item("Copy link address", () => writeClipboard(m.link)), item("Open link in default browser", () => vscode && vscode.postMessage({ type: "external", url: m.link })), sep());
    }
    if (m.image) {
      kids.push(item("Save image…", act("saveImage", { url: m.image })), item("Open image in new tab", act("openTab", { url: m.image })), item("Copy image address", () => writeClipboard(m.image)), sep());
    }
    if (m.selection) kids.push(item("Copy", () => writeClipboard(m.selection)));
    if (m.editable) kids.push(item("Select all", () => send({ t: "key", pane: pane.index, type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: isMac ? 4 : 2, commands: ["selectAll"] })));
    if (m.selection || m.editable) kids.push(sep());
    kids.push(
      item("Back", () => send({ t: "nav", action: "back" }), !m.canGoBack),
      item("Forward", () => send({ t: "nav", action: "forward" }), !m.canGoForward),
      item("Reload", () => send({ t: "nav", action: "reload" })),
      sep(),
      item("Send this element to Claude", act("pickPoint")),
      item("Inspect element", () => {
        // The engine waits for DevTools to attach before pointing it at the node.
        toggleDevtools(true);
        act("inspect")();
      })
    );
    ctx.replaceChildren(...kids);
    ctx.hidden = false;
    const w = ctx.offsetWidth;
    const h = ctx.offsetHeight;
    ctx.style.left = Math.max(4, Math.min(r.left + m.x * k, window.innerWidth - w - 4)) + "px";
    ctx.style.top = Math.max(4, Math.min(r.top + m.y * k, window.innerHeight - h - 4)) + "px";
  }
  // Sizes offered for each device of the side-by-side view (CSS pixels).
  const SIZES = {
    mobile: [
      ["iPhone SE (1st gen)", 320, 568],
      ["Galaxy S / small Android", 360, 800],
      ["iPhone SE", 375, 667],
      ["iPhone 13 mini", 375, 812],
      ["iPhone 14", 390, 844],
      ["iPhone 15 / 16", 393, 852],
      ["Pixel 8", 412, 915],
      ["iPhone 15 Plus", 430, 932],
      ["iPhone 16 Pro Max", 440, 956],
    ],
    tablet: [
      ["iPad mini", 744, 1133],
      ["iPad (classic)", 768, 1024],
      ["iPad Air", 820, 1180],
      ["iPad Pro 11″", 834, 1194],
      ["iPad Pro 13″", 1024, 1366],
      ["iPad Air landscape", 1180, 820],
    ],
    desktop: [
      ["Small laptop", 1024, 768],
      ["Laptop", 1280, 800],
      ["Laptop HD", 1366, 768],
      ["MacBook Air", 1440, 900],
      ["Laptop 1536", 1536, 864],
      ["Full HD", 1920, 1080],
      ["QHD", 2560, 1440],
    ],
  };
  const DEFAULT_SIZE = { mobile: "393x852", tablet: "820x1180", desktop: "1280x800" };

  function showSizeMenu(pane) {
    const info = pane.info;
    if (!info) return;
    const set = (width, height, name) => {
      closeContext();
      send({ t: "multiSize", key: info.key, width, height, name: name || "" });
      kbd.focus({ preventScroll: true });
    };
    const kids = [];
    for (const [name, w, h] of SIZES[info.key] || []) {
      const el = document.createElement("button");
      el.className = "mi" + (w === info.width && h === info.height ? " checked" : "");
      const l = document.createElement("span");
      l.textContent = name + (DEFAULT_SIZE[info.key] === `${w}x${h}` ? " (default)" : "");
      const d = document.createElement("span");
      d.className = "hint";
      d.textContent = `${w}×${h}`;
      el.append(l, d);
      el.onclick = () => set(w, h, DEFAULT_SIZE[info.key] === `${w}x${h}` ? "" : name);
      kids.push(el);
    }
    const sep = document.createElement("div");
    sep.className = "sep";
    const rot = document.createElement("button");
    rot.className = "mi";
    rot.innerHTML = "<span>Rotate</span>";
    rot.querySelector("span").after(Object.assign(document.createElement("span"), { className: "hint", textContent: `${info.height}×${info.width}` }));
    rot.onclick = () => set(info.height, info.width, info.name);
    const row = document.createElement("form");
    row.className = "sizerow";
    row.innerHTML = '<span>Custom</span><input name="w" type="number" min="240" max="3840" required><span>×</span><input name="h" type="number" min="240" max="3000" required><button type="submit">Set</button>';
    row.w.value = info.width;
    row.h.value = info.height;
    row.onsubmit = e => {
      e.preventDefault();
      set(Number(row.w.value), Number(row.h.value), "");
    };
    // Typing here is for the menu, not for the page.
    for (const ev of ["keydown", "keyup", "keypress", "paste", "mousedown"]) row.addEventListener(ev, e => e.stopPropagation());
    row.addEventListener("keydown", e => e.key === "Escape" && closeContext());
    ctx.replaceChildren(...kids, sep, rot, sep.cloneNode(), row);
    ctx.hidden = false;
    const r = pane.label.getBoundingClientRect();
    ctx.style.left = Math.max(4, Math.min(r.left, window.innerWidth - ctx.offsetWidth - 4)) + "px";
    ctx.style.top = Math.max(4, Math.min(r.bottom + 2, window.innerHeight - ctx.offsetHeight - 4)) + "px";
  }

  window.addEventListener(
    "mousedown",
    e => {
      if (!ctx.hidden && !ctx.contains(e.target)) closeContext();
    },
    true
  );
  window.addEventListener("blur", closeContext);
  window.addEventListener("wheel", closeContext, { passive: true });
  window.addEventListener("keydown", e => e.key === "Escape" && closeContext(), true);

  // ---------- annotate: draw on the page, send the picture to Claude ----------
  const annot = { on: false, tool: "rect", pane: null, marks: [], draft: null, layer: null };
  const ACCENT = "#e5484d";

  function annotLayer(pane) {
    let c = pane.screen.querySelector("canvas.annot");
    if (!c) {
      c = document.createElement("canvas");
      c.className = "annot";
      pane.screen.appendChild(c);
      const at = e => toPage(e, pane);
      c.addEventListener("mousedown", e => {
        if (e.button !== 0) return;
        e.preventDefault();
        // One picture per send: marks stay within the pane they started in.
        if (annot.pane !== pane) {
          annot.marks = [];
          annot.pane = pane;
          for (const p of panes) p && p !== pane && drawMarks(p);
        }
        const p = at(e);
        annot.draft = { kind: e.altKey ? (annot.tool === "rect" ? "arrow" : "rect") : annot.tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
      });
      c.addEventListener("mousemove", e => {
        if (!annot.draft || annot.pane !== pane) return;
        const p = at(e);
        annot.draft.x2 = p.x;
        annot.draft.y2 = p.y;
        drawMarks(pane);
      });
      const end = () => {
        const d = annot.draft;
        annot.draft = null;
        if (!d || annot.pane !== pane) return;
        if (Math.hypot(d.x2 - d.x1, d.y2 - d.y1) >= 6) {
          annot.marks.push(d.kind === "arrow" ? d : { kind: "rect", x: Math.min(d.x1, d.x2), y: Math.min(d.y1, d.y2), w: Math.abs(d.x2 - d.x1), h: Math.abs(d.y2 - d.y1) });
        }
        drawMarks(pane);
        $("annotsend").disabled = !annot.marks.length;
      };
      c.addEventListener("mouseup", end);
      c.addEventListener("mouseleave", end);
    }
    return c;
  }

  // Draws marks (page CSS px) into any 2d context; k = context px per page px.
  function paintMarks(g, marks, k, plain) {
    const lw = Math.max(2, 2.5 * k);
    g.lineWidth = lw;
    g.strokeStyle = ACCENT;
    g.fillStyle = ACCENT;
    g.lineJoin = "round";
    g.lineCap = "round";
    marks.forEach((m, i) => {
      let lx;
      let ly;
      if (m.kind === "arrow" || m.x1 !== undefined) {
        const [x1, y1, x2, y2] = [m.x1 * k, m.y1 * k, m.x2 * k, m.y2 * k];
        if (m.kind === "rect") {
          g.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
          return;
        }
        const a = Math.atan2(y2 - y1, x2 - x1);
        const head = Math.max(10, 12 * k);
        g.beginPath();
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
        g.stroke();
        g.beginPath();
        g.moveTo(x2, y2);
        g.lineTo(x2 - head * Math.cos(a - 0.45), y2 - head * Math.sin(a - 0.45));
        g.lineTo(x2 - head * Math.cos(a + 0.45), y2 - head * Math.sin(a + 0.45));
        g.closePath();
        g.fill();
        lx = x1;
        ly = y1;
      } else {
        g.save();
        g.globalAlpha = 0.08;
        g.fillRect(m.x * k, m.y * k, m.w * k, m.h * k);
        g.restore();
        g.strokeRect(m.x * k, m.y * k, m.w * k, m.h * k);
        lx = m.x * k;
        ly = m.y * k;
      }
      if (plain) return;
      // Numbered tag, so the report can say "mark 2".
      const r = Math.max(9, 10 * k);
      g.beginPath();
      g.arc(lx, ly, r, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#fff";
      g.font = `600 ${Math.round(r * 1.2)}px -apple-system, "Segoe UI", sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(String(i + 1), lx, ly + 0.5);
      g.fillStyle = ACCENT;
    });
  }

  function drawMarks(pane) {
    const c = annotLayer(pane);
    const r = pane.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(r.width * dpr));
    c.height = Math.max(1, Math.round(r.height * dpr));
    const g = c.getContext("2d");
    if (annot.pane !== pane) return;
    const k = (r.width * dpr) / (pageDims(r, pane).w || r.width);
    paintMarks(g, annot.marks, k);
    if (annot.draft) {
      g.setLineDash([6 * dpr, 4 * dpr]);
      paintMarks(g, [annot.draft], k, true);
    }
  }

  function setAnnotate(on) {
    annot.on = !!on;
    annot.marks = [];
    annot.draft = null;
    annot.pane = null;
    if (on && picking) togglePick(false);
    $("annotate").classList.toggle("on", annot.on);
    $("annotbar").hidden = !annot.on;
    $("annotsend").disabled = true;
    stage.classList.toggle("annotating", annot.on);
    for (const p of panes) p && drawMarks(p);
    for (const chip of document.querySelectorAll("#annotbar .chip[data-tool]")) chip.classList.toggle("on", chip.dataset.tool === annot.tool);
    if (on) {
      $("annotnote").value = "";
      $("annotnote").focus();
    } else kbd.focus({ preventScroll: true });
  }

  function sendAnnotation() {
    const pane = annot.pane;
    if (!pane || !annot.marks.length) return;
    // The frame as shown, with the marks burnt in; capped so it stays light.
    const src = pane.canvas;
    const scale = Math.min(1, 1600 / src.width);
    const out = document.createElement("canvas");
    out.width = Math.round(src.width * scale);
    out.height = Math.round(src.height * scale);
    const g = out.getContext("2d");
    g.drawImage(src, 0, 0, out.width, out.height);
    paintMarks(g, annot.marks, out.width / (pane.frameCss.w || out.width));
    const data = out.toDataURL("image/png");
    try {
      out.toBlob(b => b && navigator.clipboard.write([new ClipboardItem({ "image/png": b })]).catch(() => {}), "image/png");
    } catch {}
    send({ t: "annotate", pane: pane.index, marks: annot.marks, note: $("annotnote").value, image: data });
    setAnnotate(false);
  }

  $("annotate").onclick = () => setAnnotate(!annot.on);
  $("annotsend").onclick = sendAnnotation;
  $("annotcancel").onclick = () => setAnnotate(false);
  $("annotundo").onclick = () => {
    annot.marks.pop();
    $("annotsend").disabled = !annot.marks.length;
    annot.pane && drawMarks(annot.pane);
  };
  for (const chip of document.querySelectorAll("#annotbar .chip[data-tool]")) {
    chip.onclick = () => {
      annot.tool = chip.dataset.tool;
      for (const c of document.querySelectorAll("#annotbar .chip[data-tool]")) c.classList.toggle("on", c === chip);
    };
  }
  $("annotnote").addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendAnnotation();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setAnnotate(false);
    }
  });
  window.addEventListener("resize", () => annot.on && panes.forEach(p => p && drawMarks(p)));

  // ---------- ⋯ menu ----------
  const menu = $("menu");
  function closeMenu() {
    menu.hidden = true;
    menu.replaceChildren();
  }
  function openMenu() {
    const item = (label, hint, run, checked) => {
      const el = document.createElement("button");
      el.className = "mi" + (checked ? " checked" : "");
      const l = document.createElement("span");
      l.textContent = label;
      const h = document.createElement("span");
      h.className = "hint";
      h.textContent = hint || "";
      el.append(l, h);
      el.onclick = () => {
        closeMenu();
        run();
        kbd.focus({ preventScroll: true });
      };
      return el;
    };
    const sep = () => {
      const el = document.createElement("div");
      el.className = "sep";
      return el;
    };
    const m = isMac ? "⌘" : "Ctrl+";
    const scheme = v => () => send({ t: "scheme", value: v });
    const info = document.createElement("div");
    info.className = "info";
    info.textContent = browserInfo ? `${browserInfo.kind === "managed" ? "Own Chromium" : browserInfo.kind === "system" ? "Installed browser" : "Custom browser"} ${browserInfo.version || ""}`.trim() : "Browser not running";
    menu.replaceChildren(
      item("Hard reload", `${m}⇧R`, () => send({ t: "action", name: "hardReload" })),
      item("Screenshot to clipboard", "", () => send({ t: "action", name: "screenshot" })),
      item("Copy URL", "", () => writeClipboard(nav.url || "")),
      item("Open in default browser", "", () => vscode && nav.url && vscode.postMessage({ type: "external", url: nav.url })),
      sep(),
      item("Zoom in", `${m}+`, () => send({ t: "zoom", dir: 1 })),
      item("Zoom out", `${m}−`, () => send({ t: "zoom", dir: -1 })),
      item(`Reset zoom (${Math.round(zoom * 100)}%)`, `${m}0`, () => send({ t: "zoom", dir: 0 })),
      sep(),
      item("Appearance: system", "", scheme(""), colorScheme === ""),
      item("Appearance: light", "", scheme("light"), colorScheme === "light"),
      item("Appearance: dark", "", scheme("dark"), colorScheme === "dark"),
      sep(),
      item("Clear cookies & storage for this site", "", () => send({ t: "action", name: "clearSite" })),
      item("Restart browser", "", restartBrowser),
      info
    );
    menu.hidden = false;
  }
  $("more").onclick = e => {
    e.stopPropagation();
    if (menu.hidden) openMenu();
    else closeMenu();
  };
  window.addEventListener("mousedown", e => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== $("more") && !$("more").contains(e.target)) closeMenu();
  });
  window.addEventListener("blur", closeMenu);

  // ---------- extension bridge ----------
  window.addEventListener("message", ev => {
    const msg = ev.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "config") {
      const changed = msg.token !== cfg.token || String(msg.port) !== String(cfg.port);
      Object.assign(cfg, { port: msg.port, token: msg.token });
      if (changed || !ws || ws.readyState > 1) connect();
    } else if (msg.type === "pick") togglePick(msg.on);
    else if (msg.type === "navigate") send({ t: "nav", action: "goto", url: msg.url });
    else if (msg.type === "focusPage") kbd.focus({ preventScroll: true });
    else if (msg.type === "files") send({ t: "files", paths: msg.paths || [] });
    else if (msg.type === "restart") restartBrowser();
  });

  if (dtOpen) toggleDevtools(true);
  layout();
  connect();
  if (vscode) vscode.postMessage({ type: "ready" });
})();

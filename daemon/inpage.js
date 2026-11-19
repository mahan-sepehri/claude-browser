// Injected into every document of the shared tab (evaluateOnNewDocument).
// Talks to the daemon through the exposed binding `__cbEmit(json)`.
// Must be self-contained: no imports, runs in the page.
(() => {
  if (window.__cb) return;
  // Set by the engine when Chrome runs as a visible window (no viewer panel):
  // native popups, prompts and the real mouse work, so the headless stand-ins
  // below step aside.
  const WINDOW_MODE = !!window.__cbWindowMode;

  // A pane of the side-by-side view (window mode): an iframe of the engine's
  // side-by-side page, which keeps the panes in step.
  let PANE = null;
  let PANE_MOBILE = false;
  let PANE_TOUCH_UA = "";
  try {
    const fe = window.frameElement;
    if (WINDOW_MODE && fe && fe.dataset && fe.dataset.cbPane) {
      PANE = fe.dataset.cbPane;
      PANE_MOBILE = fe.hasAttribute("data-cb-mobile");
      if (fe.dataset.cbTouch === "1") PANE_TOUCH_UA = fe.dataset.cbUa || "";
    }
  } catch {}
  const toShell = msg => {
    try {
      if (window.parent.__cbShell) window.parent.__cbShell.fromPane(PANE, msg);
    } catch {}
  };

  const emit = msg => {
    try {
      if (PANE) msg = { ...msg, pane: PANE };
      if (typeof window.__cbEmit === "function") window.__cbEmit(JSON.stringify(msg));
    } catch {}
  };

  const SRC_ATTR = "data-dev-src";
  const MAX_CHAIN = 14;
  const Z = "2147483647";

  // ---------- React fiber helpers (works without any project plugin) ----------
  const fiberKey = el => Object.keys(el).find(k => k.startsWith("__reactFiber$"));
  const propsKey = el => Object.keys(el).find(k => k.startsWith("__reactProps$"));

  function getFiber(node) {
    for (let el = node; el; el = el.parentElement) {
      const k = fiberKey(el);
      if (k) return el[k];
    }
    return null;
  }

  function componentName(type) {
    if (!type || typeof type === "string") return null;
    if (type.$$typeof === Symbol.for("react.context")) return `${type.displayName || "Context"}.Provider`;
    if (type.$$typeof === Symbol.for("react.consumer") || type._context)
      return `${(type._context && type._context.displayName) || "Context"}.${type.$$typeof === Symbol.for("react.consumer") ? "Consumer" : "Provider"}`;
    return (
      type.displayName ||
      type.name ||
      (type.render && (type.render.displayName || type.render.name)) ||
      (type.type ? componentName(type.type) : null) ||
      null
    );
  }

  // React 19 dev keeps the stack of where each element was created
  // (`_debugStack`). The frame below the JSX runtime is the usage site, in
  // generated code; the daemon maps ⟦url:line:col⟧ back through source maps.
  const RUNTIME_FRAME = /jsx-dev-runtime|jsx-runtime|react_jsx|react-stack-top-frame|react_stack_bottom_frame|react-dom|\/chunk-[\w-]+\.js/;
  const FRAME = /^\s*at (?:.*? \()?((?:https?|file):\/\/[^\s)]+?):(\d+):(\d+)\)?\s*$/;
  const stackCache = new WeakMap();

  function stackSrc(fiber) {
    const err = fiber._debugStack;
    if (!err || typeof err !== "object") return null;
    if (stackCache.has(err)) return stackCache.get(err);
    let out = null;
    const text = typeof err.stack === "string" ? err.stack : "";
    for (const line of text.split("\n").slice(1)) {
      const m = FRAME.exec(line);
      if (!m) continue;
      if (RUNTIME_FRAME.test(line)) continue;
      // First frame outside React = the component whose JSX created this element.
      if (!/\/node_modules\//.test(m[1])) out = `⟦${m[1]}:${m[2]}:${m[3]}⟧`;
      break;
    }
    stackCache.set(err, out);
    return out;
  }

  function srcOf(fiber) {
    const stamped = fiber.memoizedProps && fiber.memoizedProps[SRC_ATTR];
    if (typeof stamped === "string") return stamped;
    const d = fiber._debugSource; // React <= 18 with jsx-dev-runtime
    if (d && d.fileName) return `${d.fileName}:${d.lineNumber}${d.columnNumber ? ":" + d.columnNumber : ""}`;
    return stackSrc(fiber);
  }

  // Innermost first: the clicked DOM element, then each component above it.
  function buildChain(target) {
    const chain = [];
    let fiber = getFiber(target);
    let seenHost = false;
    let unsourced = 0;
    let sourced = 0;
    while (fiber && sourced < MAX_CHAIN) {
      const src = srcOf(fiber);
      if (typeof fiber.type === "string") {
        if (!seenHost && src) {
          chain.push({ name: `<${fiber.type}>`, src });
          sourced++;
        }
        seenHost = true;
      } else {
        const name = componentName(fiber.type);
        if (src) {
          const prev = chain[chain.length - 1];
          if (!prev || prev.src !== src) {
            chain.push({ name: name || "Anonymous", src });
            sourced++;
          }
        } else if (name && unsourced < 6 && !/^(Context|Anonymous)/.test(name)) {
          // No source info: still useful to know the component names.
          const prev = chain[chain.length - 1];
          if (!prev || prev.name !== name) chain.push({ name, src: "" });
          unsourced++;
        }
      }
      fiber = fiber.return;
    }
    if (chain.some(c => c.src)) {
      // Framework internals without source (router, boundaries) are noise.
      return chain.filter(c => c.src);
    }
    {
      // Not React (or no fiber info): fall back to stamped DOM attributes.
      const own = target.closest && target.closest(`[${SRC_ATTR}]`);
      if (own) {
        chain.unshift({ name: `<${own.tagName.toLowerCase()}>`, src: own.getAttribute(SRC_ATTR) });
        for (let n = own.parentElement && own.parentElement.closest(`[${SRC_ATTR}]`); n && chain.length < 6; n = n.parentElement && n.parentElement.closest(`[${SRC_ATTR}]`)) {
          const src = n.getAttribute(SRC_ATTR);
          if (src.split(":")[0] !== chain[chain.length - 1].src.split(":")[0]) chain.push({ name: `<${n.tagName.toLowerCase()}>`, src });
        }
      }
    }
    return chain;
  }

  // ---------- React inspector: props, state, hooks, context ----------
  const SECRET_KEY = /pass(word)?|secret|token|authorization|api[-_]?key|otp|cvv|pin$/i;

  // Compact, bounded text for any runtime value (no getters are invoked on
  // DOM nodes; cycles and huge structures are cut).
  function show(v, depth = 2, budget = { left: 1200 }, seen = new Set()) {
    const out = t => {
      budget.left -= t.length;
      return t;
    };
    if (budget.left <= 0) return "…";
    if (v === null) return out("null");
    if (v === undefined) return out("undefined");
    const t = typeof v;
    if (t === "string") return out(JSON.stringify(v.length > 160 ? v.slice(0, 160) + "…" : v));
    if (t === "number" || t === "boolean" || t === "bigint") return out(String(v));
    if (t === "symbol") return out(v.toString());
    if (t === "function") return out(`ƒ ${v.name || "anonymous"}()`);
    if (v.nodeType === 1) return out(`<${v.tagName.toLowerCase()}${v.id ? "#" + v.id : ""}>`);
    if (v.nodeType) return out("#node");
    if (v.$$typeof) return out(`<${(typeof v.type === "string" ? v.type : componentName(v.type)) || "Element"} />`);
    if (v instanceof Date) return out(isNaN(v) ? "Invalid Date" : v.toISOString());
    if (v instanceof Error) return out(`${v.name}: ${v.message}`);
    if (seen.has(v)) return out("[circular]");
    if (v instanceof Map || v instanceof Set) return out(`${v instanceof Map ? "Map" : "Set"}(${v.size})`);
    if (depth <= 0) return out(Array.isArray(v) ? `[…${v.length}]` : "{…}");
    seen.add(v);
    let res;
    if (Array.isArray(v)) {
      const items = [];
      for (let i = 0; i < v.length && i < 12 && budget.left > 0; i++) items.push(show(v[i], depth - 1, budget, seen));
      res = `[${items.join(", ")}${v.length > items.length ? `, …${v.length - items.length} more` : ""}]`;
    } else {
      let keys = [];
      try {
        keys = Object.keys(v);
      } catch {}
      const items = [];
      const fns = [];
      // A huge object (a translation table, a cache) is data, not state worth reading.
      const maxItems = keys.length > 40 ? 6 : 24;
      for (const k of keys.slice(0, 60)) {
        if (budget.left <= 0 || items.length >= maxItems) break;
        let val;
        try {
          val = v[k];
        } catch {
          continue;
        }
        // Methods are listed by name only: an API object is mostly noise.
        if (typeof val === "function") {
          fns.push(k);
          continue;
        }
        budget.left -= k.length + 2;
        items.push(`${k}: ${SECRET_KEY.test(k) && typeof val === "string" && val ? '"•••"' : show(val, depth - 1, budget, seen)}`);
      }
      const ctor = v.constructor && v.constructor.name && v.constructor.name !== "Object" ? v.constructor.name + " " : "";
      if (fns.length) items.push(out(`ƒ ${fns.slice(0, 6).join(", ")}${fns.length > 6 ? `, +${fns.length - 6}` : ""}`));
      const rest = keys.length - (items.length - (fns.length ? 1 : 0)) - fns.length;
      res = `${ctor}{${items.join(", ")}${rest > 0 ? `, …${rest} more` : ""}}`;
    }
    seen.delete(v);
    budget.left -= 2;
    return res;
  }

  // 0 function, 1 class, 11 forwardRef, 14/15 memo.
  const isComponent = f => f && (f.tag === 0 || f.tag === 1 || f.tag === 11 || f.tag === 14 || f.tag === 15);
  // Hooks that keep nothing in the fiber's hook list.
  const NO_SLOT = new Set(["useContext", "useDebugValue", "use"]);
  const SILENT = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect", "useImperativeHandle", "useCallback", "useTransition"]);

  function hooksOf(fiber, budget) {
    const out = [];
    if (fiber.tag === 1) {
      if (fiber.memoizedState != null) out.push(`state: ${show(fiber.memoizedState, 3, budget)}`);
      return out;
    }
    const types = Array.isArray(fiber._debugHookTypes) ? fiber._debugHookTypes : null;
    let node = fiber.memoizedState;
    const read = (type, n) => {
      const ms = n.memoizedState;
      if (type === "useRef") return `useRef: ${show(ms && ms.current, 1, budget)}`;
      if (type === "useMemo") return `useMemo: ${show(Array.isArray(ms) ? ms[0] : ms, 2, budget)}`;
      return `${type}: ${show(ms, 3, budget)}`;
    };
    if (types) {
      for (const type of types) {
        if (NO_SLOT.has(type)) continue;
        if (!node || typeof node !== "object") break;
        if (!SILENT.has(type) && budget.left > 0) out.push(read(type, node));
        node = node.next;
      }
    } else {
      // Production build: no hook names. State hooks are the ones with a queue.
      for (let i = 0; node && typeof node === "object" && i < 60; i++, node = node.next) {
        if (node.queue && budget.left > 0) out.push(`state: ${show(node.memoizedState, 3, budget)}`);
      }
    }
    return out;
  }

  function contextsOf(fiber, budget) {
    const out = [];
    let dep = fiber.dependencies && fiber.dependencies.firstContext;
    for (let i = 0; dep && i < 12 && budget.left > 0; i++, dep = dep.next) {
      const name = (dep.context && dep.context.displayName) || "Context";
      out.push(`${name}: ${show(dep.memoizedValue, 1, budget)}`);
    }
    return out;
  }

  function describeComponent(fiber, chars) {
    const budget = { left: chars };
    const props = {};
    const p = fiber.memoizedProps || {};
    for (const k of Object.keys(p)) if (k !== "children" && k !== SRC_ATTR) props[k] = p[k];
    const kids = p.children;
    return {
      name: componentName(fiber.type) || "Anonymous",
      src: srcOf(fiber) || "",
      props: Object.keys(props).length ? show(props, 3, budget) : "",
      children: typeof kids === "string" || typeof kids === "number" ? show(kids, 0, budget) : "",
      hooks: hooksOf(fiber, budget),
      contexts: contextsOf(fiber, budget),
      key: fiber.key != null ? String(fiber.key) : "",
    };
  }

  // The components around an element, nearest first.
  function reactInfo(el, count = 3, chars = 1500) {
    const out = [];
    for (let f = getFiber(el); f && out.length < count; f = f.return) {
      if (!isComponent(f)) continue;
      const name = componentName(f.type);
      if (!name || /^(Context|Anonymous$)/.test(name)) continue;
      out.push(describeComponent(f, out.length ? Math.round(chars / 2) : chars));
    }
    return out;
  }

  function findComponents(name, limit = 5) {
    const want = String(name).toLowerCase();
    const roots = [];
    for (const el of document.querySelectorAll("body, body *")) {
      const k = Object.keys(el).find(x => x.startsWith("__reactContainer$"));
      if (k && el[k]) roots.push(el[k]);
      if (roots.length > 8) break;
    }
    const found = [];
    const exact = [];
    let budget = 20000;
    const walk = f => {
      for (; f && budget-- > 0 && exact.length < limit; f = f.sibling) {
        if (isComponent(f)) {
          const n = (componentName(f.type) || "").toLowerCase();
          if (n === want) exact.push(f);
          else if (n.includes(want) && found.length < limit) found.push(f);
        }
        if (f.child) walk(f.child);
      }
    };
    for (const r of roots) walk(r.stateNode && r.stateNode.current ? r.stateNode.current : r);
    return (exact.length ? exact : found).slice(0, limit);
  }

  // Outline of the component tree below a fiber (names only).
  function componentTree(fiber, maxLines = 120) {
    const lines = [];
    const walk = (f, depth) => {
      for (; f && lines.length < maxLines; f = f.sibling) {
        let d = depth;
        if (isComponent(f)) {
          const n = componentName(f.type);
          if (n && !/^(Context|Anonymous$)/.test(n)) {
            lines.push(`${"  ".repeat(Math.min(depth, 14))}${n}${f.key != null ? ` key=${f.key}` : ""}`);
            d = depth + 1;
          }
        }
        if (f.child) walk(f.child, d);
      }
    };
    if (fiber) {
      const n = isComponent(fiber) ? componentName(fiber.type) : null;
      if (n) lines.push(n);
      walk(fiber.child, n ? 1 : 0);
    }
    return lines;
  }

  function react(spec) {
    const count = Math.min(8, Math.max(1, spec.depth || 3));
    const chars = Math.min(12000, Math.max(300, spec.maxChars || 2500));
    if (spec.component) {
      const fibers = findComponents(spec.component, spec.limit || 3);
      if (!fibers.length) return { error: `no mounted component named "${spec.component}"` };
      return { components: fibers.map(f => describeComponent(f, chars)), tree: spec.tree ? componentTree(fibers[0]) : null };
    }
    let el = null;
    if (spec.ref) el = resolve(spec.ref);
    else if (spec.selector) el = document.querySelector(spec.selector);
    else if (spec.text) el = findByText(spec.text);
    else {
      // No target: the app itself, from its outermost component.
      for (const c of document.querySelectorAll("body *")) {
        if (fiberKey(c)) {
          el = c;
          break;
        }
      }
      if (!el) return { error: "no React app found on this page" };
      let top = null;
      for (let f = getFiber(el); f; f = f.return) if (isComponent(f) && componentName(f.type)) top = f;
      return { components: top ? [describeComponent(top, chars)] : [], tree: componentTree(top, 200) };
    }
    if (!el) return { error: "element not found" };
    if (!getFiber(el)) return { error: "this element is not rendered by React (no fiber found)" };
    let owner = getFiber(el);
    while (owner && !isComponent(owner)) owner = owner.return;
    return { components: reactInfo(el, count, chars), tree: spec.tree ? componentTree(owner) : null };
  }

  // ---------- element description ----------
  const clip = (text, max = 80) => {
    const one = String(text).replace(/\s+/g, " ").trim();
    return one.length > max ? one.slice(0, max) + "…" : one;
  };

  function labelFor(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map(id => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(" ");
      if (t) return t;
    }
    if (el.id) {
      try {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l && l.textContent.trim()) return l.textContent.trim();
      } catch {}
    }
    const wrap = el.closest && el.closest("label");
    return (wrap && wrap.textContent.trim()) || el.getAttribute("title") || el.getAttribute("alt") || null;
  }

  function cssPath(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 6; n = n.parentElement) {
      if (n.id && !/\d{3,}|:/.test(n.id)) {
        parts.unshift(`#${CSS.escape(n.id)}`);
        break;
      }
      let part = n.tagName.toLowerCase();
      const testId = n.getAttribute("data-testid");
      if (testId) {
        parts.unshift(`${part}[data-testid="${testId}"]`);
        break;
      }
      const parent = n.parentElement;
      if (parent) {
        const same = [...parent.children].filter(c => c.tagName === n.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(n) + 1})`;
      }
      parts.unshift(part);
    }
    return parts.join(" > ");
  }

  // ---------- pick card: a few lines that say what the element is ----------
  // A pick has to be understood, not dumped: the card names the element the
  // way a person would (role, name, where on the page) in about 100 tokens.
  // Everything else is fetched only when the task needs it (inspect()).
  const ROLE_OF_TAG = {
    A: "link", BUTTON: "button", NAV: "navigation", MAIN: "main", HEADER: "header", FOOTER: "footer", ASIDE: "sidebar",
    FORM: "form", DIALOG: "dialog", TABLE: "table", UL: "list", OL: "list", LI: "list item", IMG: "image", SELECT: "select",
    TEXTAREA: "text area", LABEL: "label", SECTION: "section", ARTICLE: "article", FIELDSET: "group", VIDEO: "video",
    CANVAS: "canvas", IFRAME: "frame", TR: "row", TD: "cell", TH: "column header", P: "paragraph", svg: "icon", SVG: "icon",
  };
  const LANDMARK = /^(navigation|main|banner|contentinfo|complementary|region|dialog|alertdialog|form|search|tabpanel|menu|menubar|listbox|grid|table|toolbar|tablist|tree)$/;
  const LANDMARK_TAGS = new Set(["NAV", "MAIN", "HEADER", "FOOTER", "ASIDE", "FORM", "DIALOG", "TABLE", "FIELDSET"]);
  const NAMED_SECTION_TAGS = new Set(["SECTION", "ARTICLE"]);
  const WRAPPER_NAME = /^(ForwardRef|Memo|Anonymous|Context|Provider|Consumer|Fragment|Suspense|StrictMode|Profiler|Slot|Slottable|Primitive|Presence|Portal|DismissableLayer|FocusScope|RemoveScroll|Popper|AnimatePresence|LayoutGroup|MotionConfig|ErrorBoundary|Router|Routes|Route|RouteComponent|Outlet|MatchInner|Match|Transition|TransitionGroup|Styled|Emotion|Insertion)/;

  function roleOf(el) {
    const r = el.getAttribute("role");
    if (r) return r;
    const t = el.tagName;
    if (/^H[1-6]$/.test(t)) return "heading " + t[1];
    if (t === "INPUT") {
      const ty = (el.getAttribute("type") || "text").toLowerCase();
      return { checkbox: "checkbox", radio: "radio", range: "slider", submit: "button", button: "button", reset: "button", file: "file input", search: "search box" }[ty] || "text field";
    }
    return ROLE_OF_TAG[t] || ROLE_OF_TAG[el.localName] || "";
  }

  function nameOf(el, max = 60) {
    const l = labelFor(el);
    if (l) return clip(l, max);
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return clip(el.placeholder || "", max);
    if (el instanceof SVGElement) {
      const t = el.querySelector && el.querySelector("title");
      return t ? clip(t.textContent, max) : "";
    }
    const raw = el instanceof HTMLElement ? el.innerText : el.textContent;
    return raw ? clip(raw.replace(/\n+/g, " · "), max) : "";
  }

  // A container's own name: aria, its heading, legend or caption.
  function sectionName(el) {
    const l = el.getAttribute("aria-label") || (el.getAttribute("aria-labelledby") && labelFor(el));
    if (l) return clip(l, 40);
    const h = el.querySelector(":scope > legend, :scope > caption, h1, h2, h3, h4, h5, h6, [role=heading]");
    return h && h.innerText ? clip(h.innerText, 40) : "";
  }

  function shortTag(el) {
    let s = el.localName;
    if (el.id && !/\d{3,}|:/.test(el.id)) s += "#" + el.id;
    return s;
  }

  // What it is: `button "Pay now" · 320×48`.
  function whatIs(el) {
    const tag = el.localName;
    const role = roleOf(el);
    const parts = [];
    let head = tag;
    const explicit = el.getAttribute("role");
    if (explicit) head += ` [role=${explicit}]`;
    else if (role && tag !== "input" && !/^(link|button|list|list item|image|select|label|section|article|row|cell|paragraph|form|table|dialog|navigation|main|header|footer)$/.test(role) && !(role === "icon" && tag === "svg")) head += ` (${role})`;
    if (tag === "input") head += `[type=${(el.getAttribute("type") || "text").toLowerCase()}]`;
    const name = nameOf(el);
    parts.push(name ? `${head} "${name}"` : head);
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      // The value itself may be personal data: say only whether it's filled.
      if (el.type === "checkbox" || el.type === "radio") parts.push(el.checked ? "checked" : "unchecked");
      else parts.push(el.value ? "filled" : "empty");
      if (el.disabled) parts.push("disabled");
    }
    if (el instanceof HTMLAnchorElement && el.getAttribute("href")) {
      let h = el.getAttribute("href");
      try {
        const u = new URL(el.href);
        h = u.origin === location.origin ? u.pathname + u.search : u.href;
      } catch {}
      parts.push("→ " + clip(h, 60));
    }
    if (el instanceof HTMLImageElement) parts.push(clip((el.currentSrc || el.src || "").split(/[?#]/)[0].split("/").pop(), 40));
    // A span in a heading, an icon in a button: say what it's part of.
    if (!el.getAttribute("role") && !/^(a|button|label|h[1-6])$/.test(tag)) {
      const host = el.parentElement && el.parentElement.closest("a, button, label, h1, h2, h3, h4, h5, h6, [role=button], [role=link], [role=tab], [role=menuitem]");
      if (host && host !== document.body) {
        const hn = nameOf(host, 40);
        parts.push(`inside ${host.localName}${hn && hn !== name ? ` "${hn}"` : ""}`);
      }
    }
    if (el.getAttribute("aria-expanded")) parts.push(el.getAttribute("aria-expanded") === "true" ? "expanded" : "collapsed");
    if (el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-current")) parts.push("current");
    if (!role && el.children.length > 1) parts.push(`${el.children.length} children`);
    const r = el.getBoundingClientRect();
    parts.push(`${Math.round(r.width)}×${Math.round(r.height)}`);
    return parts.join(" · ");
  }

  // Where it is: the named regions around it, outermost first.
  function whereIs(el) {
    const out = [];
    for (let n = el.parentElement; n && n !== document.body && out.length < 4; n = n.parentElement) {
      const role = n.getAttribute("role");
      const isLandmark = (role && LANDMARK.test(role)) || LANDMARK_TAGS.has(n.tagName);
      let name = isLandmark || NAMED_SECTION_TAGS.has(n.tagName) || role === "group" ? sectionName(n) : "";
      if (name && name === nameOf(el, 40)) name = ""; // named by the picked element itself
      if (!isLandmark && !name) continue;
      const label = role || ROLE_OF_TAG[n.tagName] || n.localName;
      out.unshift(name ? `${label} "${name}"` : label);
    }
    // The nearest heading above it in its own part of the page.
    let under = "";
    const HEADS = "h1, h2, h3, h4, h5, h6, [role=heading]";
    for (let n = el.parentElement, d = 0; n && n !== document.body && d < 6 && !under && !/^heading/.test(roleOf(el)); n = n.parentElement, d++) {
      const hs = [...n.querySelectorAll(HEADS)].filter(h => h !== el && !h.contains(el) && !el.contains(h) && h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING && h.getBoundingClientRect().height > 0);
      if (hs.length) under = clip(hs[hs.length - 1].innerText || "", 40);
    }
    if (under && !out.some(s => s.includes(`"${under}"`))) out.push(`under heading "${under}"`);
    // Its place in a repeated list.
    for (let n = el, i = 0; n && i < 4; n = n.parentElement, i++) {
      if (!/^(LI|TR|OPTION)$/.test(n.tagName) && !/^(row|listitem|option|tab|menuitem|gridcell)$/.test(n.getAttribute("role") || "")) continue;
      const sibs = n.parentElement ? [...n.parentElement.children].filter(c => c.tagName === n.tagName) : [n];
      if (sibs.length > 1) out.push(`${roleOf(n) || n.localName} ${sibs.indexOf(n) + 1} of ${sibs.length}`);
      break;
    }
    return out.join(" › ");
  }

  // The nearest component name worth reading (skips library wrappers).
  function componentOf(el) {
    for (let f = getFiber(el), i = 0; f && i < 40; f = f.return, i++) {
      if (!isComponent(f)) continue;
      const n = componentName(f.type);
      // Two-letter names are a minifier's (production builds), not the author's.
      if (n && /^[A-Z]/.test(n) && n.length > 2 && !WRAPPER_NAME.test(n) && !/^motion\./.test(n)) return n;
    }
    // Vue / Svelte dev builds keep a component name too.
    for (let n = el; n; n = n.parentElement) {
      const v = n.__vueParentComponent;
      if (v && v.type) return v.type.name || v.type.__name || (v.type.__file || "").split("/").pop().replace(/\.vue$/, "") || "";
      if (n.__svelte_meta && n.__svelte_meta.loc) return n.__svelte_meta.loc.file.split("/").pop();
    }
    return "";
  }

  function buildReport(el) {
    // A click on an icon lands on one of its paths: the icon is what's meant.
    if (el instanceof SVGElement && el.ownerSVGElement) {
      let svg = el.ownerSVGElement;
      while (svg.ownerSVGElement) svg = svg.ownerSVGElement;
      el = svg;
    }
    const chain = buildChain(el);
    const card = { what: whatIs(el), where: whereIs(el), component: componentOf(el), pane: PANE ? `${PANE} ${innerWidth}×${innerHeight}` : "" };
    const ref = refFor(el);
    const lines = [`[Picked in the browser] ${card.what}`];
    if (card.where) lines.push(`In: ${card.where}`);
    lines.push(`Page: ${clip(document.title, 60)} — ${location.href.split("#")[0]}`);
    if (card.component) lines.push(`Component: <${card.component}>`);
    return { report: lines.join("\n"), card, chain, ref, selector: cssPath(el) };
  }

  // ---------- inspect: details of one element, only when asked ----------
  function findEl(spec) {
    let el = null;
    if (spec.ref) el = resolve(spec.ref);
    if (!el && spec.selector) {
      try {
        el = document.querySelector(spec.selector);
      } catch {}
    }
    if (!el && spec.text) el = findByText(spec.text);
    return el;
  }

  // Computed values worth knowing, with the values that mean "nothing set".
  const STYLE_PROPS = [
    ["display"], ["position", "static"], ["top", "auto"], ["right", "auto"], ["bottom", "auto"], ["left", "auto"], ["z-index", "auto"],
    ["box-sizing"], ["margin", "0px"], ["padding", "0px"], ["min-width", "auto", "0px"], ["max-width", "none"], ["min-height", "auto", "0px"], ["max-height", "none"],
    ["flex-direction", "row"], ["flex-wrap", "nowrap"], ["justify-content", "normal"], ["align-items", "normal"], ["align-content", "normal"], ["gap", "normal"],
    ["flex", "0 1 auto"], ["align-self", "auto"], ["order", "0"], ["grid-template-columns", "none"], ["grid-template-rows", "none"], ["grid-auto-flow", "row"],
    ["grid-column", "auto"], ["grid-row", "auto"], ["overflow", "visible"], ["aspect-ratio", "auto"], ["object-fit", "fill"],
    ["font-family"], ["font-size"], ["font-weight"], ["font-style", "normal"], ["line-height"], ["letter-spacing", "normal"], ["text-align", "start"],
    ["text-transform", "none"], ["text-decoration-line", "none"], ["white-space", "normal"], ["text-overflow", "clip"], ["direction", "ltr"],
    ["color"], ["background-color", "rgba(0, 0, 0, 0)"], ["background-image", "none"], ["border-top", "0px none", "0px"], ["border-right", "0px none", "0px"],
    ["border-bottom", "0px none", "0px"], ["border-left", "0px none", "0px"], ["border-radius", "0px"], ["outline-style", "none"], ["box-shadow", "none"],
    ["opacity", "1"], ["transform", "none"], ["transform-origin"], ["filter", "none"], ["backdrop-filter", "none"], ["mix-blend-mode", "normal"],
    ["clip-path", "none"], ["mask-image", "none"], ["visibility", "visible"], ["pointer-events", "auto"], ["cursor", "auto"],
    ["transition", "all", "all 0s ease 0s"], ["animation-name", "none"], ["will-change", "auto"], ["content", "normal", "none"],
  ];
  const ALWAYS = new Set(["display", "font-family", "font-size", "font-weight", "line-height", "color"]);

  function styleMap(el, pseudo, props = STYLE_PROPS) {
    const cs = getComputedStyle(el, pseudo || null);
    const out = {};
    for (const [p, ...none] of props) {
      let v = cs.getPropertyValue(p);
      if (p.startsWith("border-") && p !== "border-radius") v = v.replace(/ rgb\(\d+, \d+, \d+\)$| rgba\([^)]*\)$/, m => (v.startsWith("0px") ? "" : m));
      if (p === "transform-origin" && cs.transform === "none") continue;
      // Offsets only mean something when positioned (Chrome resolves auto to 0px for relative).
      if (/^(top|right|bottom|left)$/.test(p) && (cs.position === "static" || (cs.position === "relative" && v === "0px"))) continue;
      if (p === "transition") {
        if (/^all 0s ease 0s$|^all$/.test(v) || cs.transitionDuration.split(",").every(d => parseFloat(d) === 0)) continue;
      }
      if (!v || none.some(n => v === n || v.startsWith(n + " ") && p.startsWith("border-"))) continue;
      out[p] = v;
    }
    return out;
  }

  const fmtStyles = m => {
    const sides = ["border-top", "border-right", "border-bottom", "border-left"];
    if (sides.every(k => m[k] && m[k] === m["border-top"])) {
      m = { ...m, border: m["border-top"] };
      for (const k of sides) delete m[k];
    }
    return Object.entries(m).map(([k, v]) => `  ${k}: ${clip(v, 160)}`).join("\n");
  };

  function stylesOf(el) {
    const own = styleMap(el);
    const lines = [`${whatIs(el)}`, fmtStyles(own)];
    for (const ps of ["::before", "::after"]) {
      const c = getComputedStyle(el, ps).content;
      if (!c || c === "none" || c === "normal") continue;
      const m = styleMap(el, ps);
      lines.push(`${ps}:`, fmtStyles(m));
    }
    return lines.join("\n");
  }

  // Small style set used to see what changes on hover/focus (element + inside).
  const STATE_PROPS = ["color", "background-color", "background-image", "border-color", "border-width", "outline", "box-shadow", "opacity", "transform", "filter", "text-decoration-line", "visibility", "display", "width", "height", "scale", "translate"];
  function stateSnapshot(el) {
    const nodes = [el, ...[...el.querySelectorAll("*")].slice(0, 40)];
    return nodes.map(n => {
      const cs = getComputedStyle(n);
      const o = {};
      for (const p of STATE_PROPS) o[p] = cs.getPropertyValue(p);
      return o;
    });
  }
  function finishTransitions(el) {
    for (const a of el.getAnimations({ subtree: true })) if (a instanceof CSSTransition) a.finish();
  }
  function stateDiff(el, before, after) {
    const nodes = [el, ...[...el.querySelectorAll("*")].slice(0, 40)];
    const out = [];
    after.forEach((a, i) => {
      const b = before[i];
      if (!b || !nodes[i]) return;
      const ch = STATE_PROPS.filter(p => a[p] !== b[p] && !(p === "outline" && / none /.test(a[p]) && / none /.test(b[p]))).map(p => `${p}: ${clip(b[p], 60)} → ${clip(a[p], 60)}`);
      if (ch.length) out.push(`  ${i ? shortTag(nodes[i]) + (nameOf(nodes[i], 20) ? ` "${nameOf(nodes[i], 20)}"` : "") : "the element"}: ${ch.join("; ")}`);
    });
    return out;
  }

  function layoutOf(el) {
    const box = n => {
      const r = n.getBoundingClientRect();
      return `${Math.round(r.width)}×${Math.round(r.height)} at (${Math.round(r.left)}, ${Math.round(r.top)})`;
    };
    const cs = getComputedStyle(el);
    const lines = [`${whatIs(el)} — ${box(el)}`];
    const pick = (c, ps) => ps.map(p => [p, c.getPropertyValue(p)]).filter(([p, v]) => v && !/^(normal|none|auto|0px|static|visible|nowrap|row|0 1 auto|stretch)$/.test(v)).map(([p, v]) => `${p}: ${v}`).join("; ");
    lines.push(`  ${pick(cs, ["display", "position", "top", "right", "bottom", "left", "z-index", "box-sizing", "margin", "padding", "border-width", "overflow", "flex", "align-self", "order", "grid-column", "grid-row"])}`);
    if (/^(absolute|fixed|sticky)$/.test(cs.position) && el.offsetParent) lines.push(`  positioned against: ${shortTag(el.offsetParent)} ${box(el.offsetParent)}`);
    const p = el.parentElement;
    if (p) {
      const pcs = getComputedStyle(p);
      lines.push(`Parent ${shortTag(p)} — ${box(p)}`, `  ${pick(pcs, ["display", "flex-direction", "flex-wrap", "justify-content", "align-items", "gap", "grid-template-columns", "grid-template-rows", "padding", "position", "overflow"])}`);
    }
    if (/flex|grid/.test(cs.display)) lines.push(`  (as a container) ${pick(cs, ["flex-direction", "flex-wrap", "justify-content", "align-items", "align-content", "gap", "grid-template-columns", "grid-template-rows", "grid-auto-flow"])}`);
    const kids = [...el.children];
    if (kids.length) {
      lines.push(`Children (${kids.length}):`);
      for (const k of kids.slice(0, 10)) {
        const kc = getComputedStyle(k);
        const extra = pick(kc, ["position", "flex", "align-self", "grid-column", "grid-row", "margin"]);
        lines.push(`  ${shortTag(k)}${nameOf(k, 30) ? ` "${nameOf(k, 30)}"` : ""} ${box(k)}${kc.display === "none" ? " (hidden)" : ""}${extra ? "  " + extra : ""}`);
      }
      if (kids.length > 10) lines.push(`  … ${kids.length - 10} more`);
    }
    return lines.join("\n");
  }

  function keyframesText(name) {
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // cross-origin sheet
      }
      for (const r of rules || []) if (r instanceof CSSKeyframesRule && r.name === name) return clip(r.cssText, 600);
    }
    return "";
  }

  function libsInPage() {
    const w = window;
    const found = [];
    if (w.gsap) found.push(`GSAP ${w.gsap.version || ""}`.trim());
    if (w.ScrollTrigger) found.push("ScrollTrigger");
    if (w.anime) found.push("anime.js");
    if (w.lottie || w.bodymovin || document.querySelector("lottie-player, dotlottie-player")) found.push("Lottie");
    if (w.__THREE__) found.push(`three.js r${w.__THREE__}`);
    if (w.Swiper || document.querySelector(".swiper")) found.push("Swiper");
    if (w.AOS || document.querySelector("[data-aos]")) found.push("AOS");
    if (w.lenis || document.documentElement.classList.contains("lenis")) found.push("Lenis smooth scroll");
    if (w.LocomotiveScroll || document.querySelector("[data-scroll-container]")) found.push("Locomotive Scroll");
    if (w.Motion || document.querySelector("[data-framer-name], [data-projection-id]")) found.push("Framer Motion");
    return found;
  }

  function animationsOf(el) {
    const lines = [];
    const anims = el.getAnimations({ subtree: true });
    const who = t => (t === el ? "the element" : t ? shortTag(t) : "?");
    if (anims.length) {
      lines.push(`Running now (${anims.length}):`);
      for (const a of anims.slice(0, 12)) {
        const e = a.effect;
        const t = e && e.getTiming ? e.getTiming() : {};
        const kind = a instanceof CSSAnimation ? `CSS animation "${a.animationName}"` : a instanceof CSSTransition ? `CSS transition of ${a.transitionProperty}` : `Web Animation${a.id ? ` "${a.id}"` : ""}`;
        const timeline = a.timeline && a.timeline.constructor && a.timeline.constructor.name !== "DocumentTimeline" ? `, ${a.timeline.constructor.name}` : "";
        lines.push(`  ${kind} on ${who(e && e.target)}: ${t.duration}ms ${t.easing || ""}${t.delay ? `, delay ${t.delay}ms` : ""}${t.iterations !== 1 ? `, ×${t.iterations}` : ""}${t.direction && t.direction !== "normal" ? `, ${t.direction}` : ""}, ${a.playState}${timeline}`);
        if (!(a instanceof CSSTransition) && e && e.getKeyframes) {
          const kf = e.getKeyframes().map(k => {
            const props = Object.entries(k).filter(([p]) => !["offset", "computedOffset", "easing", "composite"].includes(p)).map(([p, v]) => `${p}: ${v}`);
            return `${Math.round((k.computedOffset ?? k.offset) * 100)}% {${props.join("; ")}}`;
          });
          lines.push("    " + clip(kf.join(" "), 400));
        }
      }
    }
    const declared = [];
    for (const n of [el, ...[...el.querySelectorAll("*")].slice(0, 80)]) {
      const cs = getComputedStyle(n);
      if (cs.animationName && cs.animationName !== "none") declared.push(`  ${who(n)}: animation ${cs.animationName} ${cs.animationDuration} ${cs.animationTimingFunction}${cs.animationIterationCount !== "1" ? ` ×${cs.animationIterationCount}` : ""}${cs.animationTimeline && cs.animationTimeline !== "auto" ? ` timeline ${cs.animationTimeline}` : ""}`);
      if (cs.transitionDuration.split(",").some(d => parseFloat(d) > 0)) declared.push(`  ${who(n)}: transition ${clip(cs.transition, 140)}`);
      if (declared.length >= 12) break;
    }
    if (declared.length) lines.push("Declared in CSS:", ...declared);
    const names = new Set();
    for (const n of [el, ...el.querySelectorAll("*")]) {
      const v = getComputedStyle(n).animationName;
      if (v && v !== "none") v.split(",").forEach(x => names.add(x.trim()));
      if (names.size >= 4) break;
    }
    for (const n of names) {
      const k = keyframesText(n);
      if (k) lines.push(k);
    }
    if (window.gsap && window.gsap.getTweensOf) {
      const tw = window.gsap.getTweensOf([el, ...el.querySelectorAll("*")]);
      if (tw.length) lines.push(`GSAP tweens on it: ${tw.length} (${tw.slice(0, 3).map(t => clip(JSON.stringify(t.vars, (k, v) => (typeof v === "function" ? "ƒ" : v instanceof Element ? "el" : v)), 120)).join("; ")})`);
    }
    const inline = el.getAttribute("style") || "";
    if (/transform|opacity|filter|translate|scale|rotate/.test(inline)) lines.push(`Inline style set by script (a JS animation's current or final state): ${clip(inline, 200)}`);
    const libs = libsInPage();
    if (libs.length) lines.push(`Animation libraries on the page: ${libs.join(", ")}`);
    if (!lines.length || (lines.length === 1 && lines[0].startsWith("Inline style"))) lines.push("No CSS animations, transitions or Web Animations on it right now. If it moves on scroll or hover, inspect it with ms (watches style changes) or aspect events.");
    return lines.join("\n");
  }

  // Watches style/class changes on the element and inside it for `ms`: what
  // JavaScript-driven effects actually change. With scroll, the page scrolls
  // the element up through the viewport meanwhile (scroll-linked effects), and
  // goes back to where it was after.
  function watchChanges(el, ms, scroll) {
    return new Promise(res => {
      const seen = new Map();
      const note = (n, what, from, to) => {
        const k = `${n === el ? "the element" : shortTag(n)} ${what}`;
        const e = seen.get(k) || { n: 0, first: from, last: to };
        e.n++;
        e.last = to;
        seen.set(k, e);
      };
      const mo = new MutationObserver(list => {
        for (const m of list) note(m.target, m.attributeName, m.oldValue, m.target.getAttribute(m.attributeName));
      });
      const scroller = document.scrollingElement || document.documentElement;
      const startY = scroller.scrollTop;
      let from = 0;
      let to = 0;
      if (scroll) {
        const top = el.getBoundingClientRect().top + startY;
        from = Math.max(0, top - innerHeight);
        to = Math.min(scroller.scrollHeight - innerHeight, top + el.getBoundingClientRect().height);
        scroller.scrollTop = from;
      }
      mo.observe(el, { attributes: true, attributeOldValue: true, subtree: true, attributeFilter: ["style", "class", "data-state", "aria-expanded", "hidden"] });
      const samples = [];
      const sample = () => {
        const cs = getComputedStyle(el);
        const v = `opacity ${cs.opacity}, transform ${cs.transform}${cs.filter !== "none" ? `, filter ${cs.filter}` : ""}`;
        if (samples[samples.length - 1] !== v) samples.push(v);
      };
      sample();
      const t0 = performance.now();
      const tick = () => {
        const p = Math.min(1, (performance.now() - t0) / ms);
        if (scroll) scroller.scrollTop = from + (to - from) * p;
        sample();
        if (p < 1) next(tick);
        else done();
      };
      // A hidden tab gets no animation frames.
      const next = cb => (document.hidden ? setTimeout(cb, 16) : requestAnimationFrame(cb));
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        mo.disconnect();
        if (scroll) scroller.scrollTop = startY;
        const lines = [...seen].slice(0, 15).map(([k, e]) => `  ${k} changed ${e.n}×: ${clip(e.first || "(none)", 80)} → ${clip(e.last || "(none)", 80)}`);
        if (samples.length > 1) {
          const pickN = samples.length <= 5 ? samples : [0, 1, 2, 3, 4].map(i => samples[Math.round((i * (samples.length - 1)) / 4)]);
          lines.push(`  the element's computed style went through ${samples.length} states: ${pickN.map(x => clip(x, 110)).join("  →  ")}`);
        }
        res(lines.length ? `Changes in ${ms}ms${scroll ? " while scrolling it through the viewport" : ""}:\n${lines.join("\n")}` : `No style or class changes in ${ms}ms${scroll ? " while scrolling it through the viewport" : ""}.`);
      };
      next(tick);
      setTimeout(done, ms + 2000);
    });
  }

  // Trimmed outerHTML: structure and classes, not every byte.
  function htmlOf(el, budget = 3000) {
    const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const attrStr = n => {
      let s = "";
      for (const a of n.attributes) {
        if (a.name === SRC_ATTR || a.name.startsWith("data-cb")) continue;
        let v = a.value;
        const max = a.name === "class" ? 300 : a.name === "d" ? 40 : /^(src|href|srcset)$/.test(a.name) && v.startsWith("data:") ? 30 : 160;
        if (v.length > max) v = v.slice(0, max) + "…";
        s += v === "" ? ` ${a.name}` : ` ${a.name}="${v.replace(/"/g, "&quot;")}"`;
      }
      return s;
    };
    const walk = (n, depth) => {
      if (n.nodeType === 3) {
        const t = n.textContent.replace(/\s+/g, " ").trim();
        return t ? esc(clip(t, 80)) : "";
      }
      if (n.nodeType !== 1 || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(n.tagName)) return "";
      const tag = n.localName;
      const kids = [...n.childNodes];
      if (!kids.length) return `<${tag}${attrStr(n)}>${/^(img|input|br|hr|meta|link|source|path|circle|rect|line|polyline|polygon|use|stop)$/.test(tag) ? "" : `</${tag}>`}`;
      if (depth >= 4) return `<${tag}${attrStr(n)}>…</${tag}>`;
      const shown = kids.slice(0, 8).map(k => walk(k, depth + 1)).join("");
      const more = kids.filter(k => k.nodeType === 1).length > 8 ? `<!-- ${kids.length - 8} more -->` : "";
      return `<${tag}${attrStr(n)}>${shown}${more}</${tag}>`;
    };
    const out = walk(el, 0);
    return out.length > budget ? out.slice(0, budget) + `… (${out.length} chars in all)` : out;
  }

  // React event props on the element and the components above it.
  function reactHandlers(el) {
    const out = [];
    for (let n = el, i = 0; n && n !== document.body && i < 8; n = n.parentElement, i++) {
      const k = propsKey(n);
      if (!k || !n[k]) continue;
      for (const [p, v] of Object.entries(n[k])) {
        if (/^on[A-Z]/.test(p) && typeof v === "function") out.push({ owner: n === el ? "the element" : shortTag(n), prop: p, fn: v, code: clip(String(v), 140) });
      }
      if (out.length >= 10) break;
    }
    return out;
  }

  function inspect(spec, aspect, opts = {}) {
    const el = findEl(spec);
    if (!el) return { error: "element not found (it may have been re-rendered; pick it again)" };
    switch (aspect) {
      case "styles":
        return { text: stylesOf(el) };
      case "layout":
        return { text: layoutOf(el) };
      case "animation":
        return opts.ms ? watchChanges(el, Math.min(opts.ms, 8000), !!opts.scroll).then(w => ({ text: animationsOf(el) + "\n" + w })) : { text: animationsOf(el) };
      case "html":
        return { text: htmlOf(el, opts.maxChars || 3000) };
      default:
        return { error: `unknown aspect ${aspect}` };
    }
  }

  // ---------- cursor tracking ----------
  let lastCursor = "";
  let cursorPending = false;
  let cursorTarget = null;
  document.addEventListener(
    "mousemove",
    e => {
      cursorTarget = e.target;
      if (cursorPending) return;
      cursorPending = true;
      requestAnimationFrame(() => {
        cursorPending = false;
        const t = cursorTarget;
        if (!(t instanceof Element)) return;
        let c = getComputedStyle(t).cursor;
        if (c === "auto") {
          c = t.isContentEditable || t.matches("input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea") ? "text" : "default";
        }
        if (picking) c = "crosshair";
        if (c !== lastCursor) {
          lastCursor = c;
          if (!WINDOW_MODE) emit({ t: "cursor", v: c });
        }
      });
    },
    true
  );

  // ---------- native popups (<select>, date/time/color) ----------
  // Headless Chrome never paints these popups, so the viewer draws its own.
  const PICKER_TYPES = new Set(["date", "time", "datetime-local", "month", "week", "color"]);

  function popupTarget(el) {
    if (!(el instanceof Element)) return null;
    const sel = el.closest("select");
    if (sel && !sel.multiple && !(sel.size > 1) && !sel.disabled) return sel;
    if (el instanceof HTMLInputElement && PICKER_TYPES.has(el.type) && !el.disabled && !el.readOnly) return el;
    return null;
  }

  function describePopup(el) {
    const r = el.getBoundingClientRect();
    const base = { t: "popup", ref: refFor(el), rect: { x: r.left, y: r.top, width: r.width, height: r.height } };
    if (el instanceof HTMLSelectElement) {
      const options = [];
      for (const child of el.children) {
        if (child instanceof HTMLOptGroupElement) {
          options.push({ group: child.label });
          for (const o of child.children) options.push({ label: o.text, value: o.value, disabled: o.disabled || child.disabled, index: o.index });
        } else if (child instanceof HTMLOptionElement) {
          options.push({ label: child.text, value: child.value, disabled: child.disabled, index: child.index });
        }
      }
      const cs = getComputedStyle(el);
      return { ...base, kind: "select", options, selectedIndex: el.selectedIndex, dir: cs.direction, font: cs.fontFamily };
    }
    return { ...base, kind: "input", inputType: el.type, value: el.value, min: el.min, max: el.max, step: el.step };
  }

  window.addEventListener(
    "mousedown",
    e => {
      if (WINDOW_MODE || picking || e.button !== 0) return;
      const el = popupTarget(e.target);
      if (!el) return;
      e.preventDefault();
      el.focus();
      emit(describePopup(el));
    },
    true
  );
  window.addEventListener(
    "keydown",
    e => {
      // Keys that would open the native popup on a focused control.
      if (WINDOW_MODE) return;
      const el = popupTarget(document.activeElement);
      if (!el || picking) return;
      const opens = el instanceof HTMLSelectElement ? (e.altKey && /Arrow(Down|Up)/.test(e.key)) || e.key === " " || (/^Arrow(Down|Up)$/.test(e.key) && navigator.platform.startsWith("Mac")) : e.key === " " || e.key === "Enter";
      if (!opens) return;
      e.preventDefault();
      emit(describePopup(el));
    },
    true
  );

  // Sets a form control's value the way user input would, so frameworks
  // (React tracks the native value setter) see the change.
  function setValue(ref, value) {
    const el = resolve(ref);
    if (!el) return false;
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  // Keep the viewer's tab titles fresh for SPAs that set document.title.
  let lastTitle = document.title;
  setInterval(() => {
    if (document.title !== lastTitle) {
      lastTitle = document.title;
      emit({ t: "title" });
    }
  }, 1000);

  // ---------- pick mode ----------
  // The engine drives picking: it forwards pointer moves (so hover states and
  // this highlight keep working) and calls pickAt() for the click instead of
  // letting the page see it. That way disabled controls, links and elements
  // behind click handlers are all picked the same way.
  let picking = false;
  let overlay = null;
  let lastPt = null; // pointer position, top-window viewport px
  let leaf = null; // element under the pointer
  let level = 0; // how many ancestors above `leaf` the highlight sits
  let current = null; // the highlighted element: what a click picks
  let pickTimer = null;

  function ensureOverlay() {
    if (overlay && overlay.box.isConnected) return overlay;
    const box = document.createElement("div");
    box.style.cssText = `position:fixed;z-index:${Z};border:2px solid #d97757;background:rgba(217,119,87,.14);border-radius:3px;display:none;margin:0;padding:0;box-sizing:border-box;`;
    const tag = document.createElement("div");
    tag.style.cssText = `position:fixed;z-index:${Z};background:#d97757;color:#fff;font:12px/1.4 ui-monospace,Menlo,monospace;padding:2px 6px;border-radius:3px;display:none;direction:ltr;white-space:nowrap;max-width:90vw;overflow:hidden;text-overflow:ellipsis;margin:0;`;
    // Never a hit-test target, whatever the page's CSS says.
    box.style.setProperty("pointer-events", "none", "important");
    tag.style.setProperty("pointer-events", "none", "important");
    (document.body || document.documentElement).append(box, tag);
    overlay = { box, tag };
    return overlay;
  }

  // The pick highlight, and the toolbar of window mode (ui.js), which lives in
  // a closed shadow root: events from inside it reach the page as its host.
  const isOurs = el => !!el && ((overlay && (el === overlay.box || el === overlay.tag)) || el.tagName === "CB-BROWSER-UI");

  // Rect of an element in the top window's viewport, also when it lives in a
  // same-origin iframe.
  function viewRect(el) {
    const r = el.getBoundingClientRect();
    let x = r.left;
    let y = r.top;
    let win = el.ownerDocument && el.ownerDocument.defaultView;
    for (let i = 0; win && win !== window && i < 8; i++) {
      let f = null;
      try {
        f = win.frameElement;
      } catch {}
      if (!f) break;
      const fr = f.getBoundingClientRect();
      x += fr.left + f.clientLeft;
      y += fr.top + f.clientTop;
      win = f.ownerDocument.defaultView;
    }
    return { left: x, top: y, width: r.width, height: r.height, right: x + r.width, bottom: y + r.height };
  }

  function parentOf(el) {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode && el.getRootNode();
    if (root && root.host) return root.host; // out of a shadow tree
    try {
      const f = el.ownerDocument.defaultView.frameElement; // out of an iframe
      if (f && el.ownerDocument !== document) return f;
    } catch {}
    return null;
  }

  // Hit testing skips elements with pointer-events:none (icons inside buttons,
  // decorative layers), so the browser answers with what is behind them. Look
  // inside the answer for the deepest such element that is really under the
  // pointer.
  function refine(el, x, y) {
    let best = el;
    let budget = 400;
    const visit = node => {
      // Later siblings paint on top: check them first.
      for (let i = node.children.length - 1; i >= 0 && budget > 0; i--) {
        const c = node.children[i];
        budget--;
        if (isOurs(c)) continue;
        const r = c.getBoundingClientRect();
        if (r.width < 1 || r.height < 1 || x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
        const cs = getComputedStyle(c);
        // Anything else under the pointer would have been the browser's answer.
        if (cs.pointerEvents !== "none") continue;
        if (cs.display === "none" || cs.visibility !== "visible" || parseFloat(cs.opacity) === 0) continue;
        best = c;
        visit(c);
        return true;
      }
      return false;
    };
    visit(el);
    return best;
  }

  function hitTest(x, y) {
    let doc = document;
    let el = null;
    for (let i = 0; i < 12; i++) {
      let hit = doc.elementFromPoint(x, y);
      if (!hit || isOurs(hit)) break;
      // Into open shadow trees.
      for (let j = 0; j < 8 && hit.shadowRoot; j++) {
        const inner = hit.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === hit || !hit.shadowRoot.contains(inner)) break;
        hit = inner;
      }
      el = hit;
      // Into same-origin iframes.
      if (hit.tagName !== "IFRAME" && hit.tagName !== "FRAME") break;
      let inner = null;
      try {
        inner = hit.contentDocument;
      } catch {}
      if (!inner) break;
      const r = hit.getBoundingClientRect();
      x -= r.left + hit.clientLeft;
      y -= r.top + hit.clientTop;
      doc = inner;
    }
    if (el && doc === document) el = refine(el, x, y);
    return el;
  }

  const resolvedSrc = new Map();
  function setResolvedSrc(marker, value) {
    resolvedSrc.set(marker, value || "");
    if (picking && current && overlay && overlay.box.style.display !== "none") showOverlay(current);
  }

  function showOverlay(el) {
    const o = ensureOverlay();
    const r = viewRect(el);
    Object.assign(o.box.style, { display: "block", top: r.top + "px", left: r.left + "px", width: r.width + "px", height: r.height + "px" });
    const chain = buildChain(el);
    const owner = chain.find(c => !c.name.startsWith("<"));
    const size = `${Math.round(r.width)}×${Math.round(r.height)}`;
    let src = owner ? owner.src : "";
    if (src && src.startsWith("⟦")) {
      // Generated location: show the original once the daemon has mapped it.
      if (resolvedSrc.has(src)) src = resolvedSrc.get(src);
      else {
        if (!resolvedSrc.has("pending:" + src)) {
          resolvedSrc.set("pending:" + src, true);
          emit({ t: "resolveSrc", marker: src });
        }
        src = "";
      }
    }
    const tagName = el.tagName.toLowerCase();
    const text = `${owner ? owner.name + " · " : ""}${tagName}${src ? " · " + src.split("/").pop() : ""} · ${size}${level ? `  ↑${level}` : ""}`;
    if (o.tag.textContent !== text) o.tag.textContent = text;
    o.tag.style.display = "block";
    const tw = o.tag.offsetWidth;
    const top = r.top >= 22 ? r.top - 22 : Math.min(innerHeight - 20, r.bottom + 2);
    Object.assign(o.tag.style, { top: top + "px", left: Math.max(0, Math.min(r.left, innerWidth - tw - 2)) + "px" });
  }

  function hideOverlay() {
    if (!overlay) return;
    overlay.box.style.display = "none";
    overlay.tag.style.display = "none";
  }

  // Recompute what is under the pointer. The page can scroll or re-render
  // under a still pointer, so this also runs on scroll and on a timer.
  function refreshPick() {
    if (!picking || !lastPt) return;
    const el = hitTest(lastPt.x, lastPt.y);
    if (el !== leaf) {
      leaf = el;
      level = 0;
    }
    let cur = leaf;
    for (let i = 0; i < level && cur; i++) {
      const p = parentOf(cur);
      if (!p || p === document.documentElement) {
        level = i;
        break;
      }
      cur = p;
    }
    current = cur;
    if (cur) showOverlay(cur);
    else hideOverlay();
  }

  let refreshQueued = false;
  function queueRefresh() {
    if (!picking || refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => {
      refreshQueued = false;
      refreshPick();
    });
  }

  // Anything that still reaches the page while picking (for example a touch
  // or an agent click) must not trigger the page's own handlers.
  // A pick ends pick mode on pointerdown, but the same click's pointerup,
  // mouseup, click (and a dblclick) come after: keep eating that gesture, or
  // the click lands on the page (a menu trigger opens, a link navigates).
  let eatGestureUntil = 0;
  const swallow = e => {
    const eating = !picking && Date.now() < eatGestureUntil;
    if ((!picking && !eating) || isOurs(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (eating) {
      if (e.type === "click" || e.type === "dblclick") eatGestureUntil = e.type === "click" ? Date.now() + 300 : 0;
      return;
    }
    // In a visible window the real click picks (headless gets pickAt from the engine).
    // (pointerdown: cancelling it suppresses the mousedown that would follow).
    if (WINDOW_MODE && e.type === "pointerdown" && e.button === 0) {
      eatGestureUntil = Date.now() + 1500;
      pickAt(e.clientX, e.clientY, e.shiftKey);
    }
  };
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "touchstart", "touchend", "dblclick", "contextmenu"]) {
    window.addEventListener(type, swallow, true);
  }
  window.addEventListener(
    "mousemove",
    e => {
      if (!picking) return;
      if (isOurs(e.target)) {
        lastPt = null;
        hideOverlay();
        return;
      }
      lastPt = { x: e.clientX, y: e.clientY };
      queueRefresh();
    },
    true
  );
  window.addEventListener("scroll", queueRefresh, true);
  window.addEventListener("resize", queueRefresh, true);
  window.addEventListener(
    "keydown",
    e => {
      if (!picking) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setPick(false);
        emit({ t: "pickCancelled" });
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        // Widen to the parent / narrow back towards the element under the pointer.
        e.preventDefault();
        e.stopImmediatePropagation();
        level = Math.max(0, level + (e.key === "ArrowUp" ? 1 : -1));
        refreshPick();
      }
    },
    true
  );

  // Called by the engine with the click position. Picks what is highlighted.
  function pickAt(x, y, keep) {
    if (!picking) return false;
    lastPt = { x, y };
    refreshPick();
    const el = current;
    if (!keep) setPick(false);
    if (!el) return false;
    emit({ t: "pick", ...buildReport(el), at: Date.now(), keep: !!keep });
    return true;
  }

  let pickCursorEl = null;
  function windowPickCursor(on) {
    if (on && !pickCursorEl) {
      pickCursorEl = document.createElement("style");
      pickCursorEl.textContent = "*, *::before, *::after { cursor: crosshair !important; }";
      (document.head || document.documentElement).appendChild(pickCursorEl);
    } else if (!on && pickCursorEl) {
      pickCursorEl.remove();
      pickCursorEl = null;
    }
  }
  if (WINDOW_MODE) {
    // ⌥⇧P starts picking (the engine sends the result to the Cursor window used last).
    window.addEventListener(
      "keydown",
      e => {
        if (e.code === "KeyP" && e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          e.stopImmediatePropagation();
          emit({ t: "wantPick", on: !picking });
        }
        // ⌥⇧M: side-by-side view on/off.
        if (e.code === "KeyM" && e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          e.stopImmediatePropagation();
          emit({ t: "wantMulti" });
        }
        // ⌥⇧S in a pane: mark-up (the toolbar of the top page handles it there).
        if (PANE && e.code === "KeyS" && e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          e.stopImmediatePropagation();
          emit({ t: "wantAnnotate" });
        }
      },
      true
    );
    // Real input in this window: in the side-by-side view it leads scrolling
    // and navigation (programmatic scrolls in the followers send nothing).
    let touchedAt = 0;
    const touched = () => {
      if (!syncOn || Date.now() - touchedAt < 250) return;
      touchedAt = Date.now();
      if (PANE) toShell({ t: "touched" });
      else emit({ t: "touched" });
    };
    for (const type of ["pointerdown", "wheel", "keydown", "touchstart"]) window.addEventListener(type, touched, { capture: true, passive: true });
    // Follow the tab the user is looking at: Claude acts on that one.
    if (window === window.top) {
      const shown = () => document.visibilityState === "visible" && emit({ t: "shown" });
      document.addEventListener("visibilitychange", shown);
      window.addEventListener("focus", shown);
      shown();
    }
  }

  function setPick(on) {
    picking = !!on;
    clearInterval(pickTimer);
    pickTimer = null;
    if (picking) pickTimer = setInterval(refreshPick, 300);
    else {
      hideOverlay();
      lastPt = leaf = current = null;
      level = 0;
    }
    lastCursor = "";
    if (WINDOW_MODE) windowPickCursor(picking);
    else emit({ t: "cursor", v: picking ? "crosshair" : "default" });
    emit({ t: "pickState", on: picking });
    return picking;
  }

  // ---------- right-click ----------
  // Headless Chrome shows no context menu, so the viewer draws one. A page
  // that handles the event itself (its own menu) keeps it, unless Shift is held.
  window.addEventListener(
    "contextmenu",
    e => {
      // A visible window has Chrome's own menu.
      if (picking || WINDOW_MODE) return;
      const x = e.clientX;
      const y = e.clientY;
      const shift = e.shiftKey;
      // Let the page's own handlers run first, then see whether they took it.
      setTimeout(() => {
        if (e.defaultPrevented && !shift) return;
        const el = hitTest(x, y) || e.target;
        if (!el || el.nodeType !== 1) return;
        const a = el.closest && el.closest("a[href]");
        const img = el.tagName === "IMG" ? el : null;
        const field = el.closest && el.closest("input, textarea, [contenteditable=''], [contenteditable='true']");
        emit({
          t: "context",
          x,
          y,
          link: a ? a.href : "",
          image: img ? img.currentSrc || img.src : "",
          selection: selectionText().slice(0, 4000),
          editable: !!field,
          tag: el.tagName.toLowerCase(),
        });
      }, 0);
    },
    true
  );

  // Picks the element at a point without entering pick mode.
  function pickPoint(x, y) {
    const el = hitTest(x, y);
    if (!el) return false;
    emit({ t: "pick", ...buildReport(el), at: Date.now(), keep: true });
    return true;
  }

  // An image as base64, for URLs only this page can read (blob:, cookies).
  async function fetchAsBase64(url) {
    const res = await fetch(url, { credentials: "include" });
    const blob = await res.blob();
    return await new Promise((ok, fail) => {
      const fr = new FileReader();
      fr.onload = () => ok({ data: String(fr.result).split(",")[1] || "", type: blob.type });
      fr.onerror = () => fail(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  // ---------- marks drawn on a screenshot ----------
  // For each rectangle / arrow the user drew: which elements it is about.
  function briefOf(el) {
    const r = viewRect(el);
    const raw = el instanceof HTMLElement ? el.innerText : el.textContent;
    return {
      tag: el.tagName.toLowerCase(),
      label: clip(labelFor(el) || (raw || "").replace(/\n+/g, " · ") || el.getAttribute("placeholder") || "", 70),
      selector: cssPath(el),
      box: `${Math.round(r.width)}×${Math.round(r.height)} at (${Math.round(r.left)}, ${Math.round(r.top)})`,
      chain: buildChain(el).slice(0, 4),
    };
  }
  function describeMarks(marks) {
    return marks.map(m => {
      if (m.kind === "arrow") {
        const el = hitTest(m.x2, m.y2);
        return { els: el ? [briefOf(el)] : [] };
      }
      const x2 = m.x + m.w;
      const y2 = m.y + m.h;
      const inset = Math.min(8, m.w / 4, m.h / 4);
      const pts = [
        [m.x + m.w / 2, m.y + m.h / 2],
        [m.x + inset, m.y + inset],
        [x2 - inset, m.y + inset],
        [m.x + inset, y2 - inset],
        [x2 - inset, y2 - inset],
      ];
      const hits = pts.map(p => hitTest(p[0], p[1])).filter(Boolean);
      // The element that holds the whole marked area…
      let box = hits[0] || null;
      for (let i = 0; box && i < 40; i++) {
        const r = viewRect(box);
        if (r.left <= m.x + 2 && r.top <= m.y + 2 && r.right >= x2 - 2 && r.bottom >= y2 - 2) break;
        const p = parentOf(box);
        if (!p || p === document.documentElement) break;
        box = p;
      }
      // …and the distinct things inside it that the corners and centre touch.
      const els = [];
      const page = el => el === document.body || el === document.documentElement;
      for (const el of hits) if (!els.includes(el) && !page(el)) els.push(el);
      // The container only helps when it is about the size of the mark.
      if (box && !page(box) && !els.includes(box)) {
        const r = viewRect(box);
        if (r.width * r.height <= m.w * m.h * 6) els.unshift(box);
      }
      return { els: els.slice(0, 4).map(briefOf) };
    });
  }

  // ---------- scroll sync (side-by-side view) ----------
  // Reports which scroller moved and how far, as fractions, so the same
  // content can be brought into view at another viewport size.
  let syncOn = false;
  let scrolled = null;
  let scrollQueued = false;
  window.addEventListener(
    "scroll",
    e => {
      if (!syncOn) return;
      scrolled = e.target;
      if (scrollQueued) return;
      scrollQueued = true;
      requestAnimationFrame(() => {
        scrollQueued = false;
        const t = scrolled;
        const isDoc = t === document || t === document.documentElement || t === document.body;
        const el = isDoc ? document.scrollingElement : t;
        if (!el || el.nodeType !== 1 || isOurs(el)) return;
        const mx = el.scrollWidth - el.clientWidth;
        const my = el.scrollHeight - el.clientHeight;
        const msg = { t: "scroll", sel: isDoc ? "" : cssPath(el), fx: mx > 0 ? el.scrollLeft / mx : 0, fy: my > 0 ? el.scrollTop / my : 0 };
        if (PANE) toShell(msg);
        else emit(msg);
      });
    },
    true
  );
  function syncScroll(sel, fx, fy) {
    let el = sel ? null : document.scrollingElement;
    if (sel) {
      try {
        el = document.querySelector(sel);
      } catch {}
    }
    if (!el) return;
    el.scrollTo({ left: fx * (el.scrollWidth - el.clientWidth), top: fy * (el.scrollHeight - el.clientHeight), behavior: "instant" });
  }

  // ---------- snapshot for the agent ----------
  let refSeq = 0;
  const refs = new Map(); // ref -> WeakRef<Element>
  const refOf = new WeakMap(); // Element -> ref

  function refFor(el) {
    let r = refOf.get(el);
    if (!r) {
      r = "e" + ++refSeq;
      refOf.set(el, r);
      refs.set(r, new WeakRef(el));
    }
    return r;
  }

  const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "LABEL", "OPTION"]);
  const INTERACTIVE_ROLES = /^(button|link|tab|checkbox|radio|switch|menuitem|option|combobox|textbox|slider|searchbox|menuitemcheckbox|menuitemradio|treeitem)$/;
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK", "HEAD", "BR", "PATH", "DEFS"]);

  function isVisible(el, cs) {
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return false;
    if (parseFloat(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function isInteractive(el, cs) {
    if (INTERACTIVE_TAGS.has(el.tagName)) return true;
    const role = el.getAttribute("role");
    if (role && INTERACTIVE_ROLES.test(role)) return true;
    if (el.isContentEditable && el.getAttribute("contenteditable") !== null) return true;
    if (el.hasAttribute("onclick") || el.tabIndex >= 0) return true;
    const pk = propsKey(el);
    if (pk) {
      const p = el[pk];
      if (p && (p.onClick || p.onMouseDown || p.onPointerDown || p.onPointerUp)) return true;
    }
    return cs.cursor === "pointer" && !(el.parentElement && getComputedStyle(el.parentElement).cursor === "pointer");
  }

  function ownText(el) {
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    return t.replace(/\s+/g, " ").trim();
  }

  function snapshot(opts = {}) {
    const maxChars = opts.maxChars || 40000;
    const vw = innerWidth;
    const vh = innerHeight;
    const out = [];
    let size = 0;
    let truncated = false;

    const walk = (el, depth) => {
      if (truncated) return;
      if (SKIP_TAGS.has(el.tagName)) return;
      if (isOurs(el)) return;
      const cs = getComputedStyle(el);
      if (!isVisible(el, cs) && el !== document.body) {
        // Hidden subtree: skip, except fixed/abs children can still escape (rare); ignore.
        if (cs.display === "none" || cs.visibility === "hidden") return;
      }
      const interactive = isInteractive(el, cs);
      const text = ownText(el);
      const heading = /^H[1-6]$/.test(el.tagName);
      const img = el.tagName === "IMG" || (el.tagName === "svg" && el.getAttribute("aria-label"));
      let printed = false;
      if (interactive || heading || img || (text && text.length > 0) || el.tagName === "DIALOG" || el.getAttribute("role") === "dialog") {
        const r = el.getBoundingClientRect();
        const off = r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw;
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role");
        let line = "  ".repeat(Math.min(depth, 12));
        if (interactive || heading || img || role === "dialog" || tag === "dialog") line += `[${refFor(el)}] `;
        line += role && role !== tag ? `${tag}[role=${role}]` : tag;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
          if (el.type && el.type !== "text" && tag === "input") line += ` type=${el.type}`;
          const label = labelFor(el) || el.getAttribute("placeholder");
          if (label) line += ` "${clip(label, 60)}"`;
          if (el.type === "checkbox" || el.type === "radio") line += el.checked ? " [checked]" : " [unchecked]";
          else if (el.value) line += ` value="${el.type === "password" ? "•••" : clip(el.value, 60)}"`;
        } else if (img) {
          const alt = el.getAttribute("alt") || el.getAttribute("aria-label");
          if (alt) line += ` "${clip(alt, 60)}"`;
        } else {
          const label = interactive && !text ? labelFor(el) || clip((el.innerText || "").replace(/\n+/g, " · "), 80) : "";
          if (label) line += ` "${clip(label, 80)}"`;
        }
        if (text) line += ` ${JSON.stringify(clip(text, 140))}`;
        if (el.disabled || el.getAttribute("aria-disabled") === "true") line += " [disabled]";
        if (document.activeElement === el && el !== document.body) line += " [focused]";
        if (off) line += " (offscreen)";
        const fk = fiberKey(el);
        const src = el.getAttribute(SRC_ATTR) || (fk && el[fk] ? srcOf(el[fk]) : null);
        if (src) line += `  ‹${src}›`;
        out.push(line);
        size += line.length + 1;
        printed = true;
        if (size > maxChars) {
          truncated = true;
          return;
        }
      }
      const kids = el.shadowRoot ? [...el.shadowRoot.children, ...el.children] : el.children;
      for (const c of kids) walk(c, printed ? depth + 1 : depth);
    };

    if (document.body) walk(document.body, 0);
    const header = [
      `URL: ${location.href}`,
      `Title: ${document.title}`,
      `Viewport: ${vw}×${vh}  scroll: ${Math.round(scrollX)},${Math.round(scrollY)} of ${document.documentElement.scrollWidth}×${document.documentElement.scrollHeight}`,
      "Elements with [eN] refs can be used with browser_click / browser_type / browser_hover / browser_scroll. ‹file:line› = JSX source.",
      "",
    ];
    if (truncated) out.push(`… (truncated at ${maxChars} chars)`);
    return header.join("\n") + out.join("\n");
  }

  function resolve(ref) {
    const w = refs.get(ref);
    const el = w && w.deref();
    return el && el.isConnected ? el : null;
  }

  function findByText(text) {
    const needle = String(text).trim().toLowerCase();
    let best = null;
    let bestLen = Infinity;
    for (const el of document.querySelectorAll("body *")) {
      if (SKIP_TAGS.has(el.tagName)) continue;
      const t = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().toLowerCase();
      if (!t || !t.includes(needle)) continue;
      const cs = getComputedStyle(el);
      if (!isVisible(el, cs)) continue;
      // Prefer the smallest element containing the text, interactive ones first.
      const score = t.length - (isInteractive(el, cs) ? 1e6 : 0);
      if (score < bestLen) {
        bestLen = score;
        best = el;
      }
    }
    return best;
  }

  // Returns viewport-center coordinates for real (CDP) input, scrolling the
  // element into view first.
  function locate(spec) {
    let el = null;
    if (spec.ref) el = resolve(spec.ref);
    else if (spec.selector) el = document.querySelector(spec.selector);
    else if (spec.text) el = findByText(spec.text);
    if (!el) return { error: spec.ref ? `ref ${spec.ref} not found (take a new browser_snapshot)` : "element not found" };
    let r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      r = el.getBoundingClientRect();
    }
    const x = r.left + Math.min(r.width / 2, Math.max(1, r.width - 1));
    const y = r.top + Math.min(r.height / 2, Math.max(1, r.height - 1));
    const hit = document.elementFromPoint(x, y);
    const covered = hit && hit !== el && !el.contains(hit) && !hit.contains(el);
    return {
      x,
      y,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      tag: el.tagName.toLowerCase(),
      label: clip(labelFor(el) || el.innerText || el.value || "", 60),
      covered: covered ? `${hit.tagName.toLowerCase()}${hit.className && typeof hit.className === "string" ? "." + hit.className.split(" ")[0] : ""}` : null,
    };
  }

  function selectionText() {
    const a = document.activeElement;
    if (a && (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) && a.selectionStart !== a.selectionEnd) {
      return a.value.slice(a.selectionStart, a.selectionEnd);
    }
    return String(getSelection() || "");
  }

  // ---------- camera / microphone ----------
  // Headless Chrome has no permission prompt UI: ask the engine (which may ask
  // the user in the panel), and report live tracks for the panel's indicator.
  const liveTracks = new Set();
  function reportMedia() {
    let camera = 0;
    let mic = 0;
    for (const t of liveTracks) {
      if (t.readyState !== "live") liveTracks.delete(t);
      else if (t.kind === "video") camera++;
      else if (t.kind === "audio") mic++;
    }
    emit({ t: "media", camera: camera > 0, mic: mic > 0 });
  }
  function trackStream(stream) {
    for (const t of stream.getTracks()) {
      liveTracks.add(t);
      const stop = t.stop.bind(t);
      t.stop = () => {
        stop();
        reportMedia();
      };
      t.addEventListener("ended", reportMedia);
    }
    reportMedia();
  }
  // Chrome runs with --auto-accept-camera-and-microphone-capture (headless
  // can't capture otherwise), so this gate is what enforces the user's choice.
  // It patches the prototype and runs in every frame; a page deliberately
  // working around it could still slip past — this is a dev browser.
  const permWaits = new Map();
  const frameToken = Math.random().toString(36).slice(2);
  let permSeq = 0;
  async function askPermission(constraints) {
    const kinds = [];
    if (constraints && constraints.video) kinds.push("camera");
    if (constraints && constraints.audio) kinds.push("microphone");
    if (!kinds.length || WINDOW_MODE) return; // a visible Chrome asks by itself
    const id = `${frameToken}-${++permSeq}`;
    const ok = await new Promise(res => {
      permWaits.set(id, res);
      emit({ t: "permission", id, kinds, origin: location.origin });
    });
    if (!ok) throw new DOMException("Permission denied", "NotAllowedError");
  }
  if (window.MediaDevices && MediaDevices.prototype.getUserMedia) {
    const origGUM = MediaDevices.prototype.getUserMedia;
    Object.defineProperty(MediaDevices.prototype, "getUserMedia", {
      configurable: false,
      writable: false,
      value: async function getUserMedia(constraints) {
        await askPermission(constraints);
        const stream = await origGUM.call(this, constraints);
        trackStream(stream);
        return stream;
      },
    });
    for (const legacy of ["getUserMedia", "webkitGetUserMedia"]) {
      if (typeof navigator[legacy] !== "function") continue;
      Object.defineProperty(Navigator.prototype, legacy, {
        configurable: false,
        value(constraints, onOk, onErr) {
          navigator.mediaDevices.getUserMedia(constraints).then(onOk, onErr);
        },
      });
    }
    window.addEventListener("pagehide", () => {
      liveTracks.clear();
      reportMedia();
    });
  }
  function permissionReply(id, ok) {
    const res = permWaits.get(id);
    permWaits.delete(id);
    if (res) res(!!ok);
  }

  // ---------- touch emulation (phone/tablet panes of the side-by-side view) ----------
  // Chrome's own touch emulation is per tab, and the panes share one tab, so
  // the pane acts as a touch device itself: it answers like a phone or tablet
  // (user agent, touch points, hover/pointer media), turns the real mouse into
  // a finger (touch + pointer events, implicit capture, then the tap's mouse
  // events and click), and scrolls by dragging, with momentum.
  function emulateTouch(ua) {
    const mobileUa = /Mobile/.test(ua);
    const def = (obj, key, get) => {
      try {
        Object.defineProperty(obj, key, { configurable: true, get });
      } catch {}
    };
    def(navigator, "maxTouchPoints", () => 5);
    def(navigator, "userAgent", () => ua);
    def(navigator, "appVersion", () => ua.replace(/^Mozilla\//, ""));
    def(navigator, "platform", () => "Linux armv8l");
    if (navigator.userAgentData) {
      const brands = navigator.userAgentData.brands;
      const base = { brands, mobile: mobileUa, platform: "Android" };
      const uad = {
        ...base,
        getHighEntropyValues: async () => ({ ...base, platformVersion: "14.0.0", model: mobileUa ? "Pixel 8" : "SM-X710", architecture: "arm", bitness: "64", fullVersionList: brands }),
        toJSON: () => base,
      };
      def(navigator, "userAgentData", () => uad);
    }
    for (const ev of ["ontouchstart", "ontouchmove", "ontouchend", "ontouchcancel"]) {
      for (const proto of [window, Document.prototype, HTMLElement.prototype]) {
        if (!(ev in proto)) {
          try {
            Object.defineProperty(proto, ev, { configurable: true, writable: true, value: null });
          } catch {}
        }
      }
    }

    // Hover and pointer media answer like a touch screen: the device's
    // answers are the opposite of the mouse's, so the keywords are swapped.
    const swap = q =>
      String(q).replace(/\(\s*(any-)?(hover|pointer)\s*(?::\s*([a-z-]+)\s*)?\)/gi, (m, any, feat, val) => {
        const a = any || "";
        const v = (val || "").toLowerCase();
        if (feat.toLowerCase() === "hover") return v === "none" ? `(${a}hover: hover)` : `(${a}hover: none)`;
        if (v === "coarse") return `(${a}pointer: fine)`;
        if (v === "fine") return `(${a}pointer: coarse)`;
        return m;
      });
    const mm = window.matchMedia.bind(window);
    window.matchMedia = function matchMedia(q) {
      const s = swap(q);
      const list = mm(s);
      if (s === String(q)) return list;
      return new Proxy(list, {
        get(t, k) {
          if (k === "media") return String(q);
          const v = Reflect.get(t, k, t);
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    };
    const seenSheets = new WeakSet();
    const fixRules = rules => {
      for (const r of rules) {
        try {
          if (r.media && r.cssRules) {
            const t = r.media.mediaText;
            const n = swap(t);
            if (n !== t) r.media.mediaText = n;
          }
          if (r.styleSheet) fixSheet(r.styleSheet);
          if (r.cssRules && r.cssRules.length) fixRules(r.cssRules);
        } catch {}
      }
    };
    const fixSheet = sh => {
      if (!sh || seenSheets.has(sh)) return;
      try {
        const rules = sh.cssRules; // throws for cross-origin sheets
        seenSheets.add(sh);
        fixRules(rules);
      } catch {}
    };
    let fixQueued = false;
    const fixAll = () => {
      fixQueued = false;
      for (const sh of document.styleSheets) fixSheet(sh);
      for (const sh of document.adoptedStyleSheets || []) fixSheet(sh);
    };
    const queueFix = () => {
      if (fixQueued) return;
      fixQueued = true;
      queueMicrotask(fixAll);
    };
    const isStyleNode = n => n && (n.nodeName === "STYLE" || n.nodeName === "LINK" || (n.parentNode && n.parentNode.nodeName === "STYLE"));
    new MutationObserver(recs => {
      for (const r of recs) if (isStyleNode(r.target) || [...r.addedNodes].some(isStyleNode)) return queueFix();
    }).observe(document, { childList: true, subtree: true, characterData: true });
    document.addEventListener("load", e => isStyleNode(e.target) && queueFix(), true);
    document.addEventListener("DOMContentLoaded", fixAll);

    // A finger instead of the mouse. Real mouse and pointer events stop here
    // (their default actions, like focusing a field or opening a <select>,
    // still happen); the page gets the touch versions instead.
    const ID = 7;
    let down = null; // the finger on the screen
    let captured = null; // pointer capture (implicit for touch, like a phone)
    let suppressClick = false;
    let momentumId = 0;
    const set = Element.prototype.setPointerCapture;
    const release = Element.prototype.releasePointerCapture;
    const has = Element.prototype.hasPointerCapture;
    Element.prototype.setPointerCapture = function (id) {
      if (id !== ID) return set.call(this, id);
      captured = this;
    };
    Element.prototype.releasePointerCapture = function (id) {
      if (id !== ID) return release.call(this, id);
      if (captured === this) captured = null;
    };
    Element.prototype.hasPointerCapture = function (id) {
      return id === ID ? captured === this : has.call(this, id);
    };
    const at = e => ({ clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey });
    const live = el => (el && el.isConnected ? el : document.elementFromPoint(down ? down.lx : 0, down ? down.ly : 0) || document.body);
    const pointer = (type, target, e, buttons) => {
      const ev = new PointerEvent(type, {
        ...at(e),
        bubbles: !/enter|leave/.test(type),
        cancelable: !/enter|leave|cancel/.test(type),
        composed: true,
        view: window,
        pointerId: ID,
        pointerType: "touch",
        isPrimary: true,
        button: type === "pointermove" ? -1 : 0,
        buttons,
        width: 23,
        height: 23,
        pressure: buttons ? 0.5 : 0,
      });
      live(target).dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    const touch = (type, target, e, onScreen) => {
      const t = live(target);
      const tp = new Touch({ identifier: ID, target: t, clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY, pageX: e.pageX, pageY: e.pageY, radiusX: 11.5, radiusY: 11.5, force: 1 });
      const list = onScreen ? [tp] : [];
      const ev = new TouchEvent(type, { ...at(e), bubbles: true, cancelable: type !== "touchcancel", composed: true, view: window, touches: list, targetTouches: list, changedTouches: [tp] });
      t.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    const mouse = (type, target, e, buttons) => live(target).dispatchEvent(new MouseEvent(type, { ...at(e), bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons, detail: 1 }));

    // touch-action of the element and its ancestors: what the browser may pan.
    const allowed = el => {
      let x = true;
      let y = true;
      for (let n = el; n && n.nodeType === 1; n = n.parentElement || (n.getRootNode && n.getRootNode().host)) {
        const ta = getComputedStyle(n).touchAction;
        if (ta === "none") return { x: false, y: false };
        if (ta && ta !== "auto" && ta !== "manipulation") {
          if (!/pan-x|pan-left|pan-right/.test(ta)) x = false;
          if (!/pan-y|pan-up|pan-down/.test(ta)) y = false;
        }
      }
      return { x, y };
    };
    // The nearest element that can scroll the way the finger moves.
    const scrollerFor = (el, dx, dy) => {
      const horizontal = Math.abs(dx) > Math.abs(dy);
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const cs = getComputedStyle(n);
        const root = n === document.scrollingElement;
        const ov = horizontal ? cs.overflowX : cs.overflowY;
        if (!root && !/(auto|scroll)/.test(ov)) continue;
        if (horizontal) {
          const max = n.scrollWidth - n.clientWidth;
          if (max <= 0) continue;
          const pos = Math.abs(n.scrollLeft);
          const towardStart = (dx > 0) === (cs.direction !== "rtl");
          if (towardStart ? pos > 0 : pos < max - 1) return n;
        } else {
          const max = n.scrollHeight - n.clientHeight;
          if (max <= 0) continue;
          if (dy > 0 ? n.scrollTop > 0 : n.scrollTop < max - 1) return n;
        }
      }
      return document.scrollingElement;
    };
    const stopMomentum = () => {
      cancelAnimationFrame(momentumId);
      momentumId = 0;
    };
    const fling = d => {
      const now = performance.now();
      const s = d.samples.filter(p => now - p[0] < 100);
      if (s.length < 2 || !d.scroller) return;
      const a = s[0];
      const b = s[s.length - 1];
      const dt = b[0] - a[0];
      if (dt <= 0) return;
      let vx = d.lock.x ? (b[1] - a[1]) / dt : 0;
      let vy = d.lock.y ? (b[2] - a[2]) / dt : 0;
      let last = now;
      const sc = d.scroller;
      const step = t => {
        const ms = Math.min(50, t - last);
        last = t;
        const k = Math.pow(0.996, ms);
        vx *= k;
        vy *= k;
        if (Math.hypot(vx, vy) < 0.03) return (momentumId = 0);
        sc.scrollBy({ left: -vx * ms, top: -vy * ms, behavior: "instant" });
        momentumId = requestAnimationFrame(step);
      };
      momentumId = requestAnimationFrame(step);
    };

    const real = e => e.isTrusted && (!e.pointerType || e.pointerType === "mouse");
    const stop = e => e.stopImmediatePropagation();
    for (const type of ["mouseover", "mouseout", "mouseenter", "mouseleave", "mousemove", "mousedown", "mouseup", "dblclick", "pointerover", "pointerout", "pointerenter", "pointerleave", "pointercancel", "gotpointercapture", "lostpointercapture"]) {
      window.addEventListener(type, e => real(e) && stop(e), true);
    }
    window.addEventListener(
      "pointerdown",
      e => {
        if (!real(e)) return;
        stop(e);
        suppressClick = false;
        if (e.button !== 0) return;
        stopMomentum();
        const target = e.target;
        down = { target, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, samples: [[performance.now(), e.clientX, e.clientY]], moved: false, panning: false, scroller: null, lock: { x: true, y: true }, prevented: false };
        captured = target;
        pointer("pointerover", target, e, 1);
        pointer("pointerdown", target, e, 1);
        down.prevented = touch("touchstart", target, e, true);
      },
      true
    );
    window.addEventListener(
      "pointermove",
      e => {
        if (!real(e)) return;
        stop(e);
        const d = down;
        if (!d) return; // a hovering mouse: a finger off the screen does nothing
        const dx = e.clientX - d.lx;
        const dy = e.clientY - d.ly;
        d.lx = e.clientX;
        d.ly = e.clientY;
        d.samples.push([performance.now(), e.clientX, e.clientY]);
        if (d.samples.length > 12) d.samples.shift();
        const prevented = touch("touchmove", d.target, e, true);
        if (d.panning) {
          d.scroller.scrollBy({ left: d.lock.x ? -dx : 0, top: d.lock.y ? -dy : 0, behavior: "instant" });
          return;
        }
        pointer("pointermove", captured || d.target, e, 1);
        if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 8) {
          d.moved = true;
          const ok = allowed(d.target);
          if (!prevented && !d.prevented && (ok.x || ok.y)) {
            // The browser takes the gesture over for scrolling, as on a phone.
            d.panning = true;
            d.lock = ok;
            d.scroller = scrollerFor(d.target, e.clientX - d.x0, e.clientY - d.y0);
            pointer("pointercancel", captured || d.target, e, 0);
            captured = null;
            d.scroller.scrollBy({ left: ok.x ? -(e.clientX - d.x0) : 0, top: ok.y ? -(e.clientY - d.y0) : 0, behavior: "instant" });
          }
        }
      },
      true
    );
    window.addEventListener(
      "pointerup",
      e => {
        if (!real(e)) return;
        stop(e);
        const d = down;
        if (!d || e.button !== 0) return;
        down = null;
        if (d.panning) {
          touch("touchend", d.target, e, false);
          suppressClick = true;
          fling(d);
          return;
        }
        pointer("pointerup", captured || d.target, e, 0);
        pointer("pointerout", captured || d.target, e, 0);
        captured = null;
        const prevented = touch("touchend", d.target, e, false);
        if (d.prevented || prevented || d.moved) {
          suppressClick = true;
          return;
        }
        // A tap: the mouse events a phone sends after it; the real click follows.
        const under = document.elementFromPoint(e.clientX, e.clientY) || d.target;
        mouse("mouseover", under, e, 0);
        mouse("mousemove", under, e, 0);
        mouse("mousedown", under, e, 1);
        mouse("mouseup", under, e, 0);
      },
      true
    );
    window.addEventListener(
      "click",
      e => {
        if (!e.isTrusted || !suppressClick) return;
        suppressClick = false;
        e.preventDefault();
        stop(e);
      },
      true
    );
    // Dragging pans; it doesn't select text or drag images and links.
    const editable = el => el && el.closest && el.closest("input, textarea, [contenteditable=''], [contenteditable='true']");
    document.addEventListener("selectstart", e => down && !editable(e.target) && e.preventDefault(), true);
    document.addEventListener("dragstart", e => down && e.preventDefault(), true);
    window.addEventListener("blur", () => {
      down = null;
      captured = null;
    });

    // The round touch cursor of Chrome's device mode.
    const dot =
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Ccircle cx='12' cy='12' r='9' fill='rgba(0,0,0,.15)' stroke='rgba(0,0,0,.45)' stroke-width='1.5'/%3E%3C/svg%3E\") 12 12, default";
    const addCursor = () => {
      const st = document.createElement("style");
      st.textContent = `html, html * { cursor: ${dot} !important; }`;
      (document.head || document.documentElement).appendChild(st);
    };
    if (document.documentElement) addCursor();
    else document.addEventListener("DOMContentLoaded", addCursor, { once: true });
  }

  // ---------- browser_verify: the element and the page after a code change ----------
  // An element found again after a full reload (refs don't survive one):
  // same tag, best match on accessible name, role and component, nearest
  // to where it was.
  function refind(fp) {
    let best = null;
    let bestScore = 0;
    let bestDist = Infinity;
    const all = document.querySelectorAll(fp.tag);
    for (let i = 0; i < all.length && i < 4000; i++) {
      const c = all[i];
      let score = 0;
      const n = nameOf(c, 120);
      if (fp.name && n === fp.name) score += 3;
      else if (fp.name && n && (n.startsWith(fp.name.slice(0, 20)) || fp.name.startsWith(n.slice(0, 20)))) score += 1;
      if (roleOf(c) === fp.role) score += 1;
      if (score < 2) continue;
      if (fp.component && componentOf(c) === fp.component) score += 2;
      const r = c.getBoundingClientRect();
      const d = fp.rect ? Math.hypot(r.left + scrollX - fp.rect.px, r.top + scrollY - fp.rect.py) : 0;
      if (score > bestScore || (score === bestScore && d < bestDist)) {
        best = c;
        bestScore = score;
        bestDist = d;
      }
    }
    return bestScore >= 3 ? best : null;
  }

  // A dev server's error overlay, if one is showing.
  function devOverlay() {
    try {
      const v = document.querySelector("vite-error-overlay");
      if (v) {
        const sr = v.shadowRoot;
        const msg = sr && sr.querySelector(".message-body");
        const file = sr && sr.querySelector(".file");
        const t = `${file ? file.textContent.trim() + "\n" : ""}${msg ? msg.textContent.trim() : ""}`;
        return { kind: "Vite", text: clip(t || "error overlay is showing", 700) };
      }
      const n = document.querySelector("nextjs-portal");
      const dlg = n && n.shadowRoot && n.shadowRoot.querySelector("[data-nextjs-dialog], [data-nextjs-dialog-content]");
      if (dlg) return { kind: "Next.js", text: clip(dlg.innerText || dlg.textContent || "error overlay is showing", 700) };
      const w = document.getElementById("webpack-dev-server-client-overlay");
      if (w && w.style.display !== "none") {
        let t = "";
        try {
          t = w.contentDocument.body.innerText;
        } catch {}
        return { kind: "webpack", text: clip(t || "error overlay is showing", 700) };
      }
    } catch {}
    return null;
  }

  // Resolves once the DOM has had no mutations for `ms` (or after `max`).
  function domQuiet(ms = 250, max = 2500) {
    return new Promise(res => {
      const t0 = Date.now();
      let last = Date.now();
      const mo = new MutationObserver(() => (last = Date.now()));
      try {
        mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      } catch {
        return res(0);
      }
      const tick = () => {
        if (Date.now() - last >= ms || Date.now() - t0 >= max) {
          mo.disconnect();
          res(Date.now() - t0);
        } else setTimeout(tick, 60);
      };
      setTimeout(tick, 60);
    });
  }

  // What verify compares: identity, box, text, classes, computed styles.
  function verifySnap(spec, fp, scrollIn) {
    let el = findEl(spec);
    let how = el ? (spec.ref && resolve(spec.ref) === el ? "same" : "selector") : "";
    if (el && fp && el.localName !== fp.tag) {
      el = null;
      how = "";
    }
    if (!el && fp) {
      el = refind(fp);
      if (el) how = "matched";
    }
    const page = { url: location.href, title: document.title, overlay: devOverlay() };
    if (!el) return { found: false, page };
    let r = el.getBoundingClientRect();
    if (scrollIn && (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth)) {
      el.scrollIntoView({ block: "center", inline: "nearest" });
      r = el.getBoundingClientRect();
    }
    const cs = getComputedStyle(el);
    const visible = r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity) > 0 && (!el.checkVisibility || el.checkVisibility({ opacityProperty: true, visibilityProperty: true }));
    const offscreen = r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth;
    let hovered = false;
    try {
      hovered = el.matches(":hover");
    } catch {}
    return {
      found: true,
      how,
      ref: refFor(el),
      selector: cssPath(el),
      what: whatIs(el),
      fp: { tag: el.localName, role: roleOf(el), name: nameOf(el, 120), component: componentOf(el) || "", rect: { px: r.left + scrollX, py: r.top + scrollY } },
      text: nameOf(el, 160),
      cls: (el.getAttribute("class") || "").trim(),
      styles: styleMap(el),
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      scroll: { x: scrollX, y: scrollY },
      vw: innerWidth,
      vh: innerHeight,
      kids: el.childElementCount,
      visible,
      offscreen,
      hovered,
      page,
    };
  }

  window.__cb = { pickPoint, fetchAsBase64, hitTest, react, describeMarks, setSync: v => (syncOn = !!v), syncScroll, permissionReply, setResolvedSrc, setPick, pickAt, snapshot, locate, resolve, refFor, setValue, buildReport, selectionText, findEl, inspect, stateSnapshot, stateDiff, finishTransitions, reactHandlers, roleOf, nameOf, verifySnap, domQuiet, devOverlay, isPicking: () => picking };
  let isTop = false;
  try {
    isTop = window.top === window;
  } catch {}
  if (PANE) {
    syncOn = true;
    if (PANE_TOUCH_UA) {
      try {
        emulateTouch(PANE_TOUCH_UA);
      } catch (e) {
        console.warn("[claude-browser] touch emulation", e);
      }
    }
    // Report where this pane is, so the others can follow.
    toShell({ t: "nav", url: location.href, within: false });
    // Its module scripts have been fetched and run: the next pane may start.
    document.addEventListener("DOMContentLoaded", () => toShell({ t: "parsed" }), { once: true });
    if (window.navigation) navigation.addEventListener("currententrychange", () => toShell({ t: "nav", url: location.href, within: true }));
    else window.addEventListener("popstate", () => toShell({ t: "nav", url: location.href, within: true }));
    if (PANE_MOBILE) {
      // Phones and tablets overlay their scrollbars: none take layout width.
      const add = () => {
        const st = document.createElement("style");
        st.textContent = "*{scrollbar-width:none !important}";
        (document.head || document.documentElement).appendChild(st);
      };
      if (document.documentElement) add();
      else document.addEventListener("DOMContentLoaded", add, { once: true });
    }
  }
  emit({ t: "ready", url: location.href, top: isTop });
})();

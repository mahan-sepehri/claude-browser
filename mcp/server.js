#!/usr/bin/env node
// MCP (stdio) front for the Claude Browser engine. Every tool call is forwarded
// to the shared engine, starting it if needed, so Claude and the editor panel
// always look at the same tab.
"use strict";

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const { ensureEngine, callTool } = require("../daemon/launcher.js");
const VERSION = require("../package.json").version;

const PORT = Number(process.env.CLAUDE_BROWSER_PORT || 47321);

const server = new McpServer(
  { name: "claude-browser", version: VERSION },
  {
    instructions: [
      "Claude Browser is a browser tab shared with the user: they watch and drive it from their editor.",
      "A '[Picked in the browser — pick N]' card (in the prompt or in an @-mentioned pick file) is the element the user means. It is short on purpose: act on it directly, and call browser_inspect({pick: N, aspect}) only for the details the task needs. 'Code:' is where that element is used: edit there for a change to this one place; a shared component's own file changes every usage.",
      "If the user refers to something they picked, marked or sent from the browser and there is no card in the prompt, call browser_picked.",
      "After editing code that changes the page, check it with one browser_verify call (pass pick: N when working from a pick).",
    ].join("\n"),
  }
);

let engine = null;
async function call(name, args) {
  try {
    if (!engine) engine = await ensureEngine({ port: PORT, nodePath: process.execPath });
    let res;
    try {
      res = await callTool(engine.port, engine.token, name, args);
    } catch (e) {
      // Engine may have exited (idle) — restart once.
      engine = await ensureEngine({ port: PORT, nodePath: process.execPath });
      res = await callTool(engine.port, engine.token, name, args);
    }
    if (res && res.error === "bad token") {
      engine = await ensureEngine({ port: PORT, nodePath: process.execPath });
      res = await callTool(engine.port, engine.token, name, args);
    }
    return { content: res.content || [{ type: "text", text: JSON.stringify(res) }], isError: !!res.isError };
  } catch (e) {
    return { content: [{ type: "text", text: `Claude Browser error: ${e.message}` }], isError: true };
  }
}

const target = {
  ref: z.string().optional().describe("Element ref from the latest browser_snapshot, e.g. 'e12' (preferred)"),
  selector: z.string().optional().describe("CSS selector (alternative to ref)"),
  text: z.string().optional().describe("Visible text to find the element by (alternative to ref)"),
};

server.registerTool(
  "browser_navigate",
  {
    description: "Open a URL in the shared tab, or go back/forward/reload. Bare hosts like 'localhost:5173/dashboard' are fine.",
    inputSchema: {
      url: z.string().optional().describe("URL to open"),
      action: z.enum(["back", "forward", "reload"]).optional().describe("History action instead of a URL"),
    },
  },
  args => call("navigate", args)
);

server.registerTool(
  "browser_screenshot",
  {
    description: "Screenshot of exactly what the user sees in the shared tab (CSS-pixel resolution by default). Optionally a single element or the full page. After code edits on a dev server the page updates by itself (HMR): check with browser_verify instead of reloading.",
    inputSchema: {
      ref: z.string().optional().describe("Only this element (ref from browser_snapshot)"),
      selector: z.string().optional().describe("Only this element (CSS selector)"),
      fullPage: z.boolean().optional().describe("Capture the whole scrollable page (capped at 8000px tall)"),
      hiDpi: z.boolean().optional().describe("Capture at device pixel ratio instead of CSS pixels (bigger image)"),
      viewports: z.boolean().optional().describe("Return one screenshot per device size (mobile, tablet, desktop) of the current page: use it to check a responsive change. Turns the side-by-side view on if it is off."),
    },
  },
  args => call("screenshot", args)
);

server.registerTool(
  "browser_snapshot",
  {
    description:
      "Text snapshot of the page: visible text, headings, inputs and clickable elements with [eN] refs for browser_click/type/hover/scroll, and ‹file:line› JSX source stamps when the app provides them. Cheaper than a screenshot for finding things.",
    inputSchema: { maxChars: z.number().int().optional().describe("Truncate output (default 40000)") },
  },
  args => call("snapshot", args)
);

server.registerTool(
  "browser_click",
  {
    description: "Click an element with a real mouse event (scrolls it into view first). Target by ref (preferred), selector, visible text, or x/y viewport coordinates.",
    inputSchema: {
      ...target,
      x: z.number().optional().describe("Viewport x (CSS px) when not targeting an element"),
      y: z.number().optional().describe("Viewport y (CSS px)"),
      double: z.boolean().optional().describe("Double-click"),
      button: z.enum(["left", "right", "middle"]).optional(),
    },
  },
  args => call("click", args)
);

server.registerTool(
  "browser_type",
  {
    description: "Type text with real key events. If a target is given it is clicked first to focus it; otherwise types into the focused element.",
    inputSchema: {
      text: z.string().describe("Text to type (any language)"),
      ref: target.ref,
      selector: target.selector,
      text_match: z.string().optional().describe("Find the field to focus by its visible text/label"),
      clear: z.boolean().optional().describe("Select and delete the existing value first"),
      submit: z.boolean().optional().describe("Press Enter afterwards"),
      slowly: z.boolean().optional().describe("Type one key at a time with a short delay (for key-handler-driven inputs like OTP boxes)"),
    },
  },
  args => call("type", args)
);

server.registerTool(
  "browser_press",
  {
    description: "Press a key or combo in the focused element, e.g. 'Enter', 'Escape', 'Tab', 'ArrowDown', 'Shift+Tab', 'Meta+A'.",
    inputSchema: { key: z.string() },
  },
  args => call("press", args)
);

server.registerTool(
  "browser_hover",
  {
    description: "Move the mouse over an element (to reveal tooltips, menus, hover styles).",
    inputSchema: { ...target, x: z.number().optional(), y: z.number().optional() },
  },
  args => call("hover", args)
);

server.registerTool(
  "browser_scroll",
  {
    description: "Scroll with the mouse wheel at an element (or the viewport centre). With only a target and no deltas, scrolls that element into view.",
    inputSchema: {
      ...target,
      dy: z.number().optional().describe("Vertical pixels (positive = down). Default 600 when no target"),
      dx: z.number().optional().describe("Horizontal pixels"),
    },
  },
  args => call("scroll", args)
);

server.registerTool(
  "browser_wait",
  {
    description: "Wait for text to appear/disappear, a selector to become visible, or a fixed time.",
    inputSchema: {
      text: z.string().optional(),
      textGone: z.string().optional(),
      selector: z.string().optional(),
      ms: z.number().optional(),
      timeout: z.number().optional().describe("Max wait in ms (default 10000)"),
    },
  },
  args => call("wait", args)
);

server.registerTool(
  "browser_evaluate",
  {
    description: "Run JavaScript in the page and return the JSON result. Accepts an expression or a function body with `return`. Awaits promises.",
    inputSchema: { expression: z.string() },
  },
  args => call("evaluate", args)
);

server.registerTool(
  "browser_console",
  {
    description: "Console messages, uncaught page errors, failed/4xx/5xx network requests and dialogs from the shared tab.",
    inputSchema: {
      types: z.array(z.enum(["log", "info", "warn", "error", "debug", "pageerror", "network", "dialog"])).optional().describe("Only these types"),
      sinceSeq: z.number().int().optional().describe("Only entries after this sequence number"),
      limit: z.number().int().optional().describe("Max entries (default 80, newest kept)"),
      clear: z.boolean().optional().describe("Clear the buffer after reading"),
    },
  },
  args => call("console", args)
);

server.registerTool(
  "browser_react",
  {
    description:
      "Live React state of the page: for an element (ref, selector or text) the components that render it, nearest first, each with its current props, hook values (useState, useReducer, useMemo, useRef…) and the contexts it reads; or, with `component`, the mounted instances of a component by name. Use it to check what a component actually received or holds instead of adding console.log. Dev builds give hook names; values named like passwords or tokens are masked.",
    inputSchema: {
      ...target,
      component: z.string().optional().describe("Component name to find anywhere on the page (exact, else partial match), instead of an element"),
      depth: z.number().int().optional().describe("How many components up from the element to describe (default 3, max 8)"),
      tree: z.boolean().optional().describe("Also print the names of the components rendered below it"),
      limit: z.number().int().optional().describe("With component: how many instances (default 3)"),
      maxChars: z.number().int().optional().describe("Detail budget per component (default 2500)"),
    },
  },
  args => call("react", args)
);

server.registerTool(
  "browser_network",
  {
    description:
      "The shared tab's network log. Without id: a list of requests (by default API calls and documents; failed ones always) with status, method, time and size. With id: one request in full — request headers and body, response headers and body (JSON pretty-printed), timing, and the source line that started it. Use it to see what the app actually sent and received instead of guessing from the UI.",
    inputSchema: {
      id: z.number().int().optional().describe("Request number from the list (#N): show it in full"),
      url: z.string().optional().describe("Only requests whose URL contains this text (or matches it as a regex), e.g. '/api/transfers'"),
      method: z.string().optional().describe("Only this HTTP method"),
      status: z.string().optional().describe("'error' (failed or ≥400), '4xx', '5xx', or an exact code like '401'"),
      types: z.array(z.string()).optional().describe("Resource types to list: fetch, xhr, document, script, stylesheet, image, font, websocket, other"),
      all: z.boolean().optional().describe("List every resource type, not only API calls and documents"),
      allTabs: z.boolean().optional().describe("Include requests from all tabs"),
      panes: z.boolean().optional().describe("Side-by-side view: include the requests of the other device panes too, each row labelled with its pane"),
      sinceSeq: z.number().int().optional().describe("Only requests after this number (use the 'latest seq' of an earlier call to see what one action caused)"),
      limit: z.number().int().optional().describe("How many to list (default 40, newest)"),
      maxChars: z.number().int().optional().describe("With id: how much of each body to return (default 8000)"),
      showSecrets: z.boolean().optional().describe("With id: show Authorization / Cookie header values in full (hidden by default)"),
      clear: z.boolean().optional().describe("Empty the log"),
    },
  },
  args => call("network", args)
);

server.registerTool(
  "browser_picked",
  {
    description:
      "What the user last sent from the browser: a pick card for an element they clicked with the picker (what it is, where on the page, the source line when known), an annotated screenshot with the elements under each numbered mark, or page errors with source-mapped stacks. Use when the user refers to something they picked or sent and it isn't already in the prompt.",
    inputSchema: { count: z.number().int().optional().describe("How many recent picks (default 1)") },
  },
  args => call("picked", args)
);

server.registerTool(
  "browser_verify",
  {
    description:
      "Check a code change in the browser in one call. Waits for the dev server's hot update or reload to reach the page (Vite, webpack, Next.js), then reports: " +
      "build errors and error overlays; the element (a pick, or ref/selector/text) found again, with what changed in its size, position, text, classes and computed styles since the pick or the last verify, plus before/after pictures of it; " +
      "and console errors, exceptions and failed requests since the change. Without an element it returns a screenshot of the page instead. " +
      "Call it right after the edit; each call becomes the 'before' of the next.",
    inputSchema: {
      pick: z.number().int().optional().describe("The pick number from a pick card"),
      ...target,
      expect: z.string().optional().describe("Text that should now be in the element (or on the page)"),
      screenshot: z.enum(["auto", "element", "page", "none"]).optional().describe("auto (default): the element before/after, or the page when no element is given"),
      viewports: z.boolean().optional().describe("Also a screenshot per device size (mobile, tablet, desktop)"),
      timeout: z.number().int().optional().describe("How long to wait for the update to arrive, ms (default 8000)"),
    },
  },
  args => call("verify", args)
);

server.registerTool(
  "browser_inspect",
  {
    description:
      "Details of a picked element (or any element by ref/selector/text), one aspect at a time so you only pay for what the task needs. " +
      "styles: the computed values that are set (layout, type, color, border, shadow, transform…), ::before/::after, and what changes on :hover and :focus. " +
      "rules: the authored CSS rules that apply, winning declarations only, by stylesheet and line. " +
      "layout: box, its flex/grid container and children sizes. " +
      "animation: running and declared animations/transitions, keyframes, animation libraries on the page; with ms it also watches style/class changes for that long (JS-driven effects), and with scroll it scrolls the element through the viewport meanwhile. " +
      "events: listeners on it and its ancestors, document and window, plus React handlers, with code locations mapped to source when available. " +
      "html: trimmed outerHTML. react: props, state and context of its components. source: the component chain with file:line usage sites.",
    inputSchema: {
      pick: z.number().int().optional().describe("The pick number from a pick card"),
      ...target,
      aspect: z
        .union([z.enum(["styles", "rules", "layout", "animation", "events", "html", "react", "source"]), z.array(z.enum(["styles", "rules", "layout", "animation", "events", "html", "react", "source"]))])
        .describe("What to look at; an array for several"),
      ms: z.number().int().optional().describe("animation only: also watch style/class changes for this long (max 8000)"),
      scroll: z.boolean().optional().describe("animation with ms: scroll the element up through the viewport while watching (scroll-linked effects); the scroll position is restored after"),
      maxChars: z.number().int().optional().describe("Size budget for rules/html/react"),
    },
  },
  args => call("inspect", args)
);

server.registerTool(
  "browser_viewport",
  {
    description: "Set a fixed viewport size (e.g. 390×844 mobile) or reset to follow the user's panel size. The panel shows the fixed size letterboxed.",
    inputSchema: {
      width: z.number().int().optional(),
      height: z.number().int().optional(),
      mobile: z.boolean().optional().describe("Emulate a mobile device (meta viewport, mobile UA behaviours)"),
      reset: z.boolean().optional().describe("Follow the panel size again"),
      multi: z.boolean().optional().describe("true: show mobile, tablet and desktop side by side (393×852, 820×1180 and 1280×800 unless other sizes were chosen, see sizes), with navigation and scrolling kept in sync; the shared tab becomes the desktop one. false: back to a single view."),
      sizes: z
        .record(z.object({ width: z.number(), height: z.number(), name: z.string().optional() }).nullable())
        .optional()
        .describe('Side-by-side view: another size for a device, keyed by "mobile", "tablet" or "desktop", e.g. { mobile: { width: 375, height: 667, name: "iPhone SE" }, desktop: { width: 1024, height: 768 } }. null puts a device back to its default. The sizes are remembered.'),
    },
  },
  args => call("viewport", args)
);

server.registerTool(
  "browser_tabs",
  {
    description: "List, open, switch or close tabs. The active tab is the one the user sees and that every other browser_* tool acts on. Links with target=_blank and window.open popups open new tabs automatically.",
    inputSchema: {
      action: z.enum(["list", "new", "switch", "close"]).optional().describe("Default list"),
      index: z.number().int().optional().describe("Tab index from the list (for switch/close; close defaults to the active tab)"),
      url: z.string().optional().describe("URL for a new tab"),
    },
  },
  args => call("tabs", args)
);

server.registerTool(
  "browser_upload",
  {
    description:
      "Attach local file(s) to a file upload. Either click the page's upload control first (browser_click reports that a file chooser opened) and pass only paths, or pass the ref/selector of an <input type=file>.",
    inputSchema: {
      paths: z.array(z.string()).describe("Absolute file paths (~ allowed)"),
      ref: z.string().optional(),
      selector: z.string().optional(),
    },
  },
  args => call("upload", args)
);

server.registerTool(
  "browser_select",
  {
    description: "Choose an option in a native <select> by value or visible label (native dropdowns can't be clicked open in the headless tab).",
    inputSchema: {
      option: z.string().describe("Option value or (partial) label"),
      ref: z.string().optional(),
      selector: z.string().optional(),
    },
  },
  args => call("select", args)
);

server.registerTool(
  "browser_downloads",
  {
    description: "Recent downloads from the shared tab with their saved paths (files land in ~/Downloads).",
    inputSchema: { limit: z.number().int().optional() },
  },
  args => call("downloads", args)
);

server.registerTool(
  "browser_status",
  { description: "Engine and browser version, current URL, whether the page is responding, viewport, and how many viewer panels are connected.", inputSchema: {} },
  args => call("status", args)
);

server.registerTool(
  "browser_restart",
  {
    description: "Restart the browser process and reopen the same tabs. Use when browser tools time out or browser_status reports the page is not responding. The engine also does this on its own when Chrome stops answering.",
    inputSchema: {},
  },
  args => call("restart", args)
);

server.connect(new StdioServerTransport()).catch(e => {
  process.stderr.write(`claude-browser mcp failed: ${e.stack}\n`);
  process.exit(1);
});

// Maps generated script locations (from React 19 `_debugStack` frames) back to
// the original source file:line:col using the dev server's source maps.
// No project plugin needed: Vite / webpack / Next dev servers all serve maps.

const fs = require("fs");
const path = require("path");

const B64 ="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_VAL = new Map([...B64].map((c, i) => [c, i]));

// Decode "mappings" into per-line arrays of [genCol, srcIdx, srcLine, srcCol] (all 0-based).
function decodeMappings(str) {
  const lines = [];
  let srcIdx = 0;
  let srcLine = 0;
  let srcCol = 0;
  for (const lineStr of str.split(";")) {
    const segs = [];
    let genCol = 0;
    if (lineStr) {
      for (const seg of lineStr.split(",")) {
        const vals = [];
        let shift = 0;
        let value = 0;
        for (const ch of seg) {
          const d = B64_VAL.get(ch);
          if (d === undefined) break;
          value += (d & 31) << shift;
          if (d & 32) {
            shift += 5;
          } else {
            vals.push(value & 1 ? -(value >>> 1) : value >>> 1);
            shift = 0;
            value = 0;
          }
        }
        if (!vals.length) continue;
        genCol += vals[0];
        if (vals.length >= 4) {
          srcIdx += vals[1];
          srcLine += vals[2];
          srcCol += vals[3];
          segs.push([genCol, srcIdx, srcLine, srcCol]);
        }
      }
    }
    lines.push(segs);
  }
  return lines;
}

const cache = new Map(); // script url -> Promise<{ map, lines } | null>
const MAX_CACHE = 400;

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function loadMap(scriptUrl) {
  const code = await fetchText(scriptUrl);
  const m = /\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/m.exec(code.slice(-2_000_000));
  if (!m) return null;
  let json;
  const ref = m[1];
  if (ref.startsWith("data:")) {
    const comma = ref.indexOf(",");
    const meta = ref.slice(0, comma);
    const body = ref.slice(comma + 1);
    json = meta.includes(";base64") ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body);
  } else {
    json = await fetchText(new URL(ref, scriptUrl).href);
  }
  const map = JSON.parse(json);
  if (map.sections) return null; // index maps: not used by dev servers we care about
  return { map, lines: decodeMappings(map.mappings || "") };
}

// A dev server re-serves the same URL with new content after every edit, so a
// map is only trusted briefly: a stale one puts picks on the wrong lines.
const MAP_TTL_MS = 2500;

function getMap(scriptUrl) {
  const hit = cache.get(scriptUrl);
  if (hit && Date.now() - hit.at < MAP_TTL_MS) return hit.p;
  const p = loadMap(scriptUrl).catch(() => null);
  cache.delete(scriptUrl);
  cache.set(scriptUrl, { p, at: Date.now() });
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  return p;
}

// Path shown to the user / opened in the editor.
function displayPath(scriptUrl, source) {
  let u;
  try {
    u = new URL(scriptUrl);
  } catch {
    return source;
  }
  const p = decodeURIComponent(u.pathname);
  // Vite: files under the project root are served at their own path.
  if (p.startsWith("/@fs/")) return p.slice(4);
  if (/\.(m?[jt]sx?|vue|svelte|astro|mdx)$/.test(p) && !p.includes("/node_modules/") && !p.startsWith("/_next/") && !p.startsWith("/static/")) {
    return p.replace(/^\//, "");
  }
  // Bundled (webpack / Next / CRA): use the map's source path.
  if (source) {
    return source
      .replace(/^webpack:\/\/[^/]*\//, "")
      .replace(/^file:\/\//, "")
      .replace(/^(\.\/)+/, "")
      .replace(/\?.*$/, "");
  }
  return p.replace(/^\//, "");
}

function absolutePath(map, source) {
  const candidates = [];
  if (source && path.isAbsolute(source)) candidates.push(source);
  if (map.file && path.isAbsolute(map.file)) {
    if (source && !/^[a-z]+:/i.test(source)) candidates.push(path.resolve(path.dirname(map.file), source));
    candidates.push(map.file);
  }
  return candidates.find(c => !c.includes("/node_modules/") && fs.existsSync(c)) || null;
}

// Resolve one generated location (1-based line/col) to "path:line:col", or null.
async function resolveLocation(scriptUrl, line, col) {
  const entry = await getMap(scriptUrl);
  if (!entry) {
    return null;
  }
  const segs = entry.lines[line - 1];
  if (!segs || !segs.length) return null;
  const c = col - 1;
  let best = null;
  for (const s of segs) {
    if (s[0] <= c) best = s;
    else break;
  }
  if (!best) best = segs[0];
  const source = entry.map.sources && entry.map.sources[best[1]];
  const root = entry.map.sourceRoot || "";
  // Prefer an absolute path on disk: a relative "src/…" is ambiguous when
  // several projects are open (both may have src/components/ui/input.tsx).
  let file = absolutePath(entry.map, source ? root + source : "");
  if (!file) file = displayPath(scriptUrl, source ? root + source : "");
  if (/(^|\/)node_modules\//.test(file)) return null;
  return `${file}:${best[2] + 1}:${best[3] + 1}`;
}

// In-page code writes unresolved locations as ⟦url:line:col⟧. Replace each
// marker with the original source location (or drop it if it can't be mapped).
const MARKER = /⟦(.+?):(\d+):(\d+)⟧/g;

async function resolveMarkers(text) {
  if (typeof text !== "string" || !text.includes("⟦")) return text;
  const found = new Map();
  for (const m of text.matchAll(MARKER)) found.set(m[0], [m[1], +m[2], +m[3]]);
  const resolved = new Map();
  await Promise.all(
    [...found].map(async ([key, [url, line, col]]) => {
      resolved.set(key, (await resolveLocation(url, line, col).catch(() => null)) || "");
    })
  );
  return text.replace(MARKER, m => resolved.get(m) || "");
}

function clearCache() {
  cache.clear();
}

module.exports = { resolveLocation, resolveMarkers, clearCache, decodeMappings };

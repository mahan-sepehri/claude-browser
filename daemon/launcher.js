// Shared by the editor extension and the MCP server: find a running engine or
// start one (detached, so it outlives whoever started it). Also replaces an
// engine that is older than this code or that has stopped answering.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const HOME = process.env.CLAUDE_BROWSER_HOME || path.join(os.homedir(), ".claude-browser");
const TOKEN_FILE = path.join(HOME, "token");
const LOG_FILE = path.join(HOME, "engine.log");
const PID_FILE = path.join(HOME, "engine.pid");
const CONFIG_FILE = path.join(HOME, "config.json");
const VERSION = require("../package.json").version;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function health(port, timeout = 800) {
  return new Promise(resolve => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout }, res => {
      let body = "";
      res.on("data", c => (body += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(body);
          resolve(j && j.name === "claude-browser" ? j : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function readToken() {
  return fs.readFileSync(TOKEN_FILE, "utf8").trim();
}

function cmpVersion(a, b) {
  const x = String(a || "0").split(".").map(Number);
  const y = String(b || "0").split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// The engine process recorded in the pid file, if it is still an engine.
function enginePid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
    if (!pid || !alive(pid)) return null;
    if (process.platform !== "win32") {
      const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
      if (!/daemon[\\/]daemon\.js/.test(cmd)) return null;
    }
    return pid;
  } catch {
    return null;
  }
}

// Stops the engine for sure: ask nicely, then kill whatever is left.
async function stopEngine(port) {
  port = port || 47321;
  const pid = enginePid();
  if (await health(port, 600)) {
    try {
      await shutdownEngine(port, readToken());
    } catch {}
    for (let i = 0; i < 20 && (await health(port, 300)); i++) await sleep(150);
  }
  if (pid && alive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    await sleep(200);
  }
}

/**
 * @param {{port?:number, nodePath?:string, env?:object}} opts
 * @returns {Promise<{port:number, token:string, started:boolean, version:string}>}
 */
async function ensureEngine({ port, nodePath, env } = {}) {
  port = port || 47321;
  const h = await health(port, 1500);
  if (h && cmpVersion(h.version, VERSION) >= 0) return { port, token: readToken(), started: false, version: h.version };
  // Older engine still running, or one that holds the port without answering.
  if (h || enginePid()) await stopEngine(port);

  fs.mkdirSync(HOME, { recursive: true });
  try {
    // Keep the log from growing forever.
    if (fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + ".1");
  } catch {}
  const out = fs.openSync(LOG_FILE, "a");
  const child = spawn(nodePath || process.execPath, [path.join(__dirname, "daemon.js")], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, ...(env || {}), CLAUDE_BROWSER_PORT: String(port) },
  });
  child.unref();
  fs.closeSync(out);

  for (let i = 0; i < 80; i++) {
    await sleep(150);
    const up = await health(port);
    if (up) return { port, token: readToken(), started: true, version: up.version };
  }
  throw new Error(`Claude Browser engine did not start on port ${port}. See ${LOG_FILE}`);
}

function callTool(port, token, name, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ name, args });
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/tool",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-cb-token": token },
        timeout: 120000,
      },
      res => {
        let data = "";
        res.on("data", c => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Bad engine response (${res.statusCode}): ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("engine request timed out")));
    req.end(body);
  });
}

function shutdownEngine(port, token) {
  return new Promise(resolve => {
    const req = http.request({ host: "127.0.0.1", port, path: "/api/shutdown", method: "POST", headers: { "x-cb-token": token }, timeout: 3000 }, res => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", resolve);
    req.on("timeout", () => {
      req.destroy();
      resolve();
    });
    req.end();
  });
}

// Settings the engine reads at start (it may be started by the MCP server,
// which has no access to the editor's settings).
function writeConfig(cfg) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    const next = JSON.stringify(cfg, null, 2);
    let prev = "";
    try {
      prev = fs.readFileSync(CONFIG_FILE, "utf8");
    } catch {}
    if (prev !== next) fs.writeFileSync(CONFIG_FILE, next);
    return prev !== next;
  } catch {
    return false;
  }
}

module.exports = { ensureEngine, stopEngine, callTool, shutdownEngine, health, writeConfig, HOME, LOG_FILE, PID_FILE, CONFIG_FILE, VERSION };

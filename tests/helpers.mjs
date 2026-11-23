import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { encodeFrame } from "../web/protocol.mjs";

export async function launch(args = [], { release = false, logLevel = "webcontroller=debug" } = {}) {
  const binary = new URL(`../target/${release ? "release" : "debug"}/webcontroller${process.platform === "win32" ? ".exe" : ""}`, import.meta.url);
  const child = spawn(binary.pathname, args, {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, RUST_LOG: logLevel },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const startupError = new Promise((_, reject) => child.once("error", reject));
  const wait = async () => {
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null) throw new Error(`server exited: ${errors}`);
      const match = output.match(/PAIR_URL=(http:\/\/127\.0\.0\.1:\d+\/#pair=[a-f0-9]+)/);
      if (match) {
        const pairingUrl = match[1];
        const origin = new URL(pairingUrl).origin;
        const ready = await fetch(`${origin}/health`).catch(() => null);
        if (ready?.ok) return { pairingUrl, origin };
      }
      await delay(25);
    }
    throw new Error(`server startup timed out: ${errors}`);
  };
  let info;
  try {
    info = await Promise.race([wait(), startupError]);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  return {
    ...info,
    child,
    errors: () => errors,
    async stop() { await stop(child); },
  };
}

export async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGINT");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  try { await exited; } finally { clearTimeout(timer); }
}

export async function pair(server) {
  const response = await fetch(`${server.origin}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: server.origin },
    body: JSON.stringify({ ticket: new URLSearchParams(new URL(server.pairingUrl).hash.slice(1)).get("pair") }),
  });
  if (!response.ok) throw new Error(`pairing failed: ${response.status}`);
  return (await response.json()).token;
}

export class Peer {
  constructor(origin, path = "/ws/control", withOrigin = true) {
    this.socket = new WebSocket(origin.replace(/^http/, "ws") + path, {
      ...(withOrigin ? { origin } : {}),
    });
    this.messages = [];
    this.waiters = [];
    this.sequence = 0;
    this.closed = false;
    this.socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.messages.push(message);
    });
    this.socket.on("close", () => { this.closed = true; });
  }
  async open(token, extra = {}) {
    await once(this.socket, "open");
    this.socket.send(JSON.stringify({ token, ...extra }));
    return this.next();
  }
  next() {
    if (this.messages.length) return Promise.resolve(this.messages.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== done);
        reject(new Error("websocket message timed out"));
      }, 2500);
      const done = (message) => { clearTimeout(timer); resolve(message); };
      this.waiters.push(done);
    });
  }
  command(kind, value) {
    this.socket.send(encodeFrame(++this.sequence, kind, value));
    return this.next();
  }
  async close() {
    if (this.closed) return;
    const closed = once(this.socket, "close");
    this.socket.close();
    const timer = setTimeout(() => this.socket.terminate(), 1000);
    try { await closed; } finally { clearTimeout(timer); }
  }
}

export const localArgs = ["--host", "127.0.0.1", "--port", "0", "--dry-run", "--no-qr"];

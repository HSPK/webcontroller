import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { launch, localArgs, pair, Peer, stop } from "./helpers.mjs";

test("LAN server pairs once, enforces origins, and serves the complete offline client", async (t) => {
  const server = await launch(localArgs);
  t.after(() => server.stop());
  for (const path of ["/", "/app.mjs", "/protocol.mjs", "/transport.mjs", "/touchpad.mjs", "/style.css"]) {
    const response = await fetch(server.origin + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok(response.headers.get("content-security-policy").includes("frame-ancestors 'none'"));
  }
  assert.equal((await fetch(server.origin, { headers: { origin: "https://evil.example" } })).status, 403);
  const token = await pair(server);
  assert.equal(token.length, 64);
  await assert.rejects(() => pair(server));
});

test("authenticated control is exclusive, ordered, Unicode-safe and never replays input", async (t) => {
  const server = await launch(localArgs);
  t.after(() => server.stop());
  const token = await pair(server);
  const invalid = new Peer(server.origin);
  t.after(() => invalid.close());
  assert.equal((await invalid.open("invalid")).kind, "error");
  const first = new Peer(server.origin);
  t.after(() => first.close());
  assert.equal((await first.open(token)).kind, "ready");
  const busy = new Peer(server.origin);
  t.after(() => busy.close());
  assert.match((await busy.open(token)).error, /another controller/);
  assert.equal((await first.command("chord", [0xe3, 6])).ok, true);
  assert.equal((await first.command("text", "你好 👋")).ok, true);
  assert.equal((await first.command("down", 0xe0)).ok, true);
  const failed = await first.command("text", "must not inject with Ctrl held");
  assert.equal(failed.ok, false);
  assert.match(failed.error, /modifier/);
  await first.close();
  const resumed = new Peer(server.origin);
  t.after(() => resumed.close());
  assert.equal((await resumed.open(token)).kind, "ready");
  assert.equal((await resumed.command("text", "new session")).ok, true);
  assert.match(server.errors(), /key=224 down=false/);
});

test("lease expiry releases held keys even when transport pings continue", async (t) => {
  const server = await launch(localArgs);
  t.after(() => server.stop());
  const token = await pair(server);
  const first = new Peer(server.origin);
  t.after(() => first.close());
  await first.open(token);
  await first.command("down", 82);
  const pings = setInterval(() => {
    if (first.socket.readyState === 1) first.socket.ping();
  }, 100);
  t.after(() => clearInterval(pings));
  await delay(1450);
  assert.match(server.errors(), /key=82 down=false/);
  const second = new Peer(server.origin);
  t.after(() => second.close());
  assert.equal((await second.open(token)).kind, "ready");
  assert.equal((await second.command("heartbeat")).ok, true);
});

test("duplicate sequence closes the old controller and releases its keys", async (t) => {
  const server = await launch(localArgs);
  t.after(() => server.stop());
  const token = await pair(server);
  const first = new Peer(server.origin);
  t.after(() => first.close());
  await first.open(token);
  await first.command("down", 4);
  first.sequence = 0;
  first.socket.send(new Uint8Array([1, 5, 1, 0, 0, 0]));
  await delay(150);
  assert.equal(first.closed, true);
  assert.match(server.errors(), /key=4 down=false/);
});

test("held keys keep repeating while pointer traffic continuously occupies the executor", { timeout: 10000 }, async (t) => {
  const server = await launch(localArgs);
  t.after(() => server.stop());
  const token = await pair(server);
  const peer = new Peer(server.origin);
  t.after(() => peer.close());
  await peer.open(token);
  await peer.command("down", 82);
  const until = performance.now() + 900;
  while (performance.now() < until) {
    assert.equal((await peer.command("move", [1, 0])).ok, true);
  }
  await peer.command("up", 82);
  assert.ok((server.errors().match(/key=82 down=true/g) || []).length >= 4, "pointer traffic must not starve key repeat");
  assert.match(server.errors(), /key=82 down=false/);
});

test("standalone daemon connects outbound, reports its platform and injects relayed input", async (t) => {
  const daemonToken = randomBytes(32).toString("hex");
  const server = await launch([
    "server", "--host", "127.0.0.1", "--port", "0", "--no-qr", "--daemon-token", daemonToken,
  ]);
  t.after(() => server.stop());
  assert.equal((await (await fetch(server.origin + "/health")).json()).daemon_online, false);
  const child = spawn(new URL("../target/debug/webcontroller", import.meta.url).pathname, [
    "daemon", "--server", server.origin, "--dry-run",
  ], {
    env: { ...process.env, WEBCONTROLLER_DAEMON_TOKEN: daemonToken },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  t.after(() => stop(child));
  let online = false;
  for (let i = 0; i < 100; i++) {
    online = (await (await fetch(server.origin + "/health")).json()).daemon_online;
    if (online) break;
    await delay(30);
  }
  assert.equal(online, true, errors);
  const token = await pair(server);
  const peer = new Peer(server.origin);
  t.after(() => peer.close());
  const ready = await peer.open(token);
  assert.equal(ready.transport, "relay");
  assert.equal(ready.dry_run, true);
  assert.ok(["macos", "windows", "linux"].includes(ready.platform));
  assert.equal((await peer.command("text", "远端输入 👋")).ok, true);
  assert.equal((await peer.command("chord", [0xe0, 6])).ok, true);
  assert.equal((await peer.command("move", [12, -9])).ok, true);
  assert.equal((await peer.command("click", [1, 2])).ok, true);
  assert.equal((await peer.command("scroll", [0, 40])).ok, true);
  await peer.close();
  await stop(child);
  for (let i = 0; i < 50; i++) {
    if (!(await (await fetch(server.origin + "/health")).json()).daemon_online) break;
    await delay(30);
  }
  const offline = new Peer(server.origin);
  t.after(() => offline.close());
  assert.match((await offline.open(token)).error, /offline/);
});

test("mouse movement, buttons and scroll share control leases and release after a lost drag", async (t) => {
  const server = await launch(localArgs);
  t.after(() => server.stop());
  const token = await pair(server);
  const peer = new Peer(server.origin);
  t.after(() => peer.close());
  await peer.open(token);
  for (const [command, value] of [
    ["mouse-down", 1], ["move", [100, -30]], ["scroll", [-10, 40]],
    ["mouse-up", 1], ["click", [2, 1]], ["click", [1, 2]], ["mouse-down", 1],
  ]) {
    assert.equal((await peer.command(command, value)).ok, true);
  }
  await delay(1450);
  assert.match(server.errors(), /Move \{ x: 100, y: -30, buttons: 1 \}/);
  assert.match(server.errors(), /Button \{ button: 1, down: false, count: 1 \}/);
  const replacement = new Peer(server.origin);
  t.after(() => replacement.close());
  assert.equal((await replacement.open(token)).kind, "ready");
  assert.equal((await replacement.command("click", [1, 1])).ok, true);
});

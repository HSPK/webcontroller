import { chromium, devices } from "@playwright/test";
import { launch, localArgs, pair, Peer } from "./helpers.mjs";

const server = await launch(localArgs, { release: true, logLevel: "webcontroller=warn" });
let browser;
let peer;
try {
  const token = await pair(server);
  peer = new Peer(server.origin);
  await peer.open(token);
  for (let index = 0; index < 50; index++) await peer.command("move", [1, -1]);
  const samples = [];
  for (let index = 0; index < 500; index++) {
    const start = performance.now();
    const ack = await peer.command("move", [1, -1]);
    if (!ack.ok) throw new Error(ack.error || "movement was rejected");
    samples.push(performance.now() - start);
  }
  await peer.close();
  samples.sort((left, right) => left - right);
  const percentile = (fraction) => Number(samples[Math.ceil(samples.length * fraction) - 1].toFixed(3));

  browser = await chromium.launch();
  const page = await browser.newPage({ ...devices["Pixel 7"], viewport: { width: 390, height: 844 } });
  let movements = 0;
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
    if (typeof payload !== "string" && Buffer.from(payload)[1] === 7) movements++;
  }));
  await page.addInitScript((credential) => sessionStorage.setItem("nearby-token", credential), token);
  await page.goto(server.origin);
  await page.locator("#controls").waitFor({ state: "visible" });
  await page.locator("#tab-touchpad").click();
  await page.evaluate(() => {
    window.performanceCounts = { disabledWrites: 0, textCountWrites: 0, latencyWrites: 0 };
    for (const [selector, counter, options] of [
      ["#controls", "disabledWrites", { subtree: true, attributes: true, attributeFilter: ["disabled"] }],
      ["#text-count", "textCountWrites", { childList: true }],
      ["#latency", "latencyWrites", { childList: true }],
    ]) {
      new MutationObserver((records) => { window.performanceCounts[counter] += records.length; })
        .observe(document.querySelector(selector), options);
    }
  });
  const pad = await page.locator("#touchpad").boundingBox();
  await page.mouse.move(pad.x + 60, pad.y + 60);
  await page.mouse.down();
  for (let index = 1; index <= 60; index++) {
    await page.mouse.move(pad.x + 60 + (index % 2 ? 20 : 0), pad.y + 60);
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  await page.mouse.up();
  console.log(JSON.stringify({
    scope: "release build, dry-run, loopback; not real Wi-Fi or native input latency",
    move_ack_ms: { samples: samples.length, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
    touchpad: { movements, ...await page.evaluate(() => window.performanceCounts) },
  }, null, 2));
} finally {
  await browser?.close();
  await peer?.close();
  await server.stop();
}

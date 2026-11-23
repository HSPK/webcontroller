import { test, expect } from "@playwright/test";
import { launch, localArgs } from "../helpers.mjs";

let server;
let pageErrors;
let wire;

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  wire = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      if (typeof payload === "string") return;
      const frame = Buffer.from(payload);
      if (frame[0] !== 1 || frame.length < 6) return;
      wire.push({
        direction: "send", opcode: frame[1], sequence: frame.readUInt32LE(2),
        text: frame[1] === 3 ? frame.subarray(6).toString("utf8") : null,
        keys: [1, 2, 6].includes(frame[1])
          ? Array.from({ length: (frame.length - 6) / 2 }, (_, index) => frame.readUInt16LE(6 + index * 2))
          : [],
        delta: [7, 10].includes(frame[1]) ? [frame.readInt16LE(6), frame.readInt16LE(8)] : null,
        mouse: [8, 9, 11].includes(frame[1]) ? frame[6] : null,
        count: frame[1] === 11 ? frame[7] : null,
      });
    });
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      const message = JSON.parse(payload);
      if (message.kind === "ack") wire.push({ direction: "ack", ...message });
    });
  });
  server = await launch(localArgs);
  await page.goto(server.pairingUrl);
  await expect(page.locator("#status")).toHaveText("已连接电脑");
});

test.afterEach(async () => {
  await server?.stop();
  expect(pageErrors).toEqual([]);
});

const sent = () => wire.filter((entry) => entry.direction === "send" && entry.opcode !== 5);

async function assertFits(page) {
  const layout = await page.evaluate(() => {
    const top = window.visualViewport?.offsetTop || 0;
    const bottom = top + (window.visualViewport?.height || innerHeight);
    const violations = [];
    for (const element of document.querySelectorAll("button, textarea, input, select")) {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (element.closest("dialog") && !element.closest("dialog").open) continue;
      if (rect.top < top - 1 || rect.bottom > bottom + 1 || rect.left < -1 || rect.right > innerWidth + 1) {
        violations.push({ element: element.id || element.textContent, top: rect.top, bottom: rect.bottom, viewportBottom: bottom });
      }
    }
    const panel = document.querySelector('[data-panel]:not([hidden])');
    const dock = document.querySelector(".action-dock").getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const textarea = document.querySelector("#text").getBoundingClientRect();
    return {
      violations,
      pageOverflow: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
      panelOverflow: panel.scrollHeight > panel.clientHeight + 1,
      overlap: panelRect.bottom > dock.top + 1,
      textareaHeight: textarea.height,
      dockHeights: [...document.querySelectorAll(".action-dock button")].map((element) => element.getBoundingClientRect().height),
    };
  });
  expect(layout.violations).toEqual([]);
  expect(layout.pageOverflow).toBe(false);
  expect(layout.panelOverflow).toBe(false);
  expect(layout.overlap).toBe(false);
  expect(Math.min(...layout.dockHeights)).toBeGreaterThanOrEqual(44);
  if (await page.locator("#panel-input").isVisible()) expect(layout.textareaHeight).toBeGreaterThanOrEqual(32);
}

test("phone UI is one screen in portrait, landscape and reduced keyboard space", async ({ page }) => {
  expect(new URL(page.url()).hash).toBe("");
  await expect(page.locator("#connection-detail")).toContainText("演示模式");
  await expect(page.locator("#latency")).not.toHaveText("—");
  for (const size of [
    { width: 320, height: 568 }, { width: 390, height: 844 },
    { width: 844, height: 390 }, { width: 844, height: 280 }, { width: 844, height: 230 }, { width: 320, height: 320 },
    { width: 390, height: 280 },
  ]) {
    await page.setViewportSize(size);
    for (const mode of ["input", "control", "keyboard", "aux", "touchpad", "remote"]) {
      await page.locator(`[data-mode="${mode}"]`).click();
      await assertFits(page);
      if (mode === "remote") {
        const geometry = await page.locator(".remote-dpad").evaluate((element) => {
          const ring = element.getBoundingClientRect();
          return {
            difference: Math.abs(ring.width - ring.height),
            targets: [...element.querySelectorAll("button")].map((button) => {
              const rect = button.getBoundingClientRect();
              return Math.min(rect.width, rect.height);
            }),
          };
        });
        expect(geometry.difference).toBeLessThanOrEqual(1);
        expect(Math.min(...geometry.targets)).toBeGreaterThanOrEqual(44);
      }
    }
  }
});

test("one floating bar controls every mode and leaves most space for input in both orientations", async ({ page }) => {
  await expect(page.getByRole("tablist")).toHaveCount(1);
  await expect(page.locator(".float-bar [role=tab]")).toHaveCount(6);
  for (const size of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    await page.locator("#tab-input").click();
    const text = await page.locator("#text").boundingBox();
    const controls = await page.locator("#controls").boundingBox();
    const bar = await page.locator(".float-bar").boundingBox();
    expect(text.height / size.height).toBeGreaterThan(size.width > size.height ? 0.6 : 0.7);
    if (size.width > size.height) expect(bar.x).toBeGreaterThanOrEqual(controls.x + controls.width);
    else expect(bar.y).toBeGreaterThanOrEqual(controls.y + controls.height);
    await assertFits(page);
  }
  await page.locator("#tab-aux").click();
  await expect(page.locator("#keys-aux")).toBeVisible();
  await expect(page.locator("#keys-main")).toBeHidden();
  await expect(page.locator("#tab-aux")).toHaveAttribute("aria-selected", "true");
  await page.locator("#tab-aux").press("ArrowRight");
  await expect(page.locator("#tab-touchpad")).toHaveAttribute("aria-selected", "true");
});

test("TV remote sends one atomic action per tap and respects held modifiers", async ({ page }) => {
  await page.locator("#tab-remote").click();
  await expect(page.locator("#panel-remote")).toBeVisible();
  for (const key of [40, 41, 74, 101, 44, 80, 79, 75, 78]) {
    const before = sent().length;
    await page.locator(`#panel-remote [data-tap-key="${key}"]`).tap();
    await expect.poll(() => sent().length).toBe(before + 1);
    expect(sent().at(-1)).toMatchObject({ opcode: 6, keys: [key] });
  }
  await page.locator("#tab-control").click();
  await page.locator('#modifiers [data-modifier="224"]').tap();
  await page.locator("#tab-remote").click();
  const before = sent().length;
  await page.locator(".remote-ok").tap();
  await expect(page.locator("#notice-text")).toContainText("请先释放所有按键");
  expect(sent()).toHaveLength(before);
  await expect(page.locator("#status")).toHaveText("已连接电脑");
  await page.locator("#release").tap();
  await page.locator(".remote-ok").press("Enter");
  await expect.poll(() => sent().at(-1)).toMatchObject({ opcode: 6, keys: [40] });
});

test("TV remote playback does not repeat while held and directions release on mode changes", async ({ page }) => {
  await page.locator("#tab-remote").click();
  const playback = await page.locator('#panel-remote [data-tap-key="44"]').boundingBox();
  await page.mouse.move(playback.x + playback.width / 2, playback.y + playback.height / 2);
  await page.mouse.down();
  await expect.poll(() => sent().length).toBe(1);
  expect(sent()[0]).toMatchObject({ opcode: 6, keys: [44] });
  await page.waitForTimeout(550);
  await page.mouse.up();
  expect(sent()).toHaveLength(1);
  const ring = await page.locator(".remote-dpad").boundingBox();
  for (const [key, x, y] of [[82, 0.28, 0.16], [80, 0.16, 0.72], [81, 0.72, 0.84], [79, 0.84, 0.28]]) {
    await page.mouse.move(ring.x + ring.width * x, ring.y + ring.height * y);
    await page.mouse.down();
    await expect.poll(() => sent().at(-1)).toMatchObject({ opcode: 1, keys: [key] });
    await page.mouse.up();
    await expect.poll(() => sent().at(-1)).toMatchObject({ opcode: 2, keys: [key] });
  }
  const up = await page.locator(".remote-up").boundingBox();
  await page.mouse.move(up.x + up.width / 2, up.y + up.height / 2);
  await page.mouse.down();
  await expect(page.locator(".remote-up")).toHaveClass(/pressed/);
  expect(sent().at(-1)).toMatchObject({ opcode: 1, keys: [82] });
  await page.locator("#tab-keyboard").press("Enter");
  await expect.poll(() => sent().at(-1)).toMatchObject({ opcode: 2, keys: [82] });
  await page.mouse.up();
  await expect(page.locator("#release")).toHaveText("释放");
  await expect(page.locator("#status")).toHaveText("已连接电脑");
});

test("the status dot distinguishes stable, slow, poor and disconnected connections", async ({ page }) => {
  let latency = 0;
  const timers = new Set();
  await page.routeWebSocket("**/ws/control", (socket) => {
    socket.onMessage((message) => {
      if (typeof message === "string") {
        socket.send(JSON.stringify({ kind: "ready", platform: "macos", dry_run: true }));
        return;
      }
      const sequence = Buffer.from(message).readUInt32LE(2);
      const timer = setTimeout(() => {
        timers.delete(timer);
        socket.send(JSON.stringify({ kind: "ack", sequence, ok: true }));
      }, latency);
      timers.add(timer);
    });
  });
  try {
    await page.reload();
    const dot = page.locator("#status-dot");
    await expect(dot).toHaveAttribute("data-state", "stable");
    const stableColor = await dot.evaluate((element) => getComputedStyle(element).backgroundColor);
    latency = 150;
    await expect(dot).toHaveAttribute("data-state", "unstable");
    const slowColor = await dot.evaluate((element) => getComputedStyle(element).backgroundColor);
    latency = 350;
    await expect(dot).toHaveAttribute("data-state", "poor");
    const poorColor = await dot.evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(new Set([stableColor, slowColor, poorColor]).size).toBe(3);
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await expect(dot).toHaveAttribute("data-state", "offline");
    await expect(page.locator("#resume")).toBeVisible();
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
});

test("visual viewport resizing and panning keep typing and common actions reachable", async ({ page }) => {
  await page.locator("#text").focus();
  await page.evaluate(() => {
    const viewport = window.visualViewport;
    Object.defineProperty(viewport, "height", { configurable: true, value: 300 });
    Object.defineProperty(viewport, "offsetTop", { configurable: true, value: 75 });
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
  });
  await expect(page.locator("#app")).toHaveAttribute("data-tight", "true");
  const bounds = await page.locator("#app").boundingBox();
  expect(bounds.height).toBeCloseTo(300, 0);
  expect(bounds.y).toBeCloseTo(75, 0);
  await assertFits(page);
});

test("IME composition and the phone's Enter only edit the local draft", async ({ page }) => {
  const textarea = page.locator("#text");
  await textarea.fill("你好 👋");
  await textarea.dispatchEvent("compositionstart", { data: "你" });
  await expect(page.locator("#send-text")).toBeDisabled();
  await expect(page.locator("#send-enter")).toBeDisabled();
  await expect(page.getByRole("button", { name: "电脑回车", exact: true })).toBeDisabled();
  await textarea.dispatchEvent("compositionend", { data: "你好" });
  await expect(page.locator("#send-text")).toBeEnabled();
  await textarea.press("End");
  await textarea.press("Enter");
  await expect(textarea).toHaveValue("你好 👋\n");
  expect(sent()).toEqual([]);
  await page.locator("#send-text").tap();
  await expect(textarea).toHaveValue("");
  await expect(textarea).toBeFocused();
  await expect(page.locator("#input-result")).toHaveText("已发送文本");
  expect(sent().filter((entry) => entry.opcode === 3).map((entry) => entry.text)).toEqual(["你好 👋\n"]);
});

test("the text limit indicator only appears when the draft exceeds the UTF-8 limit", async ({ page }) => {
  const text = page.locator("#text");
  const count = page.locator("#text-count");
  await expect(count).toBeHidden();
  await text.fill("你".repeat(5500));
  await expect(count).toBeVisible();
  await expect(text).toHaveClass(/over-limit/);
  await expect(page.locator("#send-text")).toBeDisabled();
  await text.fill("继续输入");
  await expect(count).toBeHidden();
  await expect(text).not.toHaveClass(/over-limit/);
  await expect(page.locator("#send-text")).toBeEnabled();
});

test("send and Enter waits for text ACK, then sends one Enter and retains input focus", async ({ page }) => {
  const textarea = page.locator("#text");
  await textarea.fill("执行这一条");
  await page.locator("#send-enter").tap();
  await expect(page.locator("#input-result")).toHaveText("已发送文本并回车");
  await expect(textarea).toHaveValue("");
  await expect(textarea).toBeFocused();
  const commands = sent();
  expect(commands.map((entry) => entry.opcode)).toEqual([3, 6]);
  expect(commands[0].text).toBe("执行这一条");
  expect(commands[1].keys).toEqual([40]);
  const textAck = wire.findIndex((entry) => entry.direction === "ack" && entry.sequence === commands[0].sequence);
  const enter = wire.indexOf(commands[1]);
  expect(textAck).toBeGreaterThanOrEqual(0);
  expect(enter).toBeGreaterThan(textAck);
});

for (const action of ["send-text", "send-enter"]) {
  test(`${action} restores typing during the tap even if the browser focused the button`, async ({ page }) => {
    const textarea = page.locator("#text");
    const button = page.locator(`#${action}`);
    await textarea.fill("第一条");
    await button.focus();
    await expect(textarea).not.toBeFocused();
    await button.tap();
    await expect(textarea).toHaveValue("");
    await expect(textarea).toBeFocused();
    await page.keyboard.insertText("第二条");
    await expect(textarea).toHaveValue("第二条");
    await button.tap();
    await expect(textarea).toHaveValue("");
    await expect(textarea).toBeFocused();
    expect(sent().filter((entry) => entry.opcode === 3).map((entry) => entry.text)).toEqual(["第一条", "第二条"]);
  });
}

test("remote undo, backspace and Enter do not dismiss typing or modify the local draft", async ({ page }) => {
  const textarea = page.locator("#text");
  await textarea.fill("尚未发送的草稿");
  await page.getByRole("button", { name: "电脑撤销", exact: true }).tap();
  await expect(textarea).toBeFocused();
  await page.getByRole("button", { name: "电脑退格", exact: true }).tap();
  await expect(textarea).toBeFocused();
  await page.getByRole("button", { name: "电脑回车", exact: true }).tap();
  await expect(textarea).toBeFocused();
  await expect(textarea).toHaveValue("尚未发送的草稿");
  const commands = sent();
  expect(commands.map((entry) => entry.opcode)).toEqual([6, 1, 2, 1, 2]);
  expect(commands[0].keys).toEqual([process.platform === "darwin" ? 227 : 224, 29]);
  expect(commands.slice(1).map((entry) => entry.keys)).toEqual([[42], [42], [40], [40]]);
});

test("an Enter failure after text ACK never restores or retries the already sent draft", async ({ page }) => {
  const commands = [];
  await page.routeWebSocket("**/ws/control", (socket) => {
    socket.onMessage((message) => {
      if (typeof message === "string") {
        socket.send(JSON.stringify({ kind: "ready", platform: "macos", dry_run: true }));
        return;
      }
      const bytes = Buffer.from(message);
      const opcode = bytes[1];
      const sequence = bytes.readUInt32LE(2);
      if (opcode !== 5) commands.push(opcode);
      socket.send(JSON.stringify({ kind: "ack", sequence, ok: opcode !== 6, error: opcode === 6 ? "Enter failed" : undefined }));
    });
  });
  await page.reload();
  await expect(page.locator("#status")).toHaveText("已连接电脑");
  await page.locator("#text").fill("只能发送一次");
  await page.locator("#send-enter").tap();
  await expect(page.locator("#notice")).toContainText("文本已发送，回车");
  await expect(page.locator("#text")).toHaveValue("");
  expect(commands).toEqual([3, 6]);
});

test("a failed text submission never sends Enter or discards the draft", async ({ page }) => {
  const commands = [];
  await page.routeWebSocket("**/ws/control", (socket) => {
    socket.onMessage((message) => {
      if (typeof message === "string") {
        socket.send(JSON.stringify({ kind: "ready", platform: "macos", dry_run: true }));
        return;
      }
      const bytes = Buffer.from(message);
      const opcode = bytes[1];
      const sequence = bytes.readUInt32LE(2);
      if (opcode !== 5) commands.push(opcode);
      socket.send(JSON.stringify({ kind: "ack", sequence, ok: opcode !== 3, error: opcode === 3 ? "Text input failed; result may be partial" : undefined }));
    });
  });
  await page.reload();
  await expect(page.locator("#status")).toHaveText("已连接电脑");
  await page.locator("#text").fill("需要保留的草稿");
  await page.locator("#send-enter").tap();
  await expect(page.locator("#notice")).toContainText("Text input failed");
  await expect(page.locator("#text")).toHaveValue("需要保留的草稿");
  expect(commands).toEqual([3]);
});

test("sticky modifiers, pointer cancellation and emergency release remain synchronized across tabs", async ({ page }) => {
  await page.locator("#tab-control").click();
  const control = page.locator('#modifiers [data-modifier="224"]');
  await control.click();
  await expect(control).toHaveAttribute("aria-pressed", "true");
  await page.locator("#tab-input").click();
  await page.locator("#text").fill("不能带 Ctrl 提交");
  await expect(page.locator("#send-text")).toBeDisabled();
  await expect(page.locator("#release")).toContainText("1");
  await page.locator("#release").tap();
  await expect(page.locator("#send-text")).toBeEnabled();
  await page.locator("#tab-control").click();
  await expect(control).toHaveAttribute("aria-pressed", "false");
  const arrow = page.locator('#panel-control [data-key="82"]');
  await arrow.evaluate((element) => {
    element.addEventListener("pointerdown", (event) => {
      element.dataset.activePointer = String(event.pointerId);
    }, { once: true });
  });
  const bounds = await arrow.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await expect(arrow).toHaveClass(/pressed/);
  await arrow.dispatchEvent("pointercancel", {
    pointerId: Number(await arrow.getAttribute("data-active-pointer")),
    button: 0, pointerType: "mouse",
  });
  await expect(arrow).not.toHaveClass(/pressed/);
  await page.mouse.up();
  await page.locator('[data-shortcut="copy"]').click();
  await expect(page.locator("#status")).toHaveText("已连接电脑");
});

test("hiding the phone keyboard and window blur preserve the connection and draft", async ({ page }) => {
  const textarea = page.locator("#text");
  await textarea.fill("收起后继续发送");
  await page.locator("#hide-keyboard").tap();
  await expect(textarea).not.toBeFocused();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect.poll(() => sent().some((entry) => entry.opcode === 4)).toBe(true);
  await expect(page.locator("#status")).toHaveText("已连接电脑");
  await expect(page.locator("#controls")).toBeVisible();
  await expect(page.locator("#resume")).toBeHidden();
  await expect(textarea).toHaveValue("收起后继续发送");
  await page.locator("#send-text").tap();
  await expect(textarea).toHaveValue("");
  await expect(textarea).toBeFocused();
  expect(sent().filter((entry) => entry.opcode === 3).map((entry) => entry.text)).toEqual(["收起后继续发送"]);
});

test("window blur releases held controls without disconnecting", async ({ page }) => {
  await page.locator("#tab-control").click();
  const control = page.locator('#modifiers [data-modifier="224"]');
  await control.tap();
  await expect(control).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(control).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#release")).toHaveText("释放");
  await expect.poll(() => sent().at(-1)?.opcode).toBe(4);
  await expect(page.locator("#status")).toHaveText("已连接电脑");
  await page.locator('[data-shortcut="copy"]').tap();
  await expect.poll(() => sent().at(-1)?.opcode).toBe(6);
});

test("settings and reconnect do not introduce scrolling or lose an unsent draft", async ({ page }) => {
  await page.locator("#text").fill("保留草稿");
  await page.setViewportSize({ width: 390, height: 300 });
  await page.locator("#settings-open").click();
  await expect(page.locator("#settings")).toBeVisible();
  const geometry = await page.locator("#settings").evaluate((element) => ({
    height: element.clientHeight, content: element.scrollHeight,
    top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom,
  }));
  expect(geometry.content).toBeLessThanOrEqual(geometry.height + 1);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(300);
  await page.locator("#settings-close").click();
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect(page.locator("#resume")).toBeVisible();
  await expect(page.locator("#controls")).toBeHidden();
  await page.locator("#reconnect").click();
  await expect(page.locator("#controls")).toBeVisible();
  await expect(page.locator("#text")).toHaveValue("保留草稿");
});

test("backgrounding the page still suspends control", async ({ page }) => {
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator("#resume")).toBeVisible();
  await expect(page.locator("#controls")).toBeHidden();
});

test("two simultaneous touches release independently", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "CDP is required to synthesize simultaneous native touch contacts");
  await page.locator("#tab-control").click();
  const up = page.locator('#panel-control [data-key="82"]');
  const right = page.locator('#panel-control [data-key="79"]');
  const a = await up.boundingBox();
  const b = await right.boundingBox();
  const touches = [
    { x: a.x + a.width / 2, y: a.y + a.height / 2, id: 1 },
    { x: b.x + b.width / 2, y: b.y + b.height / 2, id: 2 },
  ];
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touches });
  await expect(up).toHaveClass(/pressed/);
  await expect(right).toHaveClass(/pressed/);
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [touches[0]] });
  await expect(up).not.toHaveClass(/pressed/);
  await expect(right).toHaveClass(/pressed/);
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(right).not.toHaveClass(/pressed/);
});

test("ANSI rows retain physical staggering, modifier state and long-key proportions", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.locator("#tab-keyboard").click();
  const geometry = await page.locator("#keys-main").evaluate((keyboard) => {
    const key = (selector) => keyboard.querySelector(selector).getBoundingClientRect();
    const unit = key('[data-key="4"]').width;
    return {
      tab: key('[data-key="43"]').width / unit,
      backspace: key('[data-key="42"]').width / unit,
      enter: key('[data-key="40"]').width / unit,
      space: key('[data-key="44"]').width / unit,
      stagger: [key('[data-key="20"]').left, key('[data-key="4"]').left, key('[data-key="29"]').left],
    };
  });
  expect(geometry.tab).toBeCloseTo(1.5, 0);
  expect(geometry.backspace).toBeCloseTo(2, 0);
  expect(geometry.enter).toBeCloseTo(2.25, 0);
  expect(geometry.space).toBeCloseTo(6.25, 0);
  expect(geometry.stagger[0]).toBeLessThan(geometry.stagger[1]);
  expect(geometry.stagger[1]).toBeLessThan(geometry.stagger[2]);
  await page.locator('#keys-main [data-modifier="225"]').tap();
  await page.locator('#keys-main [data-key="4"]').tap();
  await expect(page.locator('#keys-main [data-modifier="225"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator("#release").tap();
  await expect(page.locator('#keys-main [data-modifier="225"]')).toHaveAttribute("aria-pressed", "false");
  await page.locator("#tab-aux").click();
  const numpad = page.locator(".numpad");
  const normal = await numpad.locator('[data-key="89"]').boundingBox();
  const zero = await numpad.locator('[data-key="98"]').boundingBox();
  const enter = await numpad.locator('[data-key="88"]').boundingBox();
  expect(zero.width).toBeGreaterThan(normal.width * 1.9);
  expect(enter.height).toBeGreaterThan(normal.height * 1.9);
});

test("portrait uses phone-sized QWERTY keys below the touchpad with reachable symbol and function layers", async ({ page }) => {
  for (const size of [{ width: 320, height: 568 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    await page.locator("#tab-keyboard").click();
    await expect(page.locator("#keys-main")).toBeHidden();
    const keyboard = page.locator("#mobile-keyboard");
    await expect(keyboard).toBeVisible();
    const bounds = await keyboard.boundingBox();
    const pad = await page.locator("#keyboard-touchpad").boundingBox();
    const dock = await page.locator(".action-dock").boundingBox();
    expect(bounds.y).toBeGreaterThan(pad.y + pad.height);
    expect(bounds.y + bounds.height).toBeLessThan(dock.y);
    const letters = keyboard.locator('[data-mobile-layer="letters"]');
    const q = await letters.locator('[data-key="20"]').boundingBox();
    expect(q.width).toBeGreaterThanOrEqual(24);
    expect(q.height).toBeGreaterThanOrEqual(44);
    expect(await letters.locator(".mobile-row").first().locator("button").allTextContents()).toEqual(Array.from("QWERTYUIOP"));
    await keyboard.locator('[data-key-layer="symbols"]').tap();
    await expect(keyboard.locator('[data-mobile-layer="symbols"]')).toBeVisible();
    await assertFits(page);
    await keyboard.locator('[data-key-layer="functions"]').tap();
    await expect(keyboard.locator('[data-mobile-layer="functions"]')).toBeVisible();
    await assertFits(page);
    await keyboard.locator('[data-mobile-layer="functions"] [data-key-layer="letters"]').tap();
    await expect(letters).toBeVisible();
    await assertFits(page);
  }
});

test("phone keyboard layers release a held key before hiding it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#tab-keyboard").click();
  const keyboard = page.locator("#mobile-keyboard");
  const letter = keyboard.locator('[data-mobile-layer="letters"] [data-key="4"]');
  const bounds = await letter.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await expect.poll(() => sent().at(-1)?.opcode).toBe(1);
  await keyboard.locator('[data-key-layer="functions"]').press("Enter");
  await expect.poll(() => sent().at(-1)?.opcode).toBe(2);
  await page.mouse.up();
  expect(sent().slice(0, 2).map(({ opcode, keys }) => [opcode, keys])).toEqual([[1, [4]], [2, [4]]]);
  await keyboard.locator('[data-mobile-layer="functions"] [data-key="69"]').tap();
  await expect.poll(() => sent().at(-1)?.keys).toEqual([69]);
  await keyboard.locator('[data-mobile-layer="functions"] [data-key-layer="letters"]').tap();
  await keyboard.locator('[data-key-layer="symbols"]').tap();
  await keyboard.locator('[data-mobile-layer="symbols"] [data-key="30"]').tap();
  await expect.poll(() => sent().at(-1)?.keys).toEqual([30]);
  await expect(page.locator("#release")).toHaveText("释放");
});

test("rotating the keyboard releases active presses but retains explicit modifiers", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#tab-keyboard").click();
  const keyboard = page.locator("#mobile-keyboard");
  const letter = keyboard.locator('[data-mobile-layer="letters"] [data-key="4"]');
  const bounds = await letter.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await expect(letter).toHaveClass(/pressed/);
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator("#keys-main")).toBeVisible();
  await expect.poll(() => sent().at(-1)?.opcode).toBe(2);
  expect(sent().at(-1)?.keys).toEqual([4]);
  await page.mouse.up();
  await expect(page.locator("#release")).toHaveText("释放");
  await expect(page.locator("#status")).toHaveText("已连接电脑");
  await page.locator('#keys-main [data-modifier="225"]').tap();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(keyboard.locator('[data-mobile-layer="letters"] [data-modifier="225"]'))
    .toHaveAttribute("aria-pressed", "true");
  await page.locator("#release").tap();
});

test("touchpad taps, relative motion and explicit double click send real control frames", async ({ page }) => {
  await page.locator("#tab-touchpad").click();
  const pad = page.locator("#touchpad");
  await pad.tap();
  await expect.poll(() => sent().length).toBe(1);
  expect(sent()[0]).toMatchObject({ opcode: 11, mouse: 1, count: 1 });
  const bounds = await pad.boundingBox();
  await page.mouse.move(bounds.x + 40, bounds.y + 40);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 80, bounds.y + 60);
  await page.mouse.up();
  await expect.poll(() => sent().filter((entry) => entry.opcode === 7).length).toBeGreaterThan(0);
  const moves = sent().filter((entry) => entry.opcode === 7);
  expect(moves.reduce((sum, entry) => sum + entry.delta[0], 0)).toBe(60);
  expect(moves.reduce((sum, entry) => sum + entry.delta[1], 0)).toBe(30);
  await page.locator("#mouse-double").tap();
  await expect.poll(() => sent().at(-1)?.count).toBe(2);
  expect(sent().at(-1)).toMatchObject({ opcode: 11, mouse: 1, count: 2 });
  expect(await page.evaluate(() => scrollY)).toBe(0);
});

test("movement and scrolling reach the transport without waiting for a display frame", async ({ page }) => {
  await page.locator("#tab-touchpad").click();
  await page.evaluate(() => {
    window.requestAnimationFrame = () => 1;
    window.cancelAnimationFrame = () => {};
  });
  const pad = page.locator("#touchpad");
  const bounds = await pad.boundingBox();
  await page.mouse.move(bounds.x + 60, bounds.y + 60);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 80, bounds.y + 60);
  await expect.poll(() => sent().some((entry) => entry.opcode === 7)).toBe(true);
  await page.mouse.up();
  await pad.dispatchEvent("wheel", { deltaY: 12 });
  await expect.poll(() => sent().some((entry) => entry.opcode === 10)).toBe(true);
  expect(sent().find((entry) => entry.opcode === 7).delta).toEqual([30, 0]);
  expect(sent().find((entry) => entry.opcode === 10).delta).toEqual([0, 12]);
});

test("pointer motion does not rewrite keyboard controls or text counters", async ({ page }) => {
  await page.locator("#tab-touchpad").click();
  await page.evaluate(() => {
    window.pointerUiWrites = 0;
    const observer = new MutationObserver((records) => { window.pointerUiWrites += records.length; });
    observer.observe(document.querySelector("#controls"), {
      subtree: true, attributes: true, attributeFilter: ["disabled"],
    });
    observer.observe(document.querySelector("#text-count"), { childList: true });
  });
  const pad = await page.locator("#touchpad").boundingBox();
  await page.mouse.move(pad.x + 60, pad.y + 60);
  await page.mouse.down();
  for (let index = 1; index <= 5; index++) {
    await page.mouse.move(pad.x + 60 + (index % 2 ? 20 : 0), pad.y + 60);
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  await page.mouse.up();
  await expect.poll(() => sent().some((entry) => entry.opcode === 7)).toBe(true);
  expect(await page.evaluate(() => window.pointerUiWrites)).toBe(0);
});

test("long-press dragging flushes motion before releasing and cancellation does not click", async ({ page }) => {
  await page.locator("#tab-touchpad").click();
  const pad = page.locator("#touchpad");
  await pad.evaluate((element) => element.addEventListener("pointerdown", (event) => {
    element.dataset.pointer = String(event.pointerId);
  }));
  const bounds = await pad.boundingBox();
  const x = bounds.x + 70;
  const y = bounds.y + 70;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect(pad).toHaveClass(/dragging/);
  await page.mouse.move(x + 25, y + 15);
  await page.mouse.up();
  await expect.poll(() => sent().at(-1)?.opcode).toBe(9);
  expect(sent()[0]).toMatchObject({ opcode: 8, mouse: 1 });
  expect(sent().some((entry) => entry.opcode === 7)).toBe(true);
  expect(sent().at(-1)).toMatchObject({ opcode: 9, mouse: 1 });
  await page.mouse.down();
  await expect(pad).toHaveClass(/dragging/);
  await pad.dispatchEvent("pointercancel", { pointerId: Number(await pad.getAttribute("data-pointer")) });
  await expect(pad).not.toHaveClass(/dragging/);
  await expect.poll(() => sent().at(-1)?.opcode).toBe(9);
  await page.mouse.up();
  expect(sent().filter((entry) => entry.opcode === 11)).toEqual([]);
  await expect(page.locator("#release")).toHaveText("释放");
});

test("two-finger scroll and right click never become one-finger cursor jumps", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "CDP is required for native two-finger contacts");
  await page.locator("#tab-touchpad").click();
  const bounds = await page.locator("#touchpad").boundingBox();
  const points = [
    { x: bounds.x + 80, y: bounds.y + 100, id: 1 },
    { x: bounds.x + 150, y: bounds.y + 100, id: 2 },
  ];
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points });
  await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points.map((point) => ({ ...point, y: point.y - 40 })) });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [points[0]] });
  await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...points[1], x: points[1].x + 40, y: points[1].y - 60 }] });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => sent().filter((entry) => entry.opcode === 10).length).toBeGreaterThan(0);
  expect(sent().filter((entry) => entry.opcode === 10).reduce((sum, entry) => sum + entry.delta[1], 0)).toBe(40);
  expect(sent().some((entry) => entry.opcode === 7 || entry.opcode === 11)).toBe(false);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => sent().at(-1)?.opcode).toBe(11);
  expect(sent().at(-1)).toMatchObject({ mouse: 2, count: 1 });
});

test("two-finger touch-event batches scroll up and down on both touchpads", async ({ page }) => {
  for (const [mode, id] of [["touchpad", "touchpad"], ["keyboard", "keyboard-touchpad"]]) {
    await page.locator(`#tab-${mode}`).click();
    const before = sent().length;
    await page.locator(`#${id}`).evaluate(async (element) => {
      const bounds = element.getBoundingClientRect();
      const contacts = (offset) => [1, 2].map((identifier) => ({
        identifier, target: element,
        clientX: bounds.left + 50 + identifier * 35, clientY: bounds.top + 80 + offset,
      }));
      const dispatch = (type, touches, changedTouches = touches) => {
        // Mobile WebKit does not expose a constructible Touch; provide the same contact snapshots.
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          touches: { value: touches }, targetTouches: { value: touches }, changedTouches: { value: changedTouches },
        });
        element.dispatchEvent(event);
      };
      dispatch("touchstart", contacts(0));
      dispatch("touchmove", contacts(-40));
      await new Promise(requestAnimationFrame);
      dispatch("touchmove", contacts(-10));
      await new Promise(requestAnimationFrame);
      dispatch("touchend", [], contacts(-10));
    });
    await expect.poll(() => sent().slice(before).filter((entry) => entry.opcode === 10)
      .reduce((sum, entry) => sum + entry.delta[1], 0)).toBe(10);
    const commands = sent().slice(before);
    expect(commands.every((entry) => entry.opcode === 10)).toBe(true);
    expect(commands.some((entry) => entry.delta[1] > 0)).toBe(true);
    expect(commands.some((entry) => entry.delta[1] < 0)).toBe(true);
    expect(await page.evaluate(() => scrollY)).toBe(0);
  }
});

test("touchpad wheel gestures scroll without highlighting the pressed surface", async ({ page }) => {
  await page.locator("#tab-touchpad").click();
  const pad = page.locator("#touchpad");
  const appearance = () => pad.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.backgroundColor, style.backgroundImage, style.borderColor, style.boxShadow,
      getComputedStyle(element, "::after").opacity];
  });
  const initial = await appearance();
  const bounds = await pad.boundingBox();
  await page.mouse.move(bounds.x + 80, bounds.y + 80);
  await page.mouse.down();
  expect(await appearance()).toEqual(initial);
  await expect(pad).toHaveClass(/dragging/);
  expect(await appearance()).toEqual(initial);
  await page.mouse.up();
  await pad.dispatchEvent("wheel", { deltaY: 120, deltaMode: 0 });
  await expect.poll(() => sent().filter((entry) => entry.opcode === 10)
    .reduce((sum, entry) => sum + entry.delta[1], 0)).toBe(120);
  await pad.dispatchEvent("wheel", { deltaY: -80, deltaMode: 0 });
  await expect.poll(() => sent().filter((entry) => entry.opcode === 10)
    .reduce((sum, entry) => sum + entry.delta[1], 0)).toBe(40);
  await pad.dispatchEvent("wheel", { deltaY: 3, deltaMode: 1 });
  await expect.poll(() => sent().filter((entry) => entry.opcode === 10)
    .reduce((sum, entry) => sum + entry.delta[1], 0)).toBe(88);
  expect(await appearance()).toEqual(initial);
  expect(await page.evaluate(() => scrollY)).toBe(0);
});

test("the keyboard touchpad works and changing tabs releases an active drag", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#tab-keyboard").click();
  const pad = page.locator("#keyboard-touchpad");
  await pad.tap();
  await expect.poll(() => sent().at(-1)?.opcode).toBe(11);
  const bounds = await pad.boundingBox();
  await page.mouse.move(bounds.x + 50, bounds.y + 50);
  await page.mouse.down();
  await expect(pad).toHaveClass(/dragging/);
  await page.locator("#tab-touchpad").press("Enter");
  await expect.poll(() => sent().at(-1)?.opcode).toBe(9);
  await page.mouse.up();
  expect(sent().map((entry) => entry.opcode)).toEqual([11, 8, 9]);
  await expect(page.locator("#release")).toHaveText("释放");
});

test("separate mouse buttons flush the other finger's final motion before releasing", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "CDP is required for independent button and touchpad contacts");
  await page.locator("#tab-touchpad").click();
  const button = await page.locator('#panel-touchpad [data-mouse="1"]').boundingBox();
  const pad = await page.locator("#touchpad").boundingBox();
  const first = { x: button.x + button.width / 2, y: button.y + button.height / 2, id: 1 };
  const second = { x: pad.x + 80, y: pad.y + 80, id: 2 };
  // Stalled rendering must not delay motion or reorder the button boundary.
  await page.evaluate(() => {
    window.requestAnimationFrame = () => 1;
    window.cancelAnimationFrame = () => {};
  });
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [first] });
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [first, second] });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchMove", touchPoints: [first, { ...second, x: second.x + 20, y: second.y + 10 }],
  });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => sent().at(-1)?.opcode).toBe(9);
  expect(sent().map((entry) => entry.opcode)).toEqual([8, 7, 9]);
  expect(sent()[1].delta).toEqual([30, 15]);
  await expect(page.locator("#release")).toHaveText("释放");
});

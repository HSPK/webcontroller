import { Controller } from "./transport.mjs";
import { MAX_TEXT_BYTES, textBytes } from "./protocol.mjs";
import { Touchpad } from "./touchpad.mjs";

const $ = (id) => document.getElementById(id);
const controller = new Controller();
const pointers = new Map();
const held = new Set();
const mouseHeld = new Set();
const mousePointers = new Map();
const touchpads = [];
let platform = "macos";
let composing = false;
let submitting = false;
let token = null;
let storageAvailable = true;
let lastLatencyUpdate = -Infinity;
let lastRtt = null;
let jitter = 0;

function syncViewport() {
  const viewport = window.visualViewport;
  const height = viewport ? viewport.height : window.innerHeight;
  $("app").style.setProperty("--viewport-height", `${height}px`);
  $("app").style.setProperty("--viewport-top", `${viewport?.offsetTop || 0}px`);
  $("app").dataset.compact = String(height < 520);
  $("app").dataset.tight = String(height < 330);
}
window.visualViewport?.addEventListener("resize", syncViewport);
window.visualViewport?.addEventListener("scroll", syncViewport);
window.addEventListener("resize", syncViewport);
syncViewport();

function notice(message = "") {
  $("notice-text").textContent = message;
  $("notice").hidden = !message;
}
$("notice-close").addEventListener("click", () => notice());

function loadToken() {
  try {
    return sessionStorage.getItem("nearby-token");
  } catch {
    storageAvailable = false;
    notice("浏览器禁止会话存储，刷新会失去配对。当前页面仍可使用。");
    return null;
  }
}

function saveToken(value) {
  token = value;
  try {
    if (value) sessionStorage.setItem("nearby-token", value);
    else sessionStorage.removeItem("nearby-token");
  } catch {
    storageAvailable = false;
    notice("无法保存配对凭证；刷新页面会丢失配对。当前连接仍可使用。");
  }
}

function report(error) {
  notice(error.message || String(error));
}

function signal(state, label) {
  const dot = $("status-dot");
  if (dot.dataset.state !== state) dot.dataset.state = state;
  if (dot.title !== label) {
    dot.title = label;
    dot.setAttribute("aria-label", label);
  }
}

function execute(kind, value) {
  return controller.send(kind, value).catch(report);
}

function updateActions() {
  const bytes = textBytes($("text").value);
  $("text-count").textContent = `${bytes} / ${MAX_TEXT_BYTES} B`;
  $("text-count").hidden = bytes <= MAX_TEXT_BYTES;
  $("text").classList.toggle("over-limit", bytes > MAX_TEXT_BYTES);
  const unavailable = !controller.ready || submitting || composing;
  for (const id of ["send-text", "send-enter"]) {
    $(id).disabled = unavailable || held.size > 0 || mouseHeld.size > 0 || bytes === 0 || bytes > MAX_TEXT_BYTES;
  }
  document.querySelectorAll("[data-key], [data-key-layer], [data-shortcut], [data-modifier], [data-mouse], [data-mouse-click]").forEach((button) => {
    button.disabled = unavailable;
  });
  $("release").disabled = !controller.ready;
  document.querySelectorAll("[data-mode]").forEach((button) => { button.disabled = !controller.ready; });
  const count = held.size + mouseHeld.size;
  $("release").textContent = count ? `释放 · ${count}` : "释放";
  $("release").classList.toggle("holding", count > 0);
  document.querySelectorAll(".touchpad").forEach((pad) => pad.setAttribute("aria-disabled", String(unavailable)));
}

function clearHeld() {
  touchpads.forEach((pad) => pad.cancel(false));
  pointers.clear();
  held.clear();
  mouseHeld.clear();
  mousePointers.clear();
  document.querySelectorAll(".pressed").forEach((button) => {
    button.classList.remove("pressed");
    if (button.hasAttribute("aria-pressed")) button.setAttribute("aria-pressed", "false");
  });
  updateActions();
}

function releasePointers() {
  touchpads.forEach((pad) => pad.cancel(true));
  for (const { mouse, button } of mousePointers.values()) {
    mouseHeld.delete(mouse);
    button.classList.remove("pressed");
    if (controller.ready) execute("mouse-up", mouse);
  }
  mousePointers.clear();
  for (const { key, button } of pointers.values()) {
    held.delete(key);
    button.classList.remove("pressed");
    if (controller.ready) execute("up", key);
  }
  pointers.clear();
  updateActions();
}

function activateTab(button, selector, show) {
  const tabs = [...document.querySelectorAll(selector)];
  tabs.forEach((tab) => {
    const active = tab === button;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  show();
}

function bindTabKeys(selector) {
  document.querySelectorAll(selector).forEach((tab) => {
    tab.addEventListener("keydown", (event) => {
      const tabs = [...document.querySelectorAll(selector)];
      const index = tabs.indexOf(tab);
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      tabs[next].click();
      tabs[next].focus();
    });
  });
}

document.querySelectorAll("[data-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    releasePointers();
    if (button.dataset.mode !== "input") $("text").blur();
    activateTab(button, "[data-mode]", () => {
      document.querySelectorAll("[data-panel]").forEach((panel) => {
        panel.hidden = panel.dataset.panel !== button.dataset.mode;
      });
    });
    if (button.dataset.mode === "input" && controller.ready) {
      $("text").focus({ preventScroll: true });
    }
  });
});
bindTabKeys("[data-mode]");

controller.addEventListener("state", ({ detail }) => {
  const connected = detail.connected;
  $("controls").hidden = !connected;
  $("pairing").hidden = !!token;
  $("resume").hidden = !token || connected || !!detail.connecting;
  $("forget").hidden = !token;
  lastRtt = null;
  jitter = 0;
  signal(connected || detail.connecting ? "connecting" : token ? "offline" : "idle",
    connected ? "连接中，等待输入确认" : detail.connecting ? "连接中" : token ? "连接已断开" : "等待配对");
  $("status").textContent = connected ? "已连接电脑" : detail.connecting ? "正在连接…" : token ? "控制已暂停" : "等待配对";
  $("connection-detail").textContent = connected
    ? `${detail.dry_run ? "演示模式" : detail.transport === "direct" ? "局域网直连" : "服务器中继"} · ${detail.platform}`
    : "同一 Wi-Fi · 电脑控制器";
  if (connected) {
    if (detail.platform === "macos" || detail.platform === "windows") platform = detail.platform;
    if (storageAvailable) notice();
  } else {
    clearHeld();
    $("latency").textContent = "—";
    if (detail.reason && token) {
      $("settings").close();
      notice(detail.reason);
    }
  }
  updateActions();
});
controller.addEventListener("latency", ({ detail }) => {
  if (lastRtt !== null) jitter = jitter * 0.8 + Math.abs(detail - lastRtt) * 0.2;
  lastRtt = detail;
  const now = performance.now();
  if (now - lastLatencyUpdate >= 250 || $("latency").textContent === "—") {
    lastLatencyUpdate = now;
    if ($("latency").textContent !== String(detail)) $("latency").textContent = detail;
    const state = detail > 250 ? "poor" : detail > 80 || jitter > 30 ? "unstable" : "stable";
    const label = { stable: "连接稳定", unstable: "连接波动", poor: "连接较差" }[state];
    signal(state, `${label} · RTT ${detail} ms`);
  }
});

async function pair(ticket) {
  $("pair-button").disabled = true;
  notice();
  try {
    const response = await fetch("/api/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket }),
    });
    if (!response.ok) throw new Error(`配对失败：${await response.text()}`);
    const result = await response.json();
    if (typeof result.token !== "string" || result.token.length !== 64) throw new Error("无效的配对响应");
    saveToken(result.token);
    $("pair-link").value = "";
    controller.connect(token);
  } catch (error) {
    report(error);
  } finally {
    $("pair-button").disabled = false;
  }
}

$("pair-button").addEventListener("click", () => {
  try {
    const value = $("pair-link").value.trim();
    if (/^[a-f0-9]{64}$/.test(value)) {
      pair(value);
      return;
    }
    const link = new URL(value);
    if (link.origin !== location.origin) {
      notice("配对链接属于另一地址。请直接在浏览器打开该链接，避免把凭证发给错误电脑。");
      return;
    }
    const ticket = new URLSearchParams(link.hash.slice(1)).get("pair");
    if (!ticket) throw new Error("链接中没有配对凭证");
    pair(ticket);
  } catch (error) {
    report(new Error(`请输入有效的完整配对链接：${error.message}`));
  }
});

function preserveInputFocus(button) {
  const preventFocusChange = (event) => {
    if (document.activeElement === $("text")) event.preventDefault();
  };
  button.addEventListener("pointerdown", preventFocusChange);
  button.addEventListener("mousedown", preventFocusChange);
}

function bindKey(button) {
  const key = Number(button.dataset.key);
  button.addEventListener("contextmenu", (event) => event.preventDefault());
  button.addEventListener("pointerdown", (event) => {
    if (!controller.ready || button.disabled || event.button !== 0 || held.has(key)) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { key, button });
    held.add(key);
    button.classList.add("pressed");
    execute("down", key);
    updateActions();
  });
  const release = (event) => {
    const pointer = pointers.get(event.pointerId);
    if (!pointer) return;
    pointers.delete(event.pointerId);
    held.delete(pointer.key);
    pointer.button.classList.remove("pressed");
    if (controller.ready) execute("up", pointer.key);
    updateActions();
  };
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) {
    button.addEventListener(event, release);
  }
  button.addEventListener("click", (event) => {
    if (event.detail === 0 && controller.ready && !button.disabled) {
      execute("down", key);
      execute("up", key);
    }
  });
}

function bindModifier(button) {
  const key = Number(button.dataset.modifier);
  button.setAttribute("aria-pressed", "false");
  button.addEventListener("click", () => {
    if (!controller.ready) return;
    const down = !held.has(key);
    if (down) held.add(key);
    else held.delete(key);
    document.querySelectorAll(`[data-modifier="${key}"]`).forEach((target) => {
      target.classList.toggle("pressed", down);
      target.setAttribute("aria-pressed", String(down));
    });
    execute(down ? "down" : "up", key);
    $("input-result").textContent = held.size ? "修饰键已保持，发送文本前请点「释放」" : "手机键盘回车 = 草稿换行";
    updateActions();
  });
}
for (const [label, key] of [["Ctrl", 224], ["Shift", 225], ["Alt / ⌥", 226], ["Win / ⌘", 227]]) {
  const button = document.createElement("button");
  button.textContent = label;
  button.dataset.modifier = String(key);
  $("modifiers").append(button);
}

function keyButton([label, key, units = 1, shifted]) {
  const button = document.createElement("button");
  if (shifted) {
    const upper = document.createElement("small");
    upper.textContent = shifted;
    button.append(upper);
  }
  const legend = document.createElement("span");
  legend.textContent = label;
  button.append(legend);
  button.setAttribute("aria-label", label);
  button.dataset[key >= 224 ? "modifier" : "key"] = String(key);
  button.dataset.units = String(units);
  button.style.gridColumn = `span ${units * 4}`;
  return button;
}
const letters = (row) => Array.from(row, (label) => [label, label.charCodeAt(0) - 65 + 4]);
const functionRow = [["Esc", 41], [null, 0, 1]];
for (let index = 0; index < 12; index++) {
  functionRow.push([`F${index + 1}`, 58 + index]);
  if (index === 3 || index === 7) functionRow.push([null, 0, 0.5]);
}
const mainRows = [
  functionRow,
  [["`", 53, 1, "~"], ...Array.from("1234567890", (label, index) => [label, 30 + index, 1, "!@#$%^&*()"[index]]), ["-", 45, 1, "_"], ["=", 46, 1, "+"], ["⌫", 42, 2]],
  [["Tab", 43, 1.5], ...letters("QWERTYUIOP"), ["[", 47, 1, "{"], ["]", 48, 1, "}"], ["\\", 49, 1.5, "|"]],
  [["Caps", 57, 1.75], ...letters("ASDFGHJKL"), [";", 51, 1, ":"], ["'", 52, 1, '"'], ["Enter ↵", 40, 2.25]],
  [["Shift", 225, 2.25], ...letters("ZXCVBNM"), [",", 54, 1, "<"], [".", 55, 1, ">"], ["/", 56, 1, "?"], ["Shift", 229, 2.75]],
  [["Ctrl", 224, 1.25], ["Win/⌘", 227, 1.25], ["Alt", 226, 1.25], ["Space", 44, 6.25], ["Alt", 230, 1.25], ["Win/⌘", 231, 1.25], ["Menu", 101, 1.25], ["Ctrl", 228, 1.25]],
];
for (const name of ["main", "aux"]) {
  const page = document.createElement("div");
  page.id = `keys-${name}`;
  page.dataset.page = name;
  page.className = "keyboard-page";
  page.setAttribute("role", "group");
  page.setAttribute("aria-label", name === "main" ? "主键盘" : "导航和数字键盘");
  if (name === "main") {
    for (const keys of mainRows) {
      const row = document.createElement("div");
      row.className = "physical-row";
      keys.forEach((key) => {
        if (key[0] !== null) row.append(keyButton(key));
        else {
          const spacer = document.createElement("span");
          spacer.style.gridColumn = `span ${key[2] * 4}`;
          row.append(spacer);
        }
      });
      page.append(row);
    }
  } else {
    const navigation = document.createElement("div");
    navigation.className = "navigation-cluster";
    for (const [label, key, column, row] of [
      ["Ins", 73, 1, 1], ["Home", 74, 2, 1], ["PgUp", 75, 3, 1],
      ["Del", 76, 1, 2], ["End", 77, 2, 2], ["PgDn", 78, 3, 2],
      ["↑", 82, 2, 4], ["←", 80, 1, 5], ["↓", 81, 2, 5], ["→", 79, 3, 5],
    ]) {
      const button = keyButton([label, key]);
      button.style.gridColumn = String(column);
      button.style.gridRow = String(row);
      navigation.append(button);
    }
    const numpad = document.createElement("div");
    numpad.className = "numpad";
    for (const [label, key, column, row] of [
      ["Num", 83, "1", "1"], ["/", 84, "2", "1"], ["*", 85, "3", "1"], ["−", 86, "4", "1"],
      ["7", 95, "1", "2"], ["8", 96, "2", "2"], ["9", 97, "3", "2"], ["+", 87, "4", "2 / span 2"],
      ["4", 92, "1", "3"], ["5", 93, "2", "3"], ["6", 94, "3", "3"],
      ["1", 89, "1", "4"], ["2", 90, "2", "4"], ["3", 91, "3", "4"], ["Enter", 88, "4", "4 / span 2"],
      ["0", 98, "1 / span 2", "5"], [".", 99, "3", "5"],
    ]) {
      const button = keyButton([label, key]);
      button.style.gridColumn = column;
      button.style.gridRow = row;
      numpad.append(button);
    }
    page.append(navigation, numpad);
  }
  $(name === "main" ? "full-keyboard" : "aux-keyboard").append(page);
}

const mobileKeyboard = document.createElement("div");
mobileKeyboard.id = "mobile-keyboard";
mobileKeyboard.dataset.layer = "letters";
mobileKeyboard.setAttribute("role", "group");
mobileKeyboard.setAttribute("aria-label", "手机键盘");

function mobileRow(keys) {
  const row = document.createElement("div");
  row.className = "mobile-row";
  for (const [label, key, units = 1, shifted] of keys) {
    let element;
    if (label === null) element = document.createElement("span");
    else if (typeof key === "string") {
      element = document.createElement("button");
      element.textContent = label;
      element.dataset.keyLayer = key;
      if (key === "functions") element.setAttribute("aria-pressed", "false");
    } else {
      element = keyButton([label, key, units, shifted]);
      if (label === "⇧") element.setAttribute("aria-label", "Shift");
    }
    element.style.gridColumn = `span ${units * 4}`;
    row.append(element);
  }
  return row;
}

const mobileTools = mobileRow([
  ["Esc", 41, 1.5], ["Tab", 43, 1.5], ["Ctrl", 224, 1.75],
  ["Alt", 226, 1.5], ["Win/⌘", 227, 2], ["Fn", "functions", 1.75],
]);
mobileTools.classList.add("mobile-tools");
mobileKeyboard.append(mobileTools);
const mobileBottom = (label, layer) => [
  [label, layer, 1.5], [",", 54], ["空格", 44, 4], [".", 55], ["回车", 40, 2.5],
];
const mobileFunctions = (offset) => Array.from({ length: 6 }, (_, index) => [
  `F${offset + index + 1}`, 58 + offset + index, index === 0 || index === 5 ? 1.5 : 1.75,
]);
for (const [layer, label, rows] of [
  ["letters", "字母键盘", [
    letters("QWERTYUIOP"),
    [[null, 0, 0.5], ...letters("ASDFGHJKL"), [null, 0, 0.5]],
    [["⇧", 225, 1.5], ...letters("ZXCVBNM"), ["⌫", 42, 1.5]],
    mobileBottom("123", "symbols"),
  ]],
  ["symbols", "数字和符号", [
    Array.from("1234567890", (label, index) => [label, 30 + index, 1, "!@#$%^&*()"[index]]),
    [["-", 45, 1, "_"], ["=", 46, 1, "+"], ["[", 47, 1, "{"], ["]", 48, 1, "}"], ["\\", 49, 1, "|"],
      [";", 51, 1, ":"], ["'", 52, 1, '"'], ["`", 53, 1, "~"], [",", 54, 1, "<"], [".", 55, 1, ">"]],
    [["⇧", 225, 1.5], ["Caps", 57, 1.5], ["/", 56, 1.5, "?"], ["←", 80, 1.5], ["→", 79, 1.5], ["⌫", 42, 2.5]],
    mobileBottom("ABC", "letters"),
  ]],
  ["functions", "功能和导航键", [
    mobileFunctions(0),
    mobileFunctions(6),
    [["Ins", 73, 1.5], ["Home", 74, 1.75], ["PgUp", 75, 1.75], ["PgDn", 78, 1.75], ["End", 77, 1.75], ["Del", 76, 1.5]],
    [["ABC", "letters", 1.5], ["←", 80, 1.5], ["↑", 82, 1.5], ["↓", 81, 1.5], ["→", 79, 1.5], ["回车", 40, 2.5]],
  ]],
]) {
  const page = document.createElement("div");
  page.className = "mobile-key-page";
  page.dataset.mobileLayer = layer;
  page.setAttribute("role", "group");
  page.setAttribute("aria-label", label);
  page.hidden = layer !== "letters";
  for (const keys of rows) page.append(mobileRow(keys));
  mobileKeyboard.append(page);
}
$("full-keyboard").append(mobileKeyboard);
mobileKeyboard.querySelectorAll("[data-key-layer]").forEach((button) => {
  button.addEventListener("click", () => {
    releasePointers();
    const target = button.dataset.keyLayer;
    const layer = target === "functions" && mobileKeyboard.dataset.layer === target ? "letters" : target;
    mobileKeyboard.dataset.layer = layer;
    mobileKeyboard.querySelectorAll("[data-mobile-layer]").forEach((page) => {
      page.hidden = page.dataset.mobileLayer !== layer;
    });
    mobileTools.querySelector('[data-key-layer="functions"]').setAttribute("aria-pressed", String(layer === "functions"));
  });
});
document.querySelectorAll("[data-key]").forEach(bindKey);
document.querySelectorAll("[data-modifier]").forEach(bindModifier);
document.querySelectorAll("[data-shortcut]").forEach((button) => {
  button.addEventListener("click", () => {
    if (held.size || mouseHeld.size) {
      notice("请先释放所有按键，再使用快捷键。");
      return;
    }
    const target = $("platform").value === "auto" ? platform : $("platform").value;
    const modifier = target === "macos" ? 227 : 224;
    const kind = button.dataset.shortcut;
    const key = { copy: 6, paste: 25, undo: 29, select: 4, redo: target === "macos" ? 29 : 28 }[kind];
    execute("chord", kind === "redo" && target === "macos" ? [modifier, 225, key] : [modifier, key]);
  });
});

async function submitText(withEnter) {
  if (submitting || composing || !controller.ready || held.size || mouseHeld.size) return;
  const text = $("text").value;
  if (!text || textBytes(text) > MAX_TEXT_BYTES) return;
  $("text").focus({ preventScroll: true });
  submitting = true;
  notice();
  $("input-result").textContent = "正在发送…";
  updateActions();
  let textSent = false;
  try {
    await controller.send("text", text);
    textSent = true;
    if ($("text").value === text) $("text").value = "";
    if (withEnter) await controller.send("chord", [40]);
    $("input-result").textContent = withEnter ? "已发送文本并回车" : "已发送文本";
  } catch (error) {
    $("input-result").textContent = textSent ? "文本已发送，回车结果不确定" : "发送未确认，请检查电脑";
    report(new Error(textSent ? `文本已发送，回车失败或结果不确定；未自动重试。${error.message}` : error.message));
  } finally {
    submitting = false;
    updateActions();
  }
}

$("release").addEventListener("click", () => {
  touchpads.forEach((pad) => pad.cancel(true));
  clearHeld();
  $("input-result").textContent = "已请求释放所有按键";
  execute("release");
});

function sendPointer(kind, value) {
  if (kind === "mouse-down" || kind === "mouse-up" || kind === "click") {
    touchpads.forEach((pad) => pad.flush());
  }
  if (kind === "mouse-down" || kind === "mouse-up") {
    if (kind === "mouse-down") mouseHeld.add(value);
    else mouseHeld.delete(value);
    document.querySelectorAll("[data-mouse]").forEach((button) => {
      button.classList.toggle("pressed", mouseHeld.has(Number(button.dataset.mouse)));
    });
    updateActions();
  }
  return controller.send(kind, value);
}
for (const id of ["touchpad", "keyboard-touchpad"]) {
  touchpads.push(new Touchpad($(id), {
    send: sendPointer,
    enabled: () => controller.ready && !submitting && !composing,
    held: () => mouseHeld.size > 0,
    error: (error) => { controller.suspend(); report(error); },
  }));
}
window.matchMedia("(orientation: landscape) and (min-width: 600px)")
  .addEventListener("change", releasePointers);
document.querySelectorAll("[data-mouse]").forEach((button) => {
  const mouse = Number(button.dataset.mouse);
  button.addEventListener("contextmenu", (event) => event.preventDefault());
  button.addEventListener("pointerdown", (event) => {
    if (!controller.ready || button.disabled || event.button !== 0 || mouseHeld.has(mouse)) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    mousePointers.set(event.pointerId, { mouse, button });
    sendPointer("mouse-down", mouse).catch(report);
  });
  const release = (event) => {
    if (!mousePointers.delete(event.pointerId)) return;
    if (controller.ready) sendPointer("mouse-up", mouse).catch(report);
  };
  for (const kind of ["pointerup", "pointercancel", "lostpointercapture"]) button.addEventListener(kind, release);
  button.addEventListener("click", (event) => {
    if (event.detail === 0 && !button.disabled && !mouseHeld.size) sendPointer("click", [mouse, 1]).catch(report);
  });
});
$("mouse-double").addEventListener("click", () => {
  if (!mouseHeld.size) sendPointer("click", [1, 2]).catch(report);
});
$("text").addEventListener("compositionstart", () => {
  releasePointers();
  composing = true;
  updateActions();
});
$("text").addEventListener("compositionend", () => { composing = false; updateActions(); });
$("text").addEventListener("input", updateActions);
$("send-text").addEventListener("click", () => submitText(false));
$("send-enter").addEventListener("click", () => submitText(true));
$("hide-keyboard").addEventListener("click", () => $("text").blur());
document.querySelectorAll(".action-dock button, .send-actions button, #release, #notice-close").forEach(preserveInputFocus);
$("settings-open").addEventListener("click", () => {
  $("text").blur();
  releasePointers();
  $("settings").showModal();
});
$("settings-close").addEventListener("click", () => $("settings").close());
$("reconnect").addEventListener("click", () => {
  if (token) controller.connect(token);
});
$("forget").addEventListener("click", () => {
  $("settings").close();
  saveToken(null);
  controller.suspend();
  $("pairing").hidden = false;
  $("resume").hidden = true;
  notice("已清除此页面凭证。要撤销所有已复制凭证，请在电脑端重启服务并重新配对。");
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) controller.suspend();
});
window.addEventListener("pagehide", () => controller.suspend());
window.addEventListener("blur", () => {
  clearHeld();
  if (controller.ready) execute("release");
});

token = loadToken();
const ticket = new URLSearchParams(location.hash.slice(1)).get("pair");
if (location.hash) history.replaceState(null, "", location.pathname + location.search);
if (ticket) pair(ticket);
else if (token) controller.connect(token);
updateActions();

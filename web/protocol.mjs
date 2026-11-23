export const MAX_TEXT_BYTES = 16 * 1024;
export const OPCODE = Object.freeze({
  down: 1, up: 2, text: 3, release: 4, heartbeat: 5, chord: 6,
  move: 7, "mouse-down": 8, "mouse-up": 9, scroll: 10, click: 11,
});
const encoder = new TextEncoder();

export function supportedKey(key) {
  return Number.isInteger(key) && (
    (key >= 0x04 && key <= 0x45) || (key >= 0x49 && key <= 0x63)
    || key === 0x65 || (key >= 0xe0 && key <= 0xe7)
  );
}

export function encodeFrame(sequence, kind, value) {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 0xffffffff) {
    throw new Error("消息序号已耗尽，请重新连接");
  }
  const opcode = OPCODE[kind];
  if (!opcode) throw new Error("不支持的输入命令");
  let payload = new Uint8Array();
  if (kind === "down" || kind === "up") {
    if (!supportedKey(value)) throw new Error("不支持的按键");
    payload = new Uint8Array(2);
    new DataView(payload.buffer).setUint16(0, value, true);
  } else if (kind === "text") {
    if (typeof value !== "string" || !value || value.includes("\0")) throw new Error("文本为空或包含 NUL");
    payload = encoder.encode(value);
    if (payload.length > MAX_TEXT_BYTES) throw new Error("单次文本不能超过 16384 字节");
  } else if (kind === "chord") {
    if (!Array.isArray(value) || value.length < 1 || value.length > 8
        || new Set(value).size !== value.length || !value.every(supportedKey)) {
      throw new Error("无效的组合键");
    }
    payload = new Uint8Array(value.length * 2);
    const view = new DataView(payload.buffer);
    value.forEach((key, index) => view.setUint16(index * 2, key, true));
  } else if (kind === "move" || kind === "scroll") {
    if (!Array.isArray(value) || value.length !== 2
        || !value.every((delta) => Number.isInteger(delta) && Math.abs(delta) <= 4096)) {
      throw new Error("无效的鼠标位移");
    }
    payload = new Uint8Array(4);
    const view = new DataView(payload.buffer);
    value.forEach((delta, index) => view.setInt16(index * 2, delta, true));
  } else if (kind === "mouse-down" || kind === "mouse-up") {
    if (![1, 2, 3].includes(value)) throw new Error("无效的鼠标按键");
    payload = new Uint8Array([value]);
  } else if (kind === "click") {
    if (!Array.isArray(value) || value.length !== 2 || ![1, 2, 3].includes(value[0]) || ![1, 2].includes(value[1])) {
      throw new Error("无效的鼠标点击");
    }
    payload = new Uint8Array(value);
  }
  const frame = new Uint8Array(6 + payload.length);
  frame[0] = 1;
  frame[1] = opcode;
  new DataView(frame.buffer).setUint32(2, sequence, true);
  frame.set(payload, 6);
  return frame;
}

export function textBytes(text) {
  return encoder.encode(text).length;
}

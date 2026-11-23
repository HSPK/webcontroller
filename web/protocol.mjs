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
  let payloadLength = 0;
  let text;
  if (kind === "down" || kind === "up") {
    if (!supportedKey(value)) throw new Error("不支持的按键");
    payloadLength = 2;
  } else if (kind === "text") {
    if (typeof value !== "string" || !value || value.includes("\0")) throw new Error("文本为空或包含 NUL");
    text = encoder.encode(value);
    if (text.length > MAX_TEXT_BYTES) throw new Error("单次文本不能超过 16384 字节");
    payloadLength = text.length;
  } else if (kind === "chord") {
    if (!Array.isArray(value) || value.length < 1 || value.length > 8
        || new Set(value).size !== value.length || !value.every(supportedKey)) {
      throw new Error("无效的组合键");
    }
    payloadLength = value.length * 2;
  } else if (kind === "move" || kind === "scroll") {
    if (!Array.isArray(value) || value.length !== 2
        || !value.every((delta) => Number.isInteger(delta) && Math.abs(delta) <= 4096)) {
      throw new Error("无效的鼠标位移");
    }
    payloadLength = 4;
  } else if (kind === "mouse-down" || kind === "mouse-up") {
    if (![1, 2, 3].includes(value)) throw new Error("无效的鼠标按键");
    payloadLength = 1;
  } else if (kind === "click") {
    if (!Array.isArray(value) || value.length !== 2 || ![1, 2, 3].includes(value[0]) || ![1, 2].includes(value[1])) {
      throw new Error("无效的鼠标点击");
    }
    payloadLength = 2;
  }
  const frame = new Uint8Array(6 + payloadLength);
  const view = new DataView(frame.buffer);
  frame[0] = 1;
  frame[1] = opcode;
  view.setUint32(2, sequence, true);
  if (kind === "down" || kind === "up") view.setUint16(6, value, true);
  else if (kind === "text") frame.set(text, 6);
  else if (kind === "chord") value.forEach((key, index) => view.setUint16(6 + index * 2, key, true));
  else if (kind === "move" || kind === "scroll") {
    view.setInt16(6, value[0], true);
    view.setInt16(8, value[1], true);
  } else if (kind === "mouse-down" || kind === "mouse-up") frame[6] = value;
  else if (kind === "click") {
    frame[6] = value[0];
    frame[7] = value[1];
  }
  return frame;
}

export function textBytes(text) {
  return encoder.encode(text).length;
}

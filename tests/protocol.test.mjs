import test from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, MAX_TEXT_BYTES, textBytes } from "../web/protocol.mjs";

test("binary key messages match Rust's little-endian wire format", () => {
  assert.deepEqual([...encodeFrame(0x12345678, "down", 0xe3)], [1, 1, 0x78, 0x56, 0x34, 0x12, 0xe3, 0]);
  assert.deepEqual([...encodeFrame(2, "chord", [0xe3, 6])], [1, 6, 2, 0, 0, 0, 0xe3, 0, 6, 0]);
});

test("text is bounded by UTF-8 bytes, not JS string length", () => {
  const text = "你好 👋";
  assert.equal(new TextDecoder().decode(encodeFrame(1, "text", text).slice(6)), text);
  assert.equal(textBytes(text), 11);
  assert.doesNotThrow(() => encodeFrame(1, "text", "a".repeat(MAX_TEXT_BYTES)));
  assert.throws(() => encodeFrame(1, "text", "你".repeat(Math.ceil(MAX_TEXT_BYTES / 3))));
  assert.throws(() => encodeFrame(1, "text", "\0"));
});

test("invalid inputs and exhausted sequence numbers never enter the transport", () => {
  for (const sequence of [0, -1, 0x100000000, 1.5]) {
    assert.throws(() => encodeFrame(sequence, "heartbeat"));
  }
  assert.throws(() => encodeFrame(1, "down", 0xffff));
  assert.throws(() => encodeFrame(1, "chord", [4, 4]));
  assert.throws(() => encodeFrame(1, "chord", []));
  assert.throws(() => encodeFrame(1, "unknown"));
});

test("pointer deltas, mouse buttons and double clicks use bounded binary frames", () => {
  assert.deepEqual([...encodeFrame(1, "move", [-12, 300])], [1, 7, 1, 0, 0, 0, 244, 255, 44, 1]);
  assert.deepEqual([...encodeFrame(2, "mouse-down", 1)], [1, 8, 2, 0, 0, 0, 1]);
  assert.deepEqual([...encodeFrame(3, "click", [1, 2])], [1, 11, 3, 0, 0, 0, 1, 2]);
  for (const value of [[4097, 0], [0, NaN], [1.5, 0], [1]]) {
    assert.throws(() => encodeFrame(1, "move", value));
  }
  assert.throws(() => encodeFrame(1, "mouse-up", 4));
  assert.throws(() => encodeFrame(1, "click", [1, 3]));
});

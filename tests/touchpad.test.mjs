import test from "node:test";
import assert from "node:assert/strict";
import { Touchpad } from "../web/touchpad.mjs";

function setup(t) {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  globalThis.window = {};
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  t.after(() => {
    delete globalThis.window;
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  });
  const calls = [];
  const errors = [];
  const pad = new Touchpad({
    addEventListener() {},
    classList: { add() {}, remove() {} },
  }, {
    enabled: () => true,
    held: () => false,
    error: (error) => errors.push(error.message),
    send: (kind, value) => new Promise((resolve, reject) => {
      calls.push({ kind, value, time: now, resolve, reject });
    }),
  });
  return {
    pad, calls, errors,
    advance(milliseconds) {
      now += milliseconds;
      t.mock.timers.tick(milliseconds);
    },
  };
}

test("motion starts without a display frame and coalesces subsequent updates on a 4 ms cadence", (t) => {
  const { pad, calls, advance } = setup(t);
  pad.queue("move", 10, 2);
  assert.equal(calls.length, 1);
  pad.queue("move", 2, 1);
  pad.queue("move", 3, -1);
  advance(3);
  assert.equal(calls.length, 1);
  advance(1);
  assert.deepEqual(calls.map(({ value, time }) => ({ value, time })), [
    { value: [10, 2], time: 0 }, { value: [5, 0], time: 4 },
  ]);
});

test("unacknowledged motion is bounded and pending deltas resume immediately when an ACK frees capacity", async (t) => {
  const { pad, calls, advance } = setup(t);
  pad.queue("move", 1, 0);
  advance(4);
  pad.queue("move", 1, 0);
  for (let index = 0; index < 10; index++) {
    advance(4);
    pad.queue("move", 1, 0);
  }
  advance(100);
  assert.equal(calls.length, 2);
  calls[0].resolve();
  await Promise.resolve();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].value, [10, 0]);
});

test("button boundaries flush pending motion before release and split deltas within protocol bounds", (t) => {
  const { pad, calls, advance } = setup(t);
  pad.queue("move", 1, 0);
  advance(4);
  pad.queue("move", 1, 0);
  pad.queue("move", 9000, -9000);
  assert.equal(calls.length, 2);
  pad.flush();
  pad.dispatch("mouse-up", 1);
  assert.deepEqual(calls.map(({ kind }) => kind), ["move", "move", "move", "move", "move", "mouse-up"]);
  const deltas = calls.slice(0, -1).map(({ value }) => value);
  assert.deepEqual(deltas.reduce(([x, y], [dx, dy]) => [x + dx, y + dy], [0, 0]), [9002, -9000]);
  assert.ok(deltas.every((value) => value.every((delta) => Number.isInteger(delta) && Math.abs(delta) <= 4096)));
});

test("cancellation discards unsent motion and stale callbacks cannot cancel a new gesture", async (t) => {
  const { pad, calls, errors, advance } = setup(t);
  pad.queue("move", 1, 0);
  pad.queue("move", 5, 0);
  pad.cancel(false);
  advance(4);
  assert.equal(calls.length, 1);
  pad.queue("scroll", 0.5, 0);
  pad.queue("move", 2, 0);
  assert.deepEqual(calls[1].value, [2, 0]);
  calls[0].reject(new Error("old gesture"));
  await Promise.resolve();
  assert.deepEqual(errors, []);
  pad.queue("move", 2, 0);
  calls[1].reject(new Error("current failure"));
  await Promise.resolve();
  advance(8);
  assert.deepEqual(errors, ["current failure"]);
  assert.equal(calls.length, 2);
});

test("a completed tap still surfaces its send failure after the finger is lifted", async (t) => {
  const { pad, calls, errors } = setup(t);
  pad.down({ pointerId: 1, button: 0, clientX: 20, clientY: 20, preventDefault() {} }, false);
  pad.up({ pointerId: 1 });
  assert.equal(calls[0].kind, "click");
  calls[0].reject(new Error("tap failed"));
  await Promise.resolve();
  assert.deepEqual(errors, ["tap failed"]);
});

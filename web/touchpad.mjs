export class Touchpad {
  constructor(element, { send, enabled, held, error }) {
    this.element = element;
    this.send = send;
    this.enabled = enabled;
    this.held = held;
    this.error = error;
    this.points = new Map();
    this.pending = [0, 0];
    this.pendingKind = null;
    this.frame = null;
    this.timer = null;
    this.dragging = false;
    this.gesture = null;
    this.touchEvents = "ontouchstart" in window;
    element.addEventListener("contextmenu", (event) => event.preventDefault());
    for (const [type, handle] of [["pointerdown", "down"], ["pointermove", "move"], ["pointerup", "up"]]) {
      element.addEventListener(type, (event) => {
        if (!this.touchEvents || event.pointerType !== "touch") this[handle](event);
      });
    }
    if (this.touchEvents) {
      for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
        element.addEventListener(type, (event) => this.touch(event), { passive: false });
      }
    }
    element.addEventListener("wheel", (event) => {
      if (!this.enabled() || event.ctrlKey) return;
      event.preventDefault();
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      this.queue("scroll", event.deltaX * scale, event.deltaY * scale);
    }, { passive: false });
    for (const kind of ["pointercancel", "lostpointercapture"]) {
      element.addEventListener(kind, (event) => {
        if (this.points.has(event.pointerId)) this.cancel(true);
      });
    }
    element.addEventListener("keydown", (event) => {
      if (!this.enabled()) return;
      const delta = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key];
      if (delta) {
        event.preventDefault();
        this.dispatch("move", delta);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.dispatch("click", [1, 1]);
      }
    });
  }

  dispatch(kind, value) {
    if (!this.enabled()) return;
    this.send(kind, value).catch((error) => {
      this.cancel(false);
      this.error(error);
    });
  }

  center() {
    let x = 0;
    let y = 0;
    for (const point of this.points.values()) {
      x += point.x;
      y += point.y;
    }
    return {
      x: x / this.points.size,
      y: y / this.points.size,
    };
  }

  touch(event) {
    if (!this.enabled()) return;
    event.preventDefault();
    if (event.type === "touchcancel") {
      this.cancel(true);
      return;
    }
    const contact = (touch) => ({
      pointerId: `touch:${touch.identifier}`, button: 0,
      clientX: touch.clientX, clientY: touch.clientY,
      preventDefault() {},
    });
    if (event.type === "touchstart") {
      for (const touch of event.changedTouches) this.down(contact(touch), false);
      return;
    }
    if (event.type === "touchend") {
      for (const touch of event.changedTouches) this.up(contact(touch));
      return;
    }
    // Touch Events provide the complete contact set; update it atomically before measuring the centroid.
    for (const touch of event.touches) {
      const id = `touch:${touch.identifier}`;
      if (this.points.has(id)) this.points.set(id, { x: touch.clientX, y: touch.clientY });
    }
    if (this.points.size) this.moved();
  }

  down(event, capture = true) {
    if (!this.enabled() || event.button !== 0) return;
    event.preventDefault();
    if (capture) this.element.setPointerCapture(event.pointerId);
    this.points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    clearTimeout(this.timer);
    if (this.points.size === 1) {
      this.flush();
      this.gesture = { start: performance.now(), fingers: 1, distance: 0, ending: false, last: this.center(), suppressed: [0, 0] };
      this.timer = setTimeout(() => {
        if (this.points.size === 1 && this.gesture?.distance < 5 && !this.held() && this.enabled()) {
          this.dragging = true;
          this.element.classList.add("dragging");
          this.dispatch("mouse-down", 1);
        }
      }, 350);
    } else {
      this.flush();
      this.pending = [0, 0];
      this.pendingKind = null;
      if (this.dragging) {
        this.dispatch("mouse-up", 1);
        this.dragging = false;
        this.element.classList.remove("dragging");
      }
      this.gesture.fingers = Math.max(this.gesture.fingers, this.points.size);
      this.gesture.last = this.center();
      this.gesture.suppressed = [0, 0];
    }
  }

  move(event) {
    if (!this.points.has(event.pointerId) || !this.gesture) return;
    event.preventDefault();
    this.points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.moved();
  }

  moved() {
    if (!this.gesture) return;
    if (this.gesture.ending || this.gesture.fingers > 2) return;
    const center = this.center();
    let dx = center.x - this.gesture.last.x;
    let dy = center.y - this.gesture.last.y;
    this.gesture.last = center;
    this.gesture.distance += Math.hypot(dx, dy);
    if (this.gesture.distance >= 5) clearTimeout(this.timer);
    if (this.gesture.distance < 5 && !this.dragging) {
      this.gesture.suppressed[0] += dx;
      this.gesture.suppressed[1] += dy;
      return;
    }
    dx += this.gesture.suppressed[0];
    dy += this.gesture.suppressed[1];
    this.gesture.suppressed = [0, 0];
    const scroll = this.gesture.fingers === 2;
    const scale = scroll ? -1 : 1.5;
    this.queue(scroll ? "scroll" : "move", dx * scale, dy * scale);
  }

  queue(kind, x, y) {
    if (this.pendingKind && this.pendingKind !== kind) {
      this.flush();
      this.pending = [0, 0];
    }
    this.pendingKind = kind;
    this.pending[0] += x;
    this.pending[1] += y;
    if (this.frame === null) this.frame = requestAnimationFrame(() => this.flush());
  }

  flush() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    if (!this.pendingKind) return;
    // Flush motion before button boundaries so a drag's final movement is not reordered.
    while (Math.abs(this.pending[0]) >= 1 || Math.abs(this.pending[1]) >= 1) {
      const delta = this.pending.map((value) => Math.max(-4096, Math.min(4096, Math.trunc(value))));
      this.pending[0] -= delta[0];
      this.pending[1] -= delta[1];
      this.dispatch(this.pendingKind, delta);
    }
  }

  up(event) {
    if (!this.points.has(event.pointerId) || !this.gesture) return;
    clearTimeout(this.timer);
    this.flush();
    this.points.delete(event.pointerId);
    this.gesture.ending = true;
    if (this.points.size) return;
    if (this.dragging) this.dispatch("mouse-up", 1);
    else if (!this.held() && this.gesture.distance < 5 && performance.now() - this.gesture.start < 300 && this.gesture.fingers <= 2) {
      this.dispatch("click", [this.gesture.fingers === 2 ? 2 : 1, 1]);
    }
    this.cancel(false);
  }

  cancel(release) {
    clearTimeout(this.timer);
    if (release) this.flush();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    if (release && this.dragging) this.dispatch("mouse-up", 1);
    this.points.clear();
    this.gesture = null;
    this.dragging = false;
    this.frame = null;
    this.pending = [0, 0];
    this.pendingKind = null;
    this.element.classList.remove("dragging");
  }
}

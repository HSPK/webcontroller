import { encodeFrame } from "./protocol.mjs";

export class Controller extends EventTarget {
  socket = null;
  sequence = 0;
  ready = false;
  pending = new Map();
  timer = null;

  emit(kind, detail) {
    this.dispatchEvent(new CustomEvent(kind, { detail }));
  }

  connect(token) {
    this.close("正在建立新连接");
    this.emit("state", { connected: false, connecting: true });
    const url = new URL("/ws/control", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    this.socket = socket;
    this.sequence = 0;
    const timeout = setTimeout(() => {
      if (this.socket === socket && !this.ready) this.close("连接超时，请检查电脑端与网络");
    }, 4000);
    socket.addEventListener("open", () => {
      if (this.socket === socket) socket.send(JSON.stringify({ token }));
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      try {
        const message = JSON.parse(event.data);
        if (message.kind === "ready") {
          clearTimeout(timeout);
          this.ready = true;
          this.emit("state", { connected: true, ...message });
          this.timer = setInterval(() => {
            const oldest = this.pending.values().next().value;
            if (oldest && performance.now() - oldest.started >= 1000) {
              this.close("输入确认超时，结果可能不确定；未自动重试");
              return;
            }
            this.send("heartbeat").catch(() => {});
          }, 250);
          this.send("heartbeat").catch(() => {});
        } else if (message.kind === "ack") {
          const entry = this.pending.get(message.sequence);
          if (!entry || typeof message.ok !== "boolean") throw new Error("收到无效的输入确认");
          this.pending.delete(message.sequence);
          if (message.ok) {
            this.emit("latency", Math.round(performance.now() - entry.started));
            entry.resolve(message);
          } else {
            entry.reject(new Error(message.error || "电脑端输入失败"));
            this.close(message.error || "电脑端输入失败，连接已关闭");
          }
        } else if (message.kind === "error") {
          this.close(message.error || "连接被拒绝");
        } else {
          throw new Error("收到未知的服务端消息");
        }
      } catch (error) {
        this.close(error.message);
      }
    });
    socket.addEventListener("close", () => {
      clearTimeout(timeout);
      if (this.socket === socket) this.close("连接已断开，按键会由电脑端自动释放");
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      if (this.socket === socket) this.close("网络连接失败，请检查 Wi-Fi 和防火墙");
    });
  }

  send(kind, value) {
    return new Promise((resolve, reject) => {
      if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) {
        reject(new Error("尚未连接电脑"));
        return;
      }
      if (this.pending.size >= 32 || this.socket.bufferedAmount > 8192) {
        this.close("网络拥塞，已暂停控制，避免积压输入");
        reject(new Error("网络拥塞；未自动重试"));
        return;
      }
      let frame;
      try {
        frame = encodeFrame(this.sequence + 1, kind, value);
      } catch (error) {
        reject(error);
        return;
      }
      const sequence = ++this.sequence;
      this.pending.set(sequence, { resolve, reject, started: performance.now(), kind });
      try {
        this.socket.send(frame);
      } catch (error) {
        this.close(`发送失败，结果可能不确定：${error.message}`);
      }
    });
  }

  close(reason = "控制已暂停") {
    clearInterval(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close();
    for (const entry of this.pending.values()) {
      entry.reject(new Error(`${reason}；未确认输入的执行结果可能不确定`));
    }
    this.pending.clear();
    this.emit("state", { connected: false, reason });
  }

  suspend() {
    if (this.ready) this.send("release").catch(() => {});
    this.close("控制已暂停，恢复连接不会重放输入");
  }
}

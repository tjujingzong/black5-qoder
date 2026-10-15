// 网络层：HTTP 轮询模式替代 WebSocket 实时连接。

const POLL_INTERVAL = 800;
const MAX_POLL_ERRORS = 10;

async function responseError(response, fallback) {
  try {
    const data = await response.json();
    return data.error || fallback;
  } catch (e) {
    return fallback;
  }
}

export async function createRoom(name) {
  let response;
  try {
    response = await fetch("/functions/v1/app/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  } catch (e) {
    throw new Error("无法连接游戏服务器，请检查网络");
  }
  if (!response.ok) throw new Error(await responseError(response, "创建房间失败"));
  return response.json();
}

export class RoomNet {
  constructor(handlers) {
    this.h = handlers;
    this.code = null;
    this.name = null;
    this.token = null;
    this.joined = false;
    this.rejected = false;
    this.destroyed = false;
    this.pollTimer = null;
    this.lastSeq = 0;
    this.errorCount = 0;
  }

  async connect(code, name, token) {
    this.destroy();
    this.code = code;
    this.name = name;
    this.token = token;
    this.destroyed = false;
    this.joined = false;
    this.rejected = false;
    this.errorCount = 0;

    try {
      // 加入房间
      const response = await fetch(`/functions/v1/app/rooms/${code}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, token }),
      });

      if (!response.ok) {
        const error = await responseError(response, "加入房间失败");
        this.rejected = true;
        this.h.onError(error);
        this.h.onClose({ rejected: true });
        return;
      }

      const data = await response.json();
      this.token = data.token;
      // 初始化为 seq-1，确保第一次轮询（seq 未变）也能触发 onState 渲染大厅
      this.lastSeq = (data.seq || 1) - 1;
      this.joined = true;

      // 触发 welcome
      this.h.onWelcome({ id: this.token, token: this.token });

      // 开始轮询状态
      this.poll();
    } catch (e) {
      this.h.onError("无法连接游戏服务器");
      this.h.onClose({ rejected: true });
    }
  }

  async poll() {
    if (this.destroyed || !this.joined) return;

    try {
      const response = await fetch(
        `/functions/v1/app/rooms/${this.code}/state?token=${this.token}`
      );

      if (!response.ok) {
        throw new Error(await responseError(response, "获取状态失败"));
      }

      const data = await response.json();
      this.errorCount = 0;

      if (data.view && data.view.seq > this.lastSeq) {
        this.lastSeq = data.view.seq;
        this.h.onState(data.view);

        // 如果对局结束，停止轮询
        if (data.view.phase === "roundEnd" || data.view.phase === "gone") {
          // 继续轮询以便下一局
        }
      }
    } catch (e) {
      this.errorCount++;
      if (this.errorCount >= MAX_POLL_ERRORS) {
        this.h.onError("连接失败次数过多，请刷新页面");
        this.h.onClose({ rejected: false });
        this.destroy();
        return;
      }
    }

    // 继续轮询
    if (!this.destroyed) {
      this.pollTimer = setTimeout(() => this.poll(), POLL_INTERVAL);
    }
  }

  async send(message) {
    if (!this.joined || this.destroyed) return false;

    try {
      const response = await fetch(`/functions/v1/app/rooms/${this.code}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: this.token,
          action: message,
        }),
      });

      if (!response.ok) {
        const error = await responseError(response, "动作失败");
        this.h.onError(error);
        return false;
      }

      const data = await response.json();
      if (data.view) {
        this.lastSeq = data.view.seq;
        this.h.onState(data.view);
      }
      return true;
    } catch (e) {
      this.h.onError("发送失败，请检查网络");
      return false;
    }
  }

  destroy() {
    this.destroyed = true;
    this.joined = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // 语音中转：上传一个片段（{ mime, data }），成功返回 { ok, seq }
  async voiceUpload(payload) {
    if (!this.joined || this.destroyed) return null;
    try {
      const response = await fetch(`/functions/v1/app/rooms/${this.code}/voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: this.token, mime: payload.mime, data: payload.data }),
      });
      if (!response.ok) return null;
      return await response.json();
    } catch (e) {
      return null;
    }
  }

  // 语音中转：拉取自 since 游标以来的他人新片段，返回 { clips, cursor }
  async voicePoll(since) {
    if (!this.joined || this.destroyed) return null;
    try {
      const response = await fetch(
        `/functions/v1/app/rooms/${this.code}/voice?token=${this.token}&since=${since}`
      );
      if (!response.ok) return null;
      return await response.json();
    } catch (e) {
      return null;
    }
  }
}

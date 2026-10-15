// 语音聊天：服务器中转，"听"与"说"分离。
// - 听：进入房间后自动开启，持续轮询拉取他人语音片段并播放，不需要麦克风。
// - 说：点"开麦"后才打开麦克风，检测到人声自动切成小段上传；闭麦即停止发送。
// 仅用 HTTP 轮询通道，国内可用、零外部依赖；代价是约 1~2 秒延迟，非实时通话。

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  for (const m of candidates) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* ignore */ }
  }
  return '';
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function base64ToUint8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export class VoiceChat {
  constructor({ upload, poll, onState, onError }) {
    this.upload = upload || (async () => null);
    this.poll = poll || (async () => null);
    this.onState = onState;
    this.onError = onError;

    this.connected = false;    // 与游戏服务器的连接
    this.myId = null;

    // 听
    this.listening = false;
    this.audioCtx = null;
    this.pullTimer = null;
    this.cursor = 0;
    this.playQueue = [];
    this.playing = false;
    this._unlockBound = false;

    // 说
    this.speaking = false;
    this.busy = false;
    this.stream = null;
    this.recCtx = null;
    this.analyser = null;
    this.recorder = null;
    this.segmenting = false;
    this.segmentStart = 0;
    this.lastVoiceAt = 0;
    this.vadTimer = null;
    this.supportedMime = '';

    this._lastKey = '';
  }

  _emit(force = false) {
    const key = `${this.listening}|${this.speaking}|${this.busy}`;
    if (force || key !== this._lastKey) {
      this._lastKey = key;
      this.onState({ listening: this.listening, speaking: this.speaking, busy: this.busy });
    }
  }

  onConnected() {
    this.connected = true;
    this.startListening();
  }

  onDisconnected() {
    this.connected = false;
    this.stopSpeak();
    this.stopListening();
  }

  update(view) {
    if (view && view.myId) this.myId = view.myId;
  }

  handleChunk() { /* 服务器中转模式不使用 */ }

  /* ---------------- 听（自动） ---------------- */

  startListening() {
    if (this.listening || !this.connected) return;
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    this._bindUnlock(); // 首次用户手势时 resume，绕过自动播放限制
    this.listening = true;
    this.cursor = 0;
    this._pull(true);
    this._emit(true);
  }

  stopListening() {
    this.listening = false;
    if (this.pullTimer) { clearTimeout(this.pullTimer); this.pullTimer = null; }
    this.playQueue = [];
    this.playing = false;
    if (this.audioCtx && this.audioCtx.state !== 'closed') this.audioCtx.close().catch(() => {});
    this.audioCtx = null;
    this._emit(true);
  }

  _bindUnlock() {
    if (this._unlockBound) return;
    this._unlockBound = true;
    const unlock = () => {
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('click', unlock);
    unlock();
  }

  _pull(primed = false) {
    const step = async () => {
      if (!this.listening) return;
      try {
        const r = await this.poll(primed ? this.cursor : 0);
        if (r) {
          if (!primed) {
            primed = true; // 首次仅对齐游标，跳过加入前的积压
            if (Number.isFinite(r.cursor)) this.cursor = r.cursor;
          } else {
            if (Number.isFinite(r.cursor)) this.cursor = r.cursor;
            for (const clip of (r.clips || [])) this._enqueue(clip);
          }
        }
      } catch (e) { /* 忽略 */ }
      this.pullTimer = setTimeout(step, 900);
    };
    step();
  }

  _enqueue(clip) {
    if (!clip || !clip.data) return;
    this.playQueue.push(clip);
    if (!this.playing) this._drain();
  }

  async _drain() {
    this.playing = true;
    while (this.playQueue.length && this.listening && this.audioCtx && this.audioCtx.state !== 'closed') {
      // 正在说话（录音）时先不播放他人，避免外放回授进麦克风
      if (this.segmenting) break;
      const clip = this.playQueue.shift();
      try {
        if (this.audioCtx.state === 'suspended') await this.audioCtx.resume().catch(() => {});
        const bin = base64ToUint8(clip.data);
        const buf = await this.audioCtx.decodeAudioData(bin.buffer);
        const source = this.audioCtx.createBufferSource();
        source.buffer = buf;
        source.connect(this.audioCtx.destination);
        source.start();
        await new Promise(resolve => {
          let done = false;
          const fin = () => { if (done) return; done = true; resolve(); };
          source.onended = fin;
          setTimeout(fin, buf.duration * 1000 + 400);
        });
      } catch (e) { /* 解码失败的片段跳过 */ }
    }
    this.playing = false;
  }

  /* ---------------- 说（开麦） ---------------- */

  async toggle() {
    if (this.speaking) this.stopSpeak();
    else await this.startSpeak();
  }

  async startSpeak() {
    if (this.speaking || this.busy) return;
    if (!this.connected) {
      this.onError('尚未进入房间，无法开麦');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
      this.onError('当前浏览器不支持录音');
      return;
    }
    this.busy = true;
    this._emit(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.stream = stream;
      this.supportedMime = pickMime();
      this.recCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.recCtx.state === 'suspended') await this.recCtx.resume();
      const src = this.recCtx.createMediaStreamSource(stream);
      this.analyser = this.recCtx.createAnalyser();
      this.analyser.fftSize = 512;
      src.connect(this.analyser);
      this.speaking = true;
      this.busy = false;
      this._emit(true);
      this._startVad();
    } catch (e) {
      this.busy = false;
      this.speaking = false;
      this._teardownMic();
      this._emit(true);
      const name = e && e.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        this.onError('麦克风权限被拒绝，请在浏览器设置中允许');
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        this.onError('未检测到可用麦克风');
      } else {
        this.onError('开麦失败，请重试');
      }
    }
  }

  stopSpeak() {
    this.speaking = false;
    this.busy = false;
    this._stopVad();
    this._stopSegment();
    this._teardownMic();
    this._emit(true);
  }

  _teardownMic() {
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.recCtx && this.recCtx.state !== 'closed') this.recCtx.close().catch(() => {});
    this.recCtx = null;
    this.analyser = null;
  }

  _startVad() {
    if (!this.analyser) return;
    const buf = new Uint8Array(this.analyser.fftSize);
    this.lastVoiceAt = 0;
    const loop = () => {
      if (!this.speaking || !this.analyser) return;
      this.analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / buf.length);
      const now = Date.now();
      if (rms > 0.012) {
        this.lastVoiceAt = now;
        if (!this.segmenting) this._startSegment();
      }
      if (this.segmenting) {
        const dur = now - this.segmentStart;
        if ((this.lastVoiceAt && now - this.lastVoiceAt > 600) || dur > 6000) this._stopSegment();
      }
      this.vadTimer = setTimeout(loop, 80);
    };
    loop();
  }

  _stopVad() {
    if (this.vadTimer) { clearTimeout(this.vadTimer); this.vadTimer = null; }
  }

  _startSegment() {
    if (!this.stream || this.recorder) return;
    try {
      const rec = this.supportedMime
        ? new MediaRecorder(this.stream, { mimeType: this.supportedMime })
        : new MediaRecorder(this.stream);
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = () => this._uploadSegments(chunks, rec.mimeType || this.supportedMime || 'audio/webm');
      rec.start();
      this.recorder = rec;
      this.segmenting = true;
      this.segmentStart = Date.now();
    } catch (e) {
      this.recorder = null;
      this.segmenting = false;
    }
  }

  _stopSegment() {
    if (this.recorder && this.segmenting) {
      try { this.recorder.stop(); } catch (e) { /* ignore */ }
      this.recorder = null;
    }
    this.segmenting = false;
    // 说完一段后恢复播放他人语音
    if (this.playQueue.length && !this.playing) this._drain();
  }

  async _uploadSegments(chunks, mime) {
    if (!chunks || !chunks.length) return;
    const blob = new Blob(chunks, { type: mime });
    if (blob.size < 600) return; // 过短/近似静音，丢弃
    try {
      const data = await blobToBase64(blob);
      await this.upload({ mime: blob.type, data });
    } catch (e) { /* 上传失败忽略 */ }
  }
}

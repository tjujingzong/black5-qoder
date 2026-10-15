import { comboSpeech, speechLanguage } from './speech.js';

const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
const LEGACY_AUDIO_KEY = 'jh5-audio-enabled';
const MUSIC_KEY = 'jh5-music-enabled';
const EFFECTS_KEY = 'jh5-effects-enabled';
const MUSIC_VOLUME = 0.18;
const TURN_REMINDER_DELAY_MS = 8000;

export const MUSIC_TRACKS = [
  { src: '/audio/bassa-island-game-loop.mp3', title: 'Bassa Island Game Loop' },
  { src: '/audio/funk-game-loop.mp3', title: 'Funk Game Loop' },
  { src: '/audio/voxel-revolution.mp3', title: 'Voxel Revolution' },
];

export const EFFECT_MEDIA_SOURCES = Object.freeze({
  click: '/audio/sfx/click.wav',
  card: '/audio/sfx/card.wav',
  join: '/audio/sfx/join.wav',
  ready: '/audio/sfx/ready.wav',
  play: '/audio/sfx/play.wav',
  pass: '/audio/sfx/pass.wav',
  blackFive: '/audio/sfx/black-five.wav',
  turn: '/audio/sfx/turn.wav',
  start: '/audio/sfx/start.wav',
  result: '/audio/sfx/result.wav',
  error: '/audio/sfx/error.wav',
  tomato: '/audio/sfx/tomato.wav',
  bucket: '/audio/sfx/bucket.wav',
});

export const VOICE_MEDIA_SOURCES = Object.freeze({
  '心态崩了啊': '/audio/voice/quick-mindset.wav',
  '一个小单张，不走不健康': '/audio/voice/quick-single.wav',
  '快点吧，我等得花儿都谢了': '/audio/voice/quick-hurry.wav',
  '你的牌打得太好了': '/audio/voice/quick-good-play.wav',
  '就这？': '/audio/voice/quick-just-this.wav',
  pass: '/audio/voice/pass-en.wav',
  '要不起': '/audio/voice/pass-cannot.wav',
  '不要': '/audio/voice/pass-no.wav',
  '黑五现身': '/audio/voice/black-five.wav',
  '顺子': '/audio/voice/straight.wav',
  '姊妹对': '/audio/voice/sister-pairs.wav',
});

const MEDIA_UNLOCK_SOURCE = '/audio/sfx/silence.wav';
const EFFECT_PLAYER_COUNT = 3;

class GameAudio {
  constructor() {
    const legacyEnabled = localStorage.getItem(LEGACY_AUDIO_KEY) !== '0';
    this.musicEnabled = localStorage.getItem(MUSIC_KEY) == null
      ? legacyEnabled
      : localStorage.getItem(MUSIC_KEY) !== '0';
    this.effectsEnabled = localStorage.getItem(EFFECTS_KEY) == null
      ? legacyEnabled
      : localStorage.getItem(EFFECTS_KEY) !== '0';
    this.context = null;
    this.master = null;
    this.effectGain = null;
    this.music = null;
    this.musicButton = null;
    this.effectsButton = null;
    this.lastState = null;
    this.speechDepth = 0;
    this.userActivated = false;
    this.speechPrimed = false;
    this.pendingEffects = [];
    this.pendingSpeech = [];
    this.musicQueue = [];
    this.currentTrack = -1;
    this.musicRetry = 0;
    this.effectPlayers = [];
    this.effectPlayerIndex = 0;
    this.voicePlayer = null;
    this.mediaPrimed = false;
    this.mediaPrimePromise = null;
    this.mediaPrimeAttempted = false;
    this.turnReminderTimer = null;
    this.turnReminderKey = '';
  }

  init() {
    this.music = new Audio();
    this.music.loop = false;
    this.music.preload = 'auto';
    this.music.volume = MUSIC_VOLUME;
    this.music.addEventListener('ended', () => this.nextMusic(true));
    this.music.addEventListener('playing', () => { this.musicRetry = 0; });
    this.music.addEventListener('error', () => {
      if (!this.musicEnabled || ++this.musicRetry > MUSIC_TRACKS.length) return;
      this.nextMusic(true);
    });
    this.nextMusic(false);
    this.setupMediaPlayers();
    this.musicButton = document.getElementById('btn-music');
    this.effectsButton = document.getElementById('btn-effects');
    this.updateButtons();
    this.musicButton.addEventListener('click', () => this.toggleMusic());
    this.effectsButton.addEventListener('click', () => this.toggleEffects());
    const unlock = () => this.unlock(true);
    document.addEventListener('pointerdown', unlock, { capture: true });
    document.addEventListener('touchstart', unlock, { capture: true, passive: true });
    document.addEventListener('keydown', unlock, { capture: true });
    document.addEventListener('click', event => {
      if (event.target.closest('#btn-music, #btn-effects')) return;
      if (event.target.closest('[data-card]')) this.play('card');
      else if (event.target.closest('button:not(:disabled)')) this.play('click');
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.stopMusic();
      else {
        globalThis.speechSynthesis?.resume();
        this.unlock(false);
        if (this.musicEnabled) this.startMusic();
      }
    });
  }

  unlock(userGesture = true) {
    if (userGesture) {
      this.userActivated = true;
      this.primeSpeech();
      this.primeMediaPlayers();
    }
    if (this.effectsEnabled && AudioContextClass && !this.context) {
      this.context = new AudioContextClass();
      this.master = this.context.createGain();
      this.effectGain = this.context.createGain();
      this.master.gain.value = 0.9;
      this.effectGain.gain.value = 0.5;
      this.effectGain.connect(this.master);
      this.master.connect(this.context.destination);
      // Starting a silent source inside the gesture is required by older iOS Safari.
      const source = this.context.createBufferSource();
      source.buffer = this.context.createBuffer(1, 1, this.context.sampleRate);
      source.connect(this.effectGain);
      source.start(0);
    }
    const resumed = this.effectsEnabled && this.context?.state === 'suspended'
      ? this.context.resume().catch(() => {})
      : Promise.resolve();
    resumed.then(() => {
      this.flushPendingAudio();
    });
    if (this.musicEnabled) this.startMusic();
  }

  primeSpeech() {
    if (this.speechPrimed || !globalThis.speechSynthesis || !globalThis.SpeechSynthesisUtterance) return;
    this.speechPrimed = true;
    try {
      globalThis.speechSynthesis.resume();
      const primer = new SpeechSynthesisUtterance(' ');
      primer.volume = 0;
      globalThis.speechSynthesis.speak(primer);
    } catch (e) {
      this.speechPrimed = false;
    }
  }

  setupMediaPlayers() {
    this.effectPlayers = Array.from({ length: EFFECT_PLAYER_COUNT }, () => this.createMediaPlayer());
    this.voicePlayer = this.createMediaPlayer();
  }

  createMediaPlayer() {
    const player = new Audio(MEDIA_UNLOCK_SOURCE);
    player.preload = 'auto';
    player.playsInline = true;
    player.load();
    return player;
  }

  primeMediaPlayers() {
    if (this.mediaPrimed || this.mediaPrimePromise || !this.effectPlayers.length || !this.voicePlayer) {
      return this.mediaPrimePromise || Promise.resolve();
    }
    const players = [...this.effectPlayers, this.voicePlayer];
    this.mediaPrimeAttempted = true;
    const attempts = players.map(player => {
      player.src = MEDIA_UNLOCK_SOURCE;
      player.currentTime = 0;
      player.muted = false;
      player.volume = 0.0001;
      const started = player.play();
      return Promise.resolve(started).then(() => {
        player.pause();
        player.currentTime = 0;
        player.volume = 1;
      });
    });
    this.mediaPrimePromise = Promise.allSettled(attempts).then(results => {
      this.mediaPrimed = results.some(result => result.status === 'fulfilled');
      this.mediaPrimePromise = null;
      this.flushPendingAudio();
    });
    return this.mediaPrimePromise;
  }

  flushPendingAudio() {
    if (this.userActivated) {
      this.flushEffects();
      this.flushSpeech();
    }
  }

  toggleMusic() {
    this.musicEnabled = !this.musicEnabled;
    localStorage.setItem(MUSIC_KEY, this.musicEnabled ? '1' : '0');
    this.updateButtons();
    if (this.musicEnabled) this.unlock();
    else this.stopMusic();
  }

  toggleEffects() {
    this.effectsEnabled = !this.effectsEnabled;
    localStorage.setItem(EFFECTS_KEY, this.effectsEnabled ? '1' : '0');
    this.updateButtons();
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(this.effectsEnabled ? 0.9 : 0.0001, this.context.currentTime, 0.015);
    }
    if (this.effectsEnabled) this.unlock();
    else {
      this.pendingEffects = [];
      this.pendingSpeech = [];
      this.effectPlayers.forEach(player => player.pause());
      this.voicePlayer?.pause();
      globalThis.speechSynthesis?.cancel();
    }
  }

  updateButtons() {
    if (this.musicButton) {
      const icon = this.musicButton.querySelector('span');
      if (icon) icon.textContent = this.musicEnabled ? '♫' : '♪';
      else this.musicButton.textContent = this.musicEnabled ? '♫' : '♪';
      this.musicButton.classList.toggle('active', this.musicEnabled);
      this.musicButton.setAttribute('aria-pressed', String(this.musicEnabled));
      const track = MUSIC_TRACKS[this.currentTrack]?.title;
      const label = this.musicEnabled ? `关闭背景音乐${track ? `（${track}）` : ''}` : '开启背景音乐';
      this.musicButton.setAttribute('aria-label', label);
      this.musicButton.title = label;
    }
    if (this.effectsButton) {
      const icon = this.effectsButton.querySelector('span');
      if (icon) icon.textContent = this.effectsEnabled ? '🔊' : '🔇';
      else this.effectsButton.textContent = this.effectsEnabled ? '🔊' : '🔇';
      this.effectsButton.classList.toggle('active', this.effectsEnabled);
      this.effectsButton.setAttribute('aria-pressed', String(this.effectsEnabled));
      const label = this.effectsEnabled ? '关闭牌局音效' : '开启牌局音效';
      this.effectsButton.setAttribute('aria-label', label);
      this.effectsButton.title = label;
    }
  }

  startMusic() {
    if (!this.musicEnabled || !this.music || document.hidden || !this.music.paused) return;
    if (!this.music.src) this.nextMusic(false);
    this.music.play().catch(() => {});
  }

  stopMusic() {
    this.music?.pause();
  }

  nextMusic(autoplay) {
    if (!this.music) return;
    if (!this.musicQueue.length) {
      this.musicQueue = MUSIC_TRACKS.map((_, index) => index);
      for (let i = this.musicQueue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.musicQueue[i], this.musicQueue[j]] = [this.musicQueue[j], this.musicQueue[i]];
      }
      if (this.musicQueue.length > 1 && this.musicQueue[0] === this.currentTrack) {
        [this.musicQueue[0], this.musicQueue[1]] = [this.musicQueue[1], this.musicQueue[0]];
      }
    }
    this.currentTrack = this.musicQueue.shift();
    this.music.src = MUSIC_TRACKS[this.currentTrack].src;
    this.music.load();
    this.updateButtons();
    if (autoplay && this.musicEnabled && !document.hidden) this.music.play().catch(() => {});
  }

  voice(frequency, start, duration, volume, type, destination) {
    if (!this.context || !destination) return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.03);
  }

  noise(start, duration, volume, filterType, frequency) {
    if (!this.context || !this.effectGain) return;
    const frames = Math.ceil(this.context.sampleRate * duration);
    const buffer = this.context.createBuffer(1, frames, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    source.buffer = buffer;
    filter.type = filterType;
    filter.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(volume, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.effectGain);
    source.start(start);
    source.stop(start + duration);
  }

  play(name) {
    if (!this.effectsEnabled) return;
    if (!this.userActivated) {
      this.queueEffect(name);
      return;
    }
    const source = EFFECT_MEDIA_SOURCES[name];
    if (source && this.effectPlayers.length) {
      if (this.mediaPrimePromise) {
        this.queueEffect(name);
        return;
      }
      if (!this.mediaPrimed && !this.mediaPrimeAttempted) {
        this.queueEffect(name);
        this.primeMediaPlayers();
        return;
      }
      if (!this.mediaPrimed) {
        this.playWebEffect(name);
        return;
      }
      this.playEffectMedia(source, name);
      return;
    }
    this.playWebEffect(name);
  }

  queueEffect(name) {
    this.pendingEffects.push(name);
    if (this.pendingEffects.length > 8) this.pendingEffects.shift();
  }

  playEffectMedia(source, fallbackName) {
    const availableIndex = this.effectPlayers.findIndex(player => player.paused || player.ended);
    const index = availableIndex >= 0 ? availableIndex : this.effectPlayerIndex++ % this.effectPlayers.length;
    const player = this.effectPlayers[index];
    player.pause();
    player.src = source;
    player.currentTime = 0;
    player.muted = false;
    player.volume = 0.9;
    const started = player.play();
    if (started?.catch) started.catch(() => this.playWebEffect(fallbackName));
  }

  playWebEffect(name) {
    if (!this.context || this.context.state !== 'running') {
      this.queueEffect(name);
      if (this.userActivated) this.unlock(false);
      return;
    }
    const now = this.context.currentTime;
    const tone = (frequency, offset, duration, volume = 0.18, type = 'sine') =>
      this.voice(frequency, now + offset, duration, volume, type, this.effectGain);
    switch (name) {
      case 'click': tone(420, 0, 0.05, 0.1); break;
      case 'card':
        tone(920, 0, 0.035, 0.07, 'square');
        tone(1240, 0.025, 0.025, 0.045, 'square');
        break;
      case 'join': tone(392, 0, 0.1); tone(523.25, 0.09, 0.16); break;
      case 'ready': tone(440, 0, 0.08); tone(554.37, 0.07, 0.11); break;
      case 'play':
        this.noise(now, 0.12, 0.17, 'lowpass', 850);
        tone(128, 0, 0.16, 0.25, 'sine');
        tone(92, 0.055, 0.2, 0.16, 'triangle');
        break;
      case 'pass': tone(260, 0, 0.06, 0.08); tone(190, 0.05, 0.1, 0.08, 'triangle'); break;
      case 'blackFive':
        tone(110, 0, 0.3, 0.24, 'sawtooth');
        tone(164.81, 0.12, 0.34, 0.2, 'square');
        tone(220, 0.27, 0.42, 0.22, 'sawtooth');
        break;
      case 'turn': tone(523.25, 0, 0.13); tone(659.25, 0.11, 0.18); break;
      case 'start': tone(261.63, 0, 0.16); tone(329.63, 0.1, 0.18); tone(392, 0.2, 0.24); break;
      case 'result': tone(392, 0, 0.2); tone(523.25, 0.12, 0.22); tone(659.25, 0.24, 0.3); break;
      case 'error': tone(180, 0, 0.12, 0.2, 'sawtooth'); tone(145, 0.1, 0.18, 0.14, 'sawtooth'); break;
      case 'tomato':
        this.noise(now, 0.34, 0.38, 'lowpass', 310);
        tone(82, 0.01, 0.23, 0.22, 'sine');
        break;
      case 'bucket':
        this.noise(now, 0.7, 0.32, 'highpass', 1600);
        tone(1040, 0, 0.08, 0.12, 'square');
        tone(780, 0.13, 0.11, 0.1, 'square');
        tone(520, 0.27, 0.16, 0.12, 'triangle');
        break;
    }
  }

  flushEffects() {
    const pending = this.pendingEffects.splice(0);
    for (const name of pending) this.play(name);
  }

  announce(combo) {
    const text = comboSpeech(combo);
    if (text) this.speak(text);
  }

  speak(text) {
    if (!this.effectsEnabled || !text) return;
    if (!this.userActivated) {
      this.pendingSpeech.push(text);
      if (this.pendingSpeech.length > 6) this.pendingSpeech.shift();
      return;
    }
    const source = VOICE_MEDIA_SOURCES[text];
    if (source && this.voicePlayer) {
      if (this.mediaPrimePromise) {
        this.pendingSpeech.push(text);
        if (this.pendingSpeech.length > 6) this.pendingSpeech.shift();
        return;
      }
      if (!this.mediaPrimed) {
        this.speakWithSystem(text);
        return;
      }
      this.playVoiceMedia(source, text);
      return;
    }
    this.speakWithSystem(text);
  }

  playVoiceMedia(source, fallbackText) {
    const player = this.voicePlayer;
    player.pause();
    player.src = source;
    player.currentTime = 0;
    player.muted = false;
    player.volume = 1;
    this.duckMusic();
    const restore = () => this.restoreMusic();
    player.onended = restore;
    player.onerror = restore;
    const started = player.play();
    if (started?.catch) started.catch(() => {
      restore();
      this.speakWithSystem(fallbackText);
    });
  }

  speakWithSystem(text) {
    if (!globalThis.speechSynthesis || !globalThis.SpeechSynthesisUtterance) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = speechLanguage(text);
    utterance.rate = 1.08;
    utterance.pitch = 1;
    utterance.volume = 0.95;
    const voices = speechSynthesis.getVoices();
    const language = utterance.lang.toLowerCase();
    utterance.voice = voices.find(voice => voice.lang.toLowerCase() === language)
      || voices.find(voice => voice.lang.toLowerCase().startsWith(language.slice(0, 2)))
      || null;
    utterance.onstart = () => {
      this.speechDepth++;
      this.duckMusic();
    };
    const restore = () => {
      this.speechDepth = Math.max(0, this.speechDepth - 1);
      if (this.speechDepth === 0) this.restoreMusic();
    };
    utterance.onend = restore;
    utterance.onerror = restore;
    speechSynthesis.speak(utterance);
  }

  duckMusic() {
    if (this.musicEnabled && this.music) this.music.volume = 0.055;
  }

  restoreMusic() {
    if (this.music) this.music.volume = MUSIC_VOLUME;
  }

  flushSpeech() {
    if (!this.userActivated || !this.effectsEnabled) return;
    const pending = this.pendingSpeech.splice(0);
    for (const text of pending) this.speak(text);
  }

  syncTurnReminder(view, next) {
    const isMyTurn = next.phase === 'playing' && next.turn === next.mine;
    const startedAt = Number(view.turnStartedAt);
    const key = isMyTurn && Number.isFinite(startedAt)
      ? `${next.round}:${next.mine}:${startedAt}`
      : '';
    if (!key) {
      this.cancelTurnReminder();
      return;
    }
    if (key === this.turnReminderKey) return;
    this.cancelTurnReminder();
    this.turnReminderKey = key;
    const serverNow = Number.isFinite(view.serverNow) ? view.serverNow : Date.now();
    const remaining = Math.max(0, TURN_REMINDER_DELAY_MS - (serverNow - startedAt));
    this.turnReminderTimer = setTimeout(() => {
      this.turnReminderTimer = null;
      const current = this.lastState;
      if (this.turnReminderKey === key && current?.phase === 'playing'
        && current.turn === current.mine && current.turnStartedAt === startedAt) {
        this.speak('轮到你出牌');
      }
    }, remaining);
  }

  cancelTurnReminder() {
    clearTimeout(this.turnReminderTimer);
    this.turnReminderTimer = null;
    this.turnReminderKey = '';
  }

  observe(view) {
    const next = {
      phase: view.phase,
      round: view.round,
      players: view.players.length,
      ready: view.players.filter(player => player.ready).length,
      turn: view.turnSeat,
      mine: view.mySeat,
      turnStartedAt: Number(view.turnStartedAt),
      pending: view.pending
        ? `${view.pending.seat}:${view.pending.cards.map(card => card.id).join(',')}`
        : '',
      combo: view.pending?.combo || null,
      quickId: (view.chat || []).length ? view.chat[view.chat.length - 1].id : 0,
      quick: (view.chat || []).length ? view.chat[view.chat.length - 1] : null,
      interactionId: view.lastInteraction?.id || 0,
      interaction: view.lastInteraction || null,
      audioId: view.audioEvent?.id || 0,
      audioEvent: view.audioEvent || null,
    };
    const previous = this.lastState;
    this.lastState = next;
    this.syncTurnReminder(view, next);
    if (!previous) return;
    const action = next.audioId > previous.audioId ? next.audioEvent : null;
    if (action?.type === 'play') {
      this.play('play');
      this.announce(action.combo);
      if (action.blackFive) {
        this.play('blackFive');
        this.speak('黑五现身');
      }
    } else if (action?.type === 'pass') {
      this.play('pass');
      this.speak(action.text);
    } else if (action?.type === 'blackFive') {
      this.play('blackFive');
      this.speak(action.text);
    }
    if (previous.turn !== next.turn && next.turn === next.mine && next.phase === 'playing') {
      this.play('turn');
    }
    if (previous.phase !== 'roundEnd' && next.phase === 'roundEnd') this.play('result');
    else if (previous.phase !== 'playing' && next.phase === 'playing') this.play('start');
    else if (next.players > previous.players) this.play('join');
    else if (next.ready > previous.ready) this.play('ready');
    if (next.quickId > previous.quickId && next.quick?.quick) this.speak(next.quick.text);
    if (next.interactionId > previous.interactionId) this.play(next.interaction.item);
  }
}

export const gameAudio = new GameAudio();

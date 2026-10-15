// 权威游戏状态机：浏览器测试与房间服务共用。
// 规则要点：
// - 52 张牌按逆时针从庄家开始轮发 → 5 人时庄家与下家各 11 张、其余各 10 张，人数不同自动适配
// - 黑桃5 持有者为庄家的秘密队友（黑五）；庄家自持黑桃5 为独庄
// - 头科（第一个出完）所在阵营获胜，之后继续决出全部名次用于计分

import { makeDeck, shuffle, sortHand, cardLabel, BLACK5_ID, rankStrength } from './cards.js';
import { classify, canBeat, comboName, posName, findHint } from './rules.js';

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 6;
export const TURN_SECONDS = 20;
export const QUICK_PHRASES = [
  '心态崩了啊',
  '一个小单张，不走不健康',
  '快点吧，我等得花儿都谢了',
  '你的牌打得太好了',
  '就这？',
];
export const PASS_PHRASES = ['pass', '要不起', '不要'];
export const INTERACTION_ITEMS = ['tomato', 'bucket'];
export const AVATAR_IDS = ['bamboo', 'cloud', 'jade', 'lotus', 'moon', 'pepper', 'plum', 'tiger'];

function genToken() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return 'p-' + globalThis.crypto.randomUUID();
  }
  return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

function genPublicId() {
  return genToken().replace(/^p-/, 'u-');
}

export class Game {
  constructor() {
    this.players = [];        // 座位顺序即数组下标（对局中不变）
    this.phase = 'lobby';     // lobby | playing | roundEnd
    this.round = 0;
    this.dealer = 0;          // 庄家座位
    this.turn = 0;            // 当前行动座位
    this.pending = null;      // 待压的牌 {seat, combo, cards}
    this.passStreak = 0;      // 自上次出牌以来的连续过牌数
    this.rankCount = 0;       // 已出完的人数
    this.winTeam = null;      // 'A' 庄家阵营 | 'B' 闲家阵营
    this.blackFiveSeat = null;
    this.blackFivePublic = false;
    this.solo = false;        // 独庄
    this.lastActions = {};    // 本圈内每位玩家的最后动作（用于桌面展示）
    this.result = null;
    this.log = [];
    this.chat = [];
    this.messageSeq = 0;
    this.interactionSeq = 0;
    this.lastInteraction = null;
    this.audioSeq = 0;
    this.lastAudioEvent = null;
    this.turnStartedAt = null;
    this.turnDeadline = null;
  }

  pushLog(msg) {
    this.log.push(msg);
    if (this.log.length > 60) this.log.splice(0, this.log.length - 60);
  }

  normalize() {
    this.chat ||= [];
    this.messageSeq ||= 0;
    this.interactionSeq ||= 0;
    this.lastInteraction ||= null;
    this.audioSeq ||= 0;
    this.lastAudioEvent ||= null;
    if (this.phase === 'playing' && !Number.isFinite(this.turnDeadline)) this.resetTurnTimer();
    const usedAvatars = new Set();
    for (const player of this.players) {
      player.publicId ||= genPublicId();
      player.isBot = !!player.isBot;
      player.voice = false;
      if (!AVATAR_IDS.includes(player.avatar) || usedAvatars.has(player.avatar)) {
        const available = AVATAR_IDS.filter(avatar => !usedAvatars.has(avatar));
        player.avatar = available[Math.floor(Math.random() * available.length)] || AVATAR_IDS[0];
      }
      usedAvatars.add(player.avatar);
    }
    return this;
  }

  assignAvatars() {
    const avatars = shuffle([...AVATAR_IDS]);
    this.players.forEach((player, index) => { player.avatar = avatars[index % avatars.length]; });
  }

  /* ---------------- 房间管理 ---------------- */

  join(name, token) {
    name = String(name || '').trim().slice(0, 8) || '玩家';
    if (token) { // 断线重连：凭令牌找回座位
      const p = this.players.find(x => x.id === token);
      if (p) {
        p.connected = true;
        p.voice = false;
        this.pushLog(`${p.name} 重新连接`);
        return { player: p };
      }
    }
    if (this.phase !== 'lobby') return { error: '对局进行中，暂时无法加入' };
    if (this.players.length >= MAX_PLAYERS) return { error: `房间已满（最多 ${MAX_PLAYERS} 人）` };
    const p = { id: genToken(), publicId: genPublicId(), name, hand: [], ready: false, connected: true, score: 0, outRank: null, isBot: false, voice: false };
    this.players.push(p);
    this.assignAvatars();
    this.pushLog(`${name} 加入了房间`);
    return { player: p };
  }

  handleDisconnect(id) {
    const p = this.players.find(x => x.id === id);
    if (!p) return;
    if (this.phase === 'lobby') {
      this.players = this.players.filter(x => x.id !== id);
      this.pushLog(`${p.name} 离开了房间`);
    } else {
      p.connected = false;
      p.voice = false;
      this.pushLog(`${p.name} 掉线，等待重连…`);
    }
  }

  handleMsg(id, msg) {
    if (!this.players.find(x => x.id === id)) return '你不在房间中';
    switch (msg && msg.t) {
      case 'ready': return this.setReady(id, !!msg.ready);
      case 'start': return this.start(id);
      case 'play': return this.play(id, msg.ids);
      case 'pass': return this.pass(id);
      case 'reveal': return this.reveal(id);
      case 'next': return this.next(id);
      case 'toLobby': return this.toLobby(id);
      case 'addBot': return this.addBot(id);
      case 'removeBot': return this.removeBot(id, msg.id);
      case 'chat': return this.sendChat(id, msg.text, false);
      case 'quick': return this.sendChat(id, msg.text, true);
      case 'voiceStatus': return this.setVoiceStatus(id, !!msg.enabled);
      case 'interact': return this.interact(id, msg.to, msg.item);
      default: return '未知操作';
    }
  }

  setReady(id, ready) {
    if (this.phase !== 'lobby') return '对局中无法更改准备状态';
    const p = this.players.find(x => x.id === id);
    p.ready = ready;
    if (ready) this.pushLog(`${p.name} 已准备`);
    return null;
  }

  addBot(id) {
    if (id !== this.players[0].id) return '只有房主可以添加人机';
    if (this.phase !== 'lobby') return '只能在大厅添加人机';
    if (this.players.length >= MAX_PLAYERS) return `房间已满（最多 ${MAX_PLAYERS} 人）`;
    const used = new Set(this.players.filter(p => p.isBot).map(p => p.name));
    let index = 1;
    while (used.has(`电脑${index}`)) index++;
    const bot = {
      id: `bot-${genToken()}`, publicId: genPublicId(), name: `电脑${index}`, hand: [], ready: true,
      connected: true, score: 0, outRank: null, isBot: true, voice: false,
    };
    this.players.push(bot);
    this.assignAvatars();
    this.pushLog(`${bot.name} 加入了房间`);
    return null;
  }

  removeBot(id, botId) {
    if (id !== this.players[0].id) return '只有房主可以移除人机';
    if (this.phase !== 'lobby') return '只能在大厅移除人机';
    let index = botId ? this.players.findIndex(p => (p.publicId === botId || p.id === botId) && p.isBot) : -1;
    if (index < 0) {
      for (let i = this.players.length - 1; i >= 0; i--) {
        if (this.players[i].isBot) { index = i; break; }
      }
    }
    if (index < 0) return '房间里没有人机';
    const [bot] = this.players.splice(index, 1);
    this.assignAvatars();
    this.pushLog(`${bot.name} 离开了房间`);
    return null;
  }

  sendChat(id, value, quick) {
    const p = this.players.find(player => player.id === id);
    if (!p || p.isBot) return '无法发送消息';
    const text = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!text) return '消息不能为空';
    if (quick && !QUICK_PHRASES.includes(text)) return '快捷语音无效';
    this.chat.push({ id: ++this.messageSeq, playerId: p.publicId, name: p.name, text, quick, at: Date.now() });
    if (this.chat.length > 40) this.chat.splice(0, this.chat.length - 40);
    return null;
  }

  setVoiceStatus(id, enabled) {
    const p = this.players.find(player => player.id === id);
    if (!p || p.isBot) return '人机不能加入语音';
    p.voice = enabled;
    return null;
  }

  interact(id, targetId, item) {
    const from = this.players.find(player => player.id === id);
    const to = this.players.find(player => player.publicId === targetId);
    if (!from || !to) return '找不到互动对象';
    if (from === to) return '不能对自己使用道具';
    if (!INTERACTION_ITEMS.includes(item)) return '互动道具无效';
    const now = Date.now();
    if (from.lastInteractionAt && now - from.lastInteractionAt < 700) return '操作太快了，请稍后再试';
    from.lastInteractionAt = now;
    this.lastInteraction = {
      id: ++this.interactionSeq, fromId: from.publicId, fromName: from.name,
      toId: to.publicId, toName: to.name, item, at: now,
    };
    this.pushLog(`${from.name}${item === 'tomato' ? '向' : '给'}${to.name}${item === 'tomato' ? '扔了一个番茄' : '泼了一桶水'}`);
    return null;
  }

  /* ---------------- 开局 ---------------- */

  start(id) {
    if (id !== this.players[0].id) return '只有房主可以开始游戏';
    if (this.phase !== 'lobby') return '游戏已经在进行中';
    if (this.players.length < MIN_PLAYERS) return `至少需要 ${MIN_PLAYERS} 名玩家`;
    if (!this.players.slice(1).every(p => p.ready)) return '还有玩家没有准备';
    this.players.forEach(p => { p.score = 0; });
    this.dealer = Math.floor(Math.random() * this.players.length); // 首局随机庄家
    this.round = 0;
    this.startRound();
    return null;
  }

  startRound() {
    this.round++;
    const n = this.players.length;
    const deck = shuffle(makeDeck());
    this.players.forEach(p => { p.hand = []; p.outRank = null; });
    // 从庄家开始逆时针轮发：庄家与下家自然多拿一张
    deck.forEach((c, i) => this.players[(this.dealer + i) % n].hand.push(c));
    this.players.forEach(p => sortHand(p.hand));
    this.assignAvatars();

    this.blackFiveSeat = this.players.findIndex(p => p.hand.some(c => c.id === BLACK5_ID));
    this.solo = this.blackFiveSeat === this.dealer;
    this.blackFivePublic = false;
    this.pending = null;
    this.passStreak = 0;
    this.lastActions = {};
    this.rankCount = 0;
    this.winTeam = null;
    this.result = null;
    this.turn = this.dealer; // 庄家首出
    this.phase = 'playing';
    this.resetTurnTimer();
    this.pushLog(`—— 第 ${this.round} 局开始，庄家：${this.players[this.dealer].name} ——`);
  }

  /* ---------------- 出牌流程 ---------------- */

  teamSeats() {
    return this.solo ? [this.dealer] : [this.dealer, this.blackFiveSeat];
  }

  nextActive(from) {
    const n = this.players.length;
    let s = from;
    do { s = (s + 1) % n; } while (this.players[s].outRank !== null);
    return s;
  }

  resetTurnTimer(now = Date.now()) {
    this.turnStartedAt = now;
    this.turnDeadline = now + TURN_SECONDS * 1000;
  }

  pauseTurnTimer() {
    this.turnStartedAt = null;
    this.turnDeadline = null;
  }

  turnExpired(now = Date.now()) {
    return this.phase === 'playing' && Number.isFinite(this.turnDeadline) && now >= this.turnDeadline;
  }

  timeoutTurn(now = Date.now()) {
    if (!this.turnExpired(now)) return false;
    const seat = this.turn;
    const player = this.players[seat];
    if (!player || player.outRank !== null) return false;
    if (this.pending) {
      return this.pass(player.id, true) === null;
    }
    const card = findHint(player.hand, null)?.[0];
    if (!card) return false;
    return this.play(player.id, [card.id], true) === null;
  }

  play(id, ids, timeout = false) {
    if (this.phase !== 'playing') return '当前不在对局中';
    const seat = this.players.findIndex(p => p.id === id);
    const p = this.players[seat];
    if (this.turn !== seat) return '还没轮到你出牌';
    if (!Array.isArray(ids) || ids.length === 0) return '请先选择要出的牌';
    if (new Set(ids).size !== ids.length) return '选牌重复';
    const cards = [];
    for (const cid of ids) {
      const c = p.hand.find(x => x.id === cid);
      if (!c) return '选中的牌无效';
      cards.push(c);
    }
    const combo = classify(cards);
    if (!combo) return '不是合法的牌型';
    if (this.pending && this.pending.seat !== seat && !canBeat(combo, this.pending.combo)) {
      return '压不过当前的牌';
    }

    p.hand = p.hand.filter(c => !ids.includes(c.id));
    this.pending = { seat, combo, cards };
    this.passStreak = 0;
    this.lastActions[seat] = { type: 'play', cards, name: comboName(combo), timeout };
    const blackFivePlayed = cards.some(c => c.id === BLACK5_ID);
    this.lastAudioEvent = { id: ++this.audioSeq, type: 'play', combo, blackFive: blackFivePlayed, timeout };
    this.pushLog(timeout
      ? `${p.name} 超时，自动出 ${comboName(combo)}：${cards.map(cardLabel).join(' ')}`
      : `${p.name} 出 ${comboName(combo)}：${cards.map(cardLabel).join(' ')}`);

    // 黑桃5 一出手，身份自然暴露
    if (!this.blackFivePublic && blackFivePlayed) {
      this.blackFivePublic = true;
      this.pushLog(`黑桃5现身！${p.name} 就是黑五`);
    }

    if (p.hand.length === 0) this.outSeat(seat);
    if (this.phase === 'playing') this.afterAction();
    return null;
  }

  pass(id, timeout = false) {
    if (this.phase !== 'playing') return '当前不在对局中';
    const seat = this.players.findIndex(p => p.id === id);
    if (this.turn !== seat) return '还没轮到你';
    if (!this.pending) return '本轮由你首出，必须出牌';
    this.passStreak++;
    const voice = PASS_PHRASES[Math.floor(Math.random() * PASS_PHRASES.length)];
    this.lastActions[seat] = { type: 'pass', voice, timeout };
    this.lastAudioEvent = { id: ++this.audioSeq, type: 'pass', text: voice, timeout };
    this.pushLog(timeout ? `${this.players[seat].name} 超时，已自动过牌` : `${this.players[seat].name} 过牌`);
    this.afterAction();
    return null;
  }

  actBot() {
    if (this.phase !== 'playing') return false;
    const p = this.players[this.turn];
    if (!p || !p.isBot) return false;
    const hint = this.pending ? findHint(p.hand, this.pending.combo) : this.findBotLead(p.hand);
    const error = hint ? this.play(p.id, hint.map(card => card.id)) : this.pass(p.id);
    return error ? false : true;
  }

  findBotLead(hand) {
    if (!hand.length) return null;
    const candidates = [];
    const maxSize = Math.min(6, hand.length);
    // Enumerate small legal combinations so a bot can shed pairs, straights and
    // sister pairs instead of always leading a single low card.
    const visit = (start, chosen) => {
      if (chosen.length >= 2) {
        const combo = classify(chosen);
        if (combo && combo.kind !== 'triple' && combo.kind !== 'quad') {
          candidates.push({ cards: [...chosen], combo });
        }
      }
      if (chosen.length >= maxSize) return;
      for (let i = start; i < hand.length; i++) {
        chosen.push(hand[i]);
        visit(i + 1, chosen);
        chosen.pop();
      }
    };
    visit(0, []);
    candidates.sort((a, b) => b.cards.length - a.cards.length
      || rankStrength(a.combo.rank) - rankStrength(b.combo.rank)
      || a.combo.kind.localeCompare(b.combo.kind));
    return candidates[0]?.cards || findHint(hand, null);
  }

  reveal(id) {
    if (this.phase !== 'playing') return '现在不能明牌';
    const seat = this.players.findIndex(p => p.id === id);
    if (seat !== this.blackFiveSeat) return '你没有可亮的身份';
    if (this.blackFivePublic) return '身份已经公开了';
    this.blackFivePublic = true;
    this.lastAudioEvent = { id: ++this.audioSeq, type: 'blackFive', text: '黑五现身' };
    this.pushLog(`${this.players[seat].name} 亮出黑桃5：我就是黑五！`);
    return null;
  }

  // 出牌/过牌之后推进回合
  afterAction() {
    const active = this.players.filter(p => p.outRank === null).length;
    const teamA = new Set(this.teamSeats());
    const teamAComplete = this.players.every((player, seat) => !teamA.has(seat) || player.outRank !== null);
    const teamBComplete = this.players.every((player, seat) => teamA.has(seat) || player.outRank !== null);
    if (active <= 1 || teamAComplete || teamBComplete) { this.finishRound(); return; }
    if (this.pending) {
      const holderOut = this.players[this.pending.seat].outRank !== null;
      // 除最后出牌者外全部过牌 → 本圈结束
      if (this.passStreak >= active - (holderOut ? 0 : 1)) { this.endTrick(); return; }
    }
    this.turn = this.nextActive(this.turn);
    this.resetTurnTimer();
  }

  endTrick() {
    const ps = this.pending.seat;
    this.pending = null;
    this.passStreak = 0;
    this.lastActions = {};
    if (this.players[ps].outRank === null) {
      this.turn = ps;
      this.pushLog(`无人压牌，${this.players[ps].name} 继续首出`);
    } else { // 最后出牌者已出完，出牌权交给其下家
      this.turn = this.nextActive(ps);
      this.pushLog(`无人压牌，由 ${this.players[this.turn].name} 首出`);
    }
    this.resetTurnTimer();
  }

  outSeat(seat) {
    const p = this.players[seat];
    p.outRank = ++this.rankCount;
    this.pushLog(`${p.name} 出完手牌，${posName(p.outRank, this.players.length)}！`);
    if (this.rankCount === 1) {
      this.winTeam = this.teamSeats().includes(seat) ? 'A' : 'B';
      this.pushLog(`头科诞生 —— ${this.winTeam === 'A' ? '庄家阵营' : '闲家阵营'}获胜！继续决出全部名次`);
    }
  }

  /* ---------------- 结算 ---------------- */

  finishRound() {
    const n = this.players.length;
    // An entire team finishing is enough to end the hand. Give the remaining
    // players stable finishing positions before calculating the settlement.
    for (const player of this.players) {
      if (player.outRank === null) player.outRank = ++this.rankCount;
    }
    const teamA = this.teamSeats();
    // 名次基础分：5 人局为 头科+10 / 二科+5 / 三科0 / 四科-5 / 大落-10，其他人数等差展开
    const posPts = pos => (n - 1 - 2 * (pos - 1)) * 5;
    const sumA = teamA.reduce((s, seat) => s + posPts(this.players[seat].outRank), 0);
    const zeroRound = sumA === 0; // 双方名次分相抵为平局（如一头科一大落），否则按名次结算
    const mult = this.solo ? 2 : 1;
    const teamACount = teamA.length;
    const teamBCount = n - teamACount;
    const rows = this.players.map((p, i) => {
      const inA = teamA.includes(i);
      const delta = zeroRound ? 0 : (inA ? sumA * teamBCount : -sumA * teamACount) * mult;
      p.score += delta;
      return { name: p.name, pos: p.outRank, posName: posName(p.outRank, n), team: inA ? '庄家' : '闲家', delta, score: p.score };
    }).sort((a, b) => a.pos - b.pos);
    this.blackFivePublic = true; // 结算时公开黑五身份
    this.pauseTurnTimer();
    this.result = { winTeam: this.winTeam, solo: this.solo, zeroRound, rows };
    this.phase = 'roundEnd';
    this.pushLog(zeroRound
      ? '本局结束：双方名次相抵，平局记 0 分'
      : `本局结束：${this.winTeam === 'A' ? '庄家阵营' : '闲家阵营'}获胜${this.solo ? '（独庄，分数翻倍）' : ''}`);
  }

  next(id) {
    if (id !== this.players[0].id) return '只有房主可以开始下一局';
    if (this.phase !== 'roundEnd') return '当前不能开始下一局';
    this.dealer = (this.dealer + 1) % this.players.length; // 庄家轮替
    this.startRound();
    return null;
  }

  toLobby(id) {
    if (id !== this.players[0].id) return '只有房主可以操作';
    if (this.phase !== 'roundEnd') return '当前不能返回大厅';
    this.phase = 'lobby';
    this.round = 0;
    this.result = null;
    this.pending = null;
    this.lastActions = {};
    this.pauseTurnTimer();
    this.players.forEach(p => { p.ready = !!p.isBot; p.score = 0; p.hand = []; p.outRank = null; p.voice = false; });
    this.pushLog('已返回大厅，积分清零');
    return null;
  }

  /* ---------------- 状态视图 ---------------- */

  // 按玩家生成"战争迷雾"视图：只暴露该玩家应看到的信息
  viewFor(id) {
    const me = this.players.find(p => p.id === id);
    if (!me) return { phase: 'gone', myId: null, players: [], myHand: [], log: [] };
    const inGame = this.phase !== 'lobby';
    const mySeat = this.players.indexOf(me);
    return {
      phase: this.phase,
      round: this.round,
      n: this.players.length,
      myId: me.publicId,
      isHost: id === this.players[0].id,
      mySeat,
      players: this.players.map((p, i) => ({
        id: p.publicId, name: p.name, count: p.hand.length, ready: p.ready,
        connected: p.connected, outRank: p.outRank, score: p.score,
        isBot: !!p.isBot, voice: !!p.voice, avatar: p.avatar,
        isMe: p.id === id, isRoomOwner: i === 0,
        isDealer: inGame && i === this.dealer,
        isBlackFive: inGame && this.blackFivePublic && i === this.blackFiveSeat,
      })),
      myHand: inGame ? me.hand : [],
      turnSeat: inGame ? this.turn : null,
      dealerSeat: inGame ? this.dealer : null,
      pending: this.pending ? {
        seat: this.pending.seat,
        name: comboName(this.pending.combo),
        cards: this.pending.cards,
        combo: { kind: this.pending.combo.kind, rank: this.pending.combo.rank, len: this.pending.combo.len },
      } : null,
      lastActions: inGame ? this.lastActions : {},
      publicSolo: inGame && this.solo && this.blackFivePublic,
      blackFiveSeat: inGame && this.blackFivePublic ? this.blackFiveSeat : null,
      canReveal: this.phase === 'playing' && !this.blackFivePublic && mySeat === this.blackFiveSeat,
      mySecret: inGame && mySeat === this.blackFiveSeat
        ? { solo: this.solo, dealer: mySeat === this.dealer }
        : null,
      winTeam: this.winTeam,
      result: this.result,
      chat: this.chat.slice(-30),
      lastInteraction: this.lastInteraction,
      audioEvent: this.lastAudioEvent,
      serverNow: Date.now(),
      turnStartedAt: this.phase === 'playing' ? this.turnStartedAt : null,
      turnDeadline: this.phase === 'playing' ? this.turnDeadline : null,
      turnSeconds: TURN_SECONDS,
      log: this.log.slice(-9),
      canStart: this.phase === 'lobby'
        && this.players.length >= MIN_PLAYERS
        && this.players.slice(1).every(p => p.ready),
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
    };
  }
}

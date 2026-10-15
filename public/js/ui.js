// 界面渲染：完全由房间服务下发的玩家视图驱动。
import { classify, canBeat, findHint, posName } from './rules.js';
import { SUITS, rankChar } from './cards.js';
import { QUICK_PHRASES } from './engine.js';

let cur = null;          // 当前视图
let send = () => {};     // 通过实时连接向权威房间服务发送动作
let roomCode = '';
const selected = new Set(); // 选中的手牌 id
let chatDraft = '';
let socialTarget = null;
let lastInteractionId = 0;
let serverClockOffset = 0;

setInterval(updateTurnClocks, 250);

export function bindSend(fn) { send = fn; }
export function setRoomInfo(code) {
  roomCode = code;
  const el = document.getElementById('room-code');
  if (el) el.textContent = code;
}

export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2400);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function mini(c) {
  return `<span class="mcard${(c.suit === 1 || c.suit === 3) ? ' red' : ''}">${SUITS[c.suit]}${rankChar(c.rank)}</span>`;
}

function tableCard(c) {
  const red = c.suit === 1 || c.suit === 3;
  return `<div class="table-card${red ? ' red' : ''}">
    <span class="table-rank">${rankChar(c.rank)}</span>
    <span class="table-suit">${SUITS[c.suit]}</span>
  </div>`;
}

/* ---------------- 事件绑定 ---------------- */

export function init() {
  document.getElementById('btn-copy').addEventListener('click', () => {
    const link = `${location.origin}${location.pathname}?room=${roomCode}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link)
        .then(() => toast('邀请链接已复制'))
        .catch(() => toast('复制失败，房间号：' + roomCode));
    } else toast('房间号：' + roomCode);
  });

  document.getElementById('room-body').addEventListener('click', e => {
    const card = e.target.closest('[data-card]');
    if (card) {
      const id = card.dataset.card;
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      if (cur) render(cur);
      return;
    }
    const avatar = e.target.closest('[data-player-id]');
    if (avatar && avatar.dataset.playerId !== cur?.myId) {
      socialTarget = avatar.dataset.playerId;
      if (cur) render(cur);
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    handleAct(btn.dataset.act, btn);
  });
  document.getElementById('room-body').addEventListener('input', e => {
    if (e.target.matches('[data-chat-input]')) chatDraft = e.target.value;
  });
  document.getElementById('room-body').addEventListener('keydown', e => {
    if (e.target.matches('[data-chat-input]') && e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      handleAct('sendChat');
    }
  });
}

function handleAct(act, button = null) {
  const v = cur;
  if (!v) return;
  const me = v.players.find(p => p.isMe);
  switch (act) {
    case 'ready': send({ t: 'ready', ready: !me.ready }); break;
    case 'start': send({ t: 'start' }); break;
    case 'next': send({ t: 'next' }); break;
    case 'lobby': send({ t: 'toLobby' }); break;
    case 'reveal': send({ t: 'reveal' }); break;
    case 'addBot': send({ t: 'addBot' }); break;
    case 'removeBot': send({ t: 'removeBot' }); break;
    case 'sendChat': {
      const text = chatDraft.replace(/\s+/g, ' ').trim();
      if (!text) return toast('请输入聊天内容');
      send({ t: 'chat', text });
      chatDraft = '';
      render(v);
      break;
    }
    case 'quick': send({ t: 'quick', text: button.dataset.text }); break;
    case 'pass': {
      const myTurn = v.phase === 'playing' && v.turnSeat === v.mySeat;
      if (!myTurn) return toast('还没轮到你出牌');
      if (!v.pending) return toast('本轮由你首出，不能过牌');
      send({ t: 'pass' });
      selected.clear();
      break;
    }
    case 'interact': {
      send({ t: 'interact', to: button.dataset.to, item: button.dataset.item });
      socialTarget = null;
      render(v);
      break;
    }
    case 'closeProp': socialTarget = null; render(v); break;
    case 'hint': {
      const myTurn = v.phase === 'playing' && v.turnSeat === v.mySeat;
      if (!myTurn) return toast('还没轮到你出牌');
      const hint = findHint(v.myHand, v.pending ? v.pending.combo : null);
      if (hint && hint.length) {
        selected.clear();
        hint.forEach(c => selected.add(c.id));
        render(v);
      } else toast('没有能压过的牌，请点“过牌”');
      break;
    }
    case 'play': {
      const cards = v.myHand.filter(c => selected.has(c.id));
      if (!cards.length) return toast('请先选择要出的牌');
      const combo = classify(cards);
      if (!combo) return toast('不是合法牌型');
      if (v.pending && v.pending.seat !== v.mySeat && !canBeat(combo, v.pending.combo)) {
        return toast('压不过当前的牌');
      }
      send({ t: 'play', ids: cards.map(c => c.id) });
      selected.clear();
      break;
    }
  }
}

/* ---------------- 渲染 ---------------- */

export function render(v) {
  cur = v;
  if (Number.isFinite(v.serverNow)) serverClockOffset = v.serverNow - Date.now();
  const chatWasFocused = document.activeElement?.matches?.('[data-chat-input]');
  // 清理已不在手牌中的选中项
  const ids = new Set(v.myHand.map(c => c.id));
  for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);

  const body = document.getElementById('room-body');
  if (v.phase === 'gone') {
    body.innerHTML = '<div class="banner">你已不在房间中，请刷新页面</div>';
    return;
  }
  let html = '';
  if (v.phase === 'lobby') html += lobbyHtml(v);
  else {
    html += gameHtml(v);
    if (v.phase === 'roundEnd' && v.result) html += resultHtml(v);
  }
  html += `<div class="support-grid">${chatHtml(v)}${logHtml(v)}</div>`;
  body.innerHTML = html;
  updateTurnClocks();
  const messages = body.querySelector('.chat-messages');
  if (messages) messages.scrollTop = messages.scrollHeight;
  if (chatWasFocused) {
    const input = body.querySelector('[data-chat-input]');
    input?.focus();
    if (input) input.selectionStart = input.selectionEnd = input.value.length;
  }
}

function lobbyHtml(v) {
  const me = v.players.find(p => p.isMe);
  const botCount = v.players.filter(p => p.isBot).length;
  const list = v.players.map(p => `
    <li class="lobby-player${p.connected ? '' : ' off'}">
      <img class="lobby-avatar" src="${avatarSrc(p.avatar)}" alt="">
      <span class="pname">${esc(p.name)}${p.isMe ? '<small>我</small>' : ''}</span>
      <span class="pstate${p.ready || p.isBot ? ' ready' : ''}">${p.isBot ? '人机' : p.isRoomOwner ? '房主' : p.ready ? '已准备' : '未准备'}</span>
    </li>`).join('');
  const actions = v.isHost
    ? `<div class="bot-actions">
         <button data-act="addBot" ${v.players.length >= v.maxPlayers ? 'disabled' : ''}>添加人机</button>
         <button data-act="removeBot" ${botCount ? '' : 'disabled'}>移除人机</button>
       </div>
       <button class="primary big" data-act="start" ${v.canStart ? '' : 'disabled'}>开始游戏</button>
       <p class="tip">${v.canStart ? '可以开局' : `${v.players.length}/${v.maxPlayers} 人 · 至少 ${v.minPlayers} 人`}</p>`
    : `<button class="primary big" data-act="ready">${me.ready ? '取消准备' : '准备'}</button>
       <p class="tip">等待房主开始游戏…</p>`;
  return `<div class="lobby">
    <div class="lobby-heading"><div><span class="eyebrow">牌局大厅</span><h2>等待玩家</h2></div><b>${v.players.length}<small> / ${v.maxPlayers}</small></b></div>
    <div class="invite-strip"><span>房间号</span><strong>${esc(roomCode)}</strong><span>分享右上角邀请按钮</span></div>
    <ul class="plist">${list}</ul>
    <div class="actions-col">${actions}</div>
  </div>`;
}

function gameHtml(v) {
  const seatName = s => (v.players[s] ? esc(v.players[s].name) : '?');
  const offline = v.players.filter(p => !p.connected);
  const opponents = [];
  for (let offset = 1; offset < v.players.length; offset++) {
    opponents.push(v.players[(v.mySeat + offset) % v.players.length]);
  }
  const positions = {
    1: ['seat-top'],
    2: ['seat-top-left', 'seat-top-right'],
    3: ['seat-left', 'seat-top', 'seat-right'],
    4: ['seat-left-high', 'seat-left-low', 'seat-right-high', 'seat-right-low'],
    5: ['seat-left-high', 'seat-left-low', 'seat-top', 'seat-right-high', 'seat-right-low'],
  }[opponents.length] || [];
  const chips = opponents.map((player, index) => chipHtml(v, player, positions[index])).join('');
  const myTurn = v.phase === 'playing' && v.turnSeat === v.mySeat;
  const clock = turnClockHtml(v, myTurn);

  const center = v.pending
    ? `<div class="trick-owner"><b>${seatName(v.pending.seat)}</b><span>${v.pending.name}</span></div>
       <div class="table-cards">${v.pending.cards.map(tableCard).join('')}</div>`
    : `<div class="table-empty">${myTurn ? '由你首出' : `等待 ${seatName(v.turnSeat)} 出牌`}</div>`;

  const myLa = v.lastActions[v.mySeat];
  const myAct = myLa ? (myLa.type === 'pass'
    ? `你：${myLa.timeout ? '超时过牌' : '过牌'}`
    : `你：${myLa.timeout ? '超时出牌 ' : ''}${myLa.cards.map(mini).join('')}`) : '';

  let secret = '';
  if (v.mySecret) {
    secret = v.mySecret.solo
      ? '<div class="secret"><b>♠5</b> 你拿到了黑桃5 —— 本局独庄，独自对抗所有闲家！</div>'
      : '<div class="secret"><b>♠5</b> 你是黑五（黑桃5持有者），是庄家的秘密队友，可择机明牌</div>';
  }

  const groupedHand = [];
  for (const card of v.myHand) {
    let group = groupedHand.at(-1);
    if (!group || group.rank !== card.rank) {
      group = { rank: card.rank, cards: [] };
      groupedHand.push(group);
    }
    group.cards.push(card);
  }
  const hand = groupedHand.map(group => `
    <div class="card-group" style="--group-size:${group.cards.length}">
      ${group.cards.map((card, index) => `
        <div class="card${(card.suit === 1 || card.suit === 3) ? ' red' : ''}${selected.has(card.id) ? ' sel' : ''}"
             data-card="${card.id}" style="--card-index:${index}" aria-label="${SUITS[card.suit]}${rankChar(card.rank)}">
          <span class="cr">${rankChar(card.rank)}</span><span class="cs">${SUITS[card.suit]}</span>
        </div>`).join('')}
    </div>`).join('');
  const handMetrics = handLayout(groupedHand.length);

  const canPass = myTurn && !!v.pending;
  const status = v.phase !== 'playing' ? '本局已结束' : myTurn ? '轮到你出牌' : `等待 ${seatName(v.turnSeat)} 出牌`;
  const me = v.players[v.mySeat];

  return `<div class="game">
    <div class="game-statusbar">
      <div><small>局数</small><b>第 ${v.round} 局</b></div>
      <div><small>庄家</small><b>${seatName(v.dealerSeat)}</b></div>
      <div class="round-status${myTurn ? ' mine' : ''}"><small>当前</small><b>${status}</b></div>
    </div>
    ${scoreboardHtml(v)}
    ${offline.length ? `<div class="banner">⚠ ${offline.map(p => esc(p.name)).join('、')} 掉线，等待重新连接…</div>` : ''}
    <div class="table-wrap">
      <div class="table-felt">
        ${chips}
        <div class="table-center">
          ${clock}
          ${center}
        </div>
      </div>
    </div>
    ${secret}
    <div class="self-zone">
      <div class="self-profile">
        <img class="avatar-static" data-avatar-id="${esc(me.id)}" src="${avatarSrc(me.avatar)}" alt="">
        <span>${esc(me.name)}</span>${me.voice ? '<i class="voice-mark">语音中</i>' : ''}
      </div>
      <div class="myact">${myAct}</div>
      <div class="hand" style="--hand-groups:${groupedHand.length};--group-step:${handMetrics.step}px;--card-width:${handMetrics.width}px;--card-height:${handMetrics.height}px">${hand}</div>
      <div class="controls">
        <button class="hint-button" data-act="hint" ${myTurn ? '' : 'disabled'}>提示</button>
        <button class="pass-button" data-act="pass" ${canPass ? '' : 'disabled'}>过牌</button>
        <button class="primary play-button" data-act="play" ${myTurn ? '' : 'disabled'}>出牌${selected.size ? ` · ${selected.size}` : ''}</button>
        ${v.canReveal ? '<button class="accent" data-act="reveal">明牌：我是黑五</button>' : ''}
      </div>
    </div>
    ${propMenuHtml(v)}
  </div>`;
}

function scoreboardHtml(v) {
  const rows = v.players
    .map((player, seat) => ({ player, seat }))
    .sort((a, b) => b.player.score - a.player.score || a.seat - b.seat)
    .map(({ player, seat }, index) => {
      let role = '';
      if (player.isDealer) role += '<i class="score-role dealer">庄家</i>';
      if (player.isBlackFive || (player.isMe && v.mySecret && !v.mySecret.solo)) role += '<i class="score-role black-five">黑五</i>';
      if (v.publicSolo && player.isDealer) role += '<i class="score-role solo">独庄</i>';
      return `<li class="score-row${player.isMe ? ' mine' : ''}">
        <b class="score-rank">${index + 1}</b>
        <img src="${avatarSrc(player.avatar)}" alt="">
        <span class="score-name">${esc(player.name)}${player.isMe ? '<small>我</small>' : ''}</span>
        <span class="score-roles">${role}</span>
        <strong>${player.score}</strong>
      </li>`;
    }).join('');
  return `<section class="scoreboard" aria-label="积分榜">
    <div class="scoreboard-title"><span>积分榜</span><small>按积分排序</small></div>
    <ol>${rows}</ol>
  </section>`;
}

function chipHtml(v, p, position) {
  const seat = v.players.indexOf(p);
  const la = v.lastActions[seat];
  const turn = v.phase === 'playing' && v.turnSeat === seat;
  const cls = ['chip', position];
  if (turn) cls.push('turn');
  if (!p.connected) cls.push('off');
  if (p.outRank) cls.push('out');
  let tags = '';
  if (p.isDealer) tags += '<i class="tag dealer">庄</i>';
  if (p.isBlackFive) tags += '<i class="tag b5">黑五</i>';
  if (v.publicSolo && p.isDealer) tags += '<i class="tag solo">独庄</i>';
  if (p.isBot) tags += '<i class="tag bot">人机</i>';
  if (p.voice) tags += '<i class="tag voice">语音</i>';
  const meta = p.outRank
    ? `<span class="meta finish">${posName(p.outRank, v.n)}</span>`
    : `<span class="meta">${p.count} 张</span>`;
  const act = la
    ? (la.type === 'pass'
      ? `<span class="act pass">${la.timeout ? '超时过牌' : '过牌'}</span>`
      : `<span class="act">${la.timeout ? '超时出牌' : '已出牌'}</span>`)
    : '';
  return `<div class="${cls.join(' ')}">
    <button class="avatar" data-player-id="${esc(p.id)}" data-avatar-id="${esc(p.id)}" aria-label="向${esc(p.name)}使用道具" title="向${esc(p.name)}使用道具"><img src="${avatarSrc(p.avatar)}" alt=""></button>
    <div class="chip-main">
      <div class="cname">${esc(p.name)}${tags}</div>
      ${meta}${p.connected ? '' : '<span class="meta off-tag">离线</span>'}
      <div class="cact">${act}</div>
      <div class="cscore">积分 ${p.score}</div>
    </div>
  </div>`;
}

function avatarSrc(avatar) {
  const safe = /^[a-z0-9-]+$/.test(String(avatar || '')) ? avatar : 'bamboo';
  return `/avatars/${safe}.png`;
}

function propMenuHtml(v) {
  const target = v.players.find(player => player.id === socialTarget && !player.isMe);
  if (!target) return '';
  return `<div class="prop-menu" role="dialog" aria-label="互动道具">
    <span>送给 <b>${esc(target.name)}</b></span>
    <button data-act="interact" data-to="${esc(target.id)}" data-item="tomato">🍅 番茄</button>
    <button data-act="interact" data-to="${esc(target.id)}" data-item="bucket">🪣 水桶</button>
    <button class="icon-close" data-act="closeProp" aria-label="关闭" title="关闭">×</button>
  </div>`;
}

function chatHtml(v) {
  const messages = (v.chat || []).map(message => `
    <div class="chat-message${message.playerId === v.myId ? ' mine' : ''}${message.quick ? ' quick-message' : ''}">
      <b>${esc(message.name)}</b><span>${message.quick ? '🔊 ' : ''}${esc(message.text)}</span>
    </div>`).join('');
  const quick = QUICK_PHRASES.map(text => `<button data-act="quick" data-text="${esc(text)}">${esc(text)}</button>`).join('');
  return `<section class="chat-panel support-panel">
    <div class="chat-head"><b>房间聊天</b><div class="quick-phrases">${quick}</div></div>
    <div class="chat-messages">${messages || '<span class="chat-empty">还没有消息</span>'}</div>
    <div class="chat-compose">
      <input data-chat-input maxlength="80" value="${esc(chatDraft)}" placeholder="输入消息" autocomplete="off">
      <button class="primary" data-act="sendChat">发送</button>
    </div>
  </section>`;
}

function logHtml(v) {
  return `<details class="logbox support-panel" open>
    <summary>牌局记录</summary>
    <ul>${v.log.map(line => `<li>${esc(line)}</li>`).join('')}</ul>
  </details>`;
}

function turnClockHtml(v, mine) {
  if (v.phase !== 'playing' || !Number.isFinite(v.turnDeadline)) return '';
  return `<div class="turn-clock${mine ? ' mine' : ''}" data-turn-deadline="${v.turnDeadline}" data-turn-seconds="${v.turnSeconds || 20}" role="timer" aria-label="${mine ? '你的回合，出牌倒计时' : '对手回合，出牌倒计时'}">
    <strong class="turn-owner">${mine ? '你的回合' : '对手回合'}</strong>
    <span>20</span><small>秒</small>
  </div>`;
}

function handLayout(groupCount) {
  const viewport = Number(globalThis.innerWidth) || 390;
  if (viewport > 560) return { step: 70, width: 70, height: 100 };
  const available = Math.max(320, viewport - 14);
  const step = Math.max(29, Math.min(62, available / Math.max(1, groupCount)));
  return { step: Math.round(step * 10) / 10, width: Math.round(Math.max(46, Math.min(62, step + 10))), height: 88 };
}

function updateTurnClocks() {
  const serverNow = Date.now() + serverClockOffset;
  document.querySelectorAll('[data-turn-deadline]').forEach(clock => {
    const deadline = Number(clock.dataset.turnDeadline);
    const duration = Number(clock.dataset.turnSeconds || 20) * 1000;
    const remaining = Math.max(0, deadline - serverNow);
    const seconds = Math.ceil(remaining / 1000);
    clock.style.setProperty('--turn-angle', `${Math.max(0, Math.min(1, remaining / duration)) * 360}deg`);
    clock.classList.toggle('urgent', seconds <= 5);
    const number = clock.querySelector('span');
    if (number) number.textContent = String(seconds);
    clock.setAttribute('aria-label', `${clock.classList.contains('mine') ? '你的回合' : '对手回合'}，出牌倒计时 ${seconds} 秒`);
  });
}

export function showInteraction(event) {
  if (!event || event.id <= lastInteractionId) return;
  lastInteractionId = event.id;
  const findAvatar = id => [...document.querySelectorAll('[data-avatar-id]')]
    .find(element => element.dataset.avatarId === id);
  const source = findAvatar(event.fromId);
  const target = findAvatar(event.toId);
  if (!target) return;
  const sourceRect = source?.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const startX = sourceRect ? sourceRect.left + sourceRect.width / 2 : innerWidth / 2;
  const startY = sourceRect ? sourceRect.top + sourceRect.height / 2 : innerHeight - 80;
  const endX = targetRect.left + targetRect.width / 2;
  const endY = targetRect.top + targetRect.height / 2;
  const flight = document.createElement('div');
  flight.className = 'prop-flight';
  flight.textContent = event.item === 'tomato' ? '🍅' : '🪣';
  flight.style.left = `${startX}px`;
  flight.style.top = `${startY}px`;
  document.body.appendChild(flight);
  const animation = flight.animate([
    { transform: 'translate(-50%, -50%) scale(.65) rotate(0)' },
    { transform: `translate(calc(-50% + ${endX - startX}px), calc(-50% + ${endY - startY - 65}px)) scale(1.25) rotate(180deg)`, offset: .65 },
    { transform: `translate(calc(-50% + ${endX - startX}px), calc(-50% + ${endY - startY}px)) scale(.9) rotate(360deg)` },
  ], { duration: 900, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'forwards' });
  animation.onfinish = () => {
    flight.remove();
    const impact = document.createElement('div');
    impact.className = `prop-impact ${event.item}`;
    impact.textContent = event.item === 'tomato' ? '啪！' : '哗！';
    impact.style.left = `${endX}px`;
    impact.style.top = `${endY}px`;
    document.body.appendChild(impact);
    impact.addEventListener('animationend', () => impact.remove(), { once: true });
  };
}

function resultHtml(v) {
  const r = v.result;
  const rows = r.rows.map(x => `
    <tr>
      <td>${x.posName}</td><td>${esc(x.name)}</td><td>${x.team}</td>
      <td class="${x.delta > 0 ? 'plus' : x.delta < 0 ? 'minus' : ''}">${x.delta > 0 ? '+' : ''}${x.delta}</td>
      <td>${x.score}</td>
    </tr>`).join('');
  const win = r.zeroRound ? '双方名次相抵 · 平局 0 分' : r.winTeam === 'A' ? '庄家阵营获胜' : '闲家阵营获胜';
  const b5name = v.blackFiveSeat != null && v.players[v.blackFiveSeat] ? esc(v.players[v.blackFiveSeat].name) : '—';
  const btns = v.isHost
    ? '<button class="primary big" data-act="next">下一局</button><button data-act="lobby">返回大厅</button>'
    : '<p class="tip">等待房主开始下一局…</p>';
  return `<div class="overlay"><div class="panel">
    <h2>${win}${r.solo && !r.zeroRound ? '（独庄 ×2）' : ''}</h2>
    <p class="tip" style="text-align:center">本局黑五：${b5name}${r.solo ? '（庄家自持黑桃5，独庄）' : ''}</p>
    <table>
      <thead><tr><th>名次</th><th>玩家</th><th>阵营</th><th>本局</th><th>总分</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="actions">${btns}</div>
  </div></div>`;
}

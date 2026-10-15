// 牌型判定 / 比大小 / 出牌提示
// 牌力从小到大：4 6 7 8 9 10 J Q K A 2 3 5；同牌型的 5 可以压 5。
// 牌型：single 单张 | pair 对子 | triple 三张(炸弹) | quad 四张(轰牌)
//       straight 顺子(3张以上，5可有可无) | pairs 姊妹对(2组或3组)

import { STRAIGHT_ORDERS, SISTER_PAIR_ORDER, rankStrength } from './cards.js';

function sortRanks(ranks) {
  return ranks.sort((a, b) => rankStrength(a) - rankStrength(b));
}

const STRAIGHT_STRENGTHS = STRAIGHT_ORDERS.map(order => new Map(order.map((rank, index) => [rank, index])));
const STRAIGHT_STRENGTH = STRAIGHT_STRENGTHS[0];
const SISTER_PAIR_STRENGTH = new Map(SISTER_PAIR_ORDER.map((rank, index) => [rank, index]));

function sortByStrength(ranks, strength) {
  return ranks.sort((a, b) => (strength.get(a) ?? Infinity) - (strength.get(b) ?? Infinity));
}

function rankCanBeat(a, b) {
  return rankStrength(a) > rankStrength(b) || (a === 5 && b === 5);
}

function consecutive(ranks, strength) {
  if (ranks.some(rank => !strength.has(rank))) return false;
  for (let i = 1; i < ranks.length; i++) {
    if (strength.get(ranks[i]) !== strength.get(ranks[i - 1]) + 1) return false;
  }
  return true;
}

function straightRanksValid(ranks) {
  return STRAIGHT_STRENGTHS.some(strength => consecutive(ranks, strength));
}

export function classify(cards) {
  const n = cards.length;
  if (!n) return null;
  const ranks = sortRanks(cards.map(c => c.rank));
  const uniq = [...new Set(ranks)];

  if (n === 1) return { kind: 'single', rank: ranks[0], len: 1 };

  if (uniq.length === 1) {
    if (n === 2) return { kind: 'pair', rank: ranks[0], len: 2 };
    if (n === 3) return { kind: 'triple', rank: ranks[0], len: 3 };
    if (n === 4) return { kind: 'quad', rank: ranks[0], len: 4 };
    return null;
  }

  const straightRanks = sortByStrength([...uniq], STRAIGHT_STRENGTH);
  if (n >= 3 && uniq.length === n && straightRanksValid(straightRanks)) {
    return { kind: 'straight', rank: straightRanks[straightRanks.length - 1], len: n };
  }

  if (n === 4 || n === 6) {
    const count = new Map();
    for (const rank of ranks) count.set(rank, (count.get(rank) || 0) + 1);
    const pairRanks = sortByStrength([...count.keys()], SISTER_PAIR_STRENGTH);
    if ([...count.values()].every(value => value === 2) && consecutive(pairRanks, SISTER_PAIR_STRENGTH)) {
      return { kind: 'pairs', rank: pairRanks[pairRanks.length - 1], len: n };
    }
  }
  return null;
}

export function bombLevel(combo) {
  if (combo.kind === 'quad') return 2;
  if (combo.kind === 'triple') return 1;
  return 0;
}

export function canBeat(a, b) {
  if (!b) return true;
  const aBomb = bombLevel(a), bBomb = bombLevel(b);
  if (aBomb !== bBomb) return aBomb > bBomb;
  if (a.kind !== b.kind || a.len !== b.len) return false;
  if (a.kind === 'straight') return STRAIGHT_STRENGTH.get(a.rank) > STRAIGHT_STRENGTH.get(b.rank);
  if (a.kind === 'pairs') return SISTER_PAIR_STRENGTH.get(a.rank) > SISTER_PAIR_STRENGTH.get(b.rank);
  return rankCanBeat(a.rank, b.rank);
}

export function comboName(combo) {
  switch (combo.kind) {
    case 'single': return '单张';
    case 'pair': return '对子';
    case 'triple': return '三张(炸弹)';
    case 'quad': return '四张(轰牌)';
    case 'straight': return `${combo.len}张顺子`;
    case 'pairs': return `${combo.len / 2}组姊妹对`;
    default: return '';
  }
}

export function posName(pos, n) {
  if (pos === 1) return '头科';
  if (pos === n) return '大落';
  return ['一', '二', '三', '四', '五', '六'][pos - 1] + '科';
}

export function findHint(hand, combo) {
  const byRank = new Map();
  for (const card of hand) {
    if (!byRank.has(card.rank)) byRank.set(card.rank, []);
    byRank.get(card.rank).push(card);
  }
  const groups = [...byRank.entries()].sort((a, b) => rankStrength(a[0]) - rankStrength(b[0]));
  if (!groups.length) return null;
  if (!combo) return [groups[0][1][0]];

  switch (combo.kind) {
    case 'single': {
      const group = groups.find(([rank]) => rankCanBeat(rank, combo.rank));
      if (group) return [group[1][0]];
      break;
    }
    case 'pair':
    case 'triple':
    case 'quad': {
      const need = combo.kind === 'pair' ? 2 : combo.kind === 'triple' ? 3 : 4;
      const group = groups.find(([rank, cards]) => cards.length >= need && rankCanBeat(rank, combo.rank));
      if (group) return group[1].slice(0, need);
      break;
    }
    case 'straight': {
      const result = findStraight(byRank, combo);
      if (result) return result;
      break;
    }
    case 'pairs': {
      const result = findSequence(byRank, SISTER_PAIR_ORDER, combo.len / 2, 2, combo);
      if (result) return result;
      break;
    }
  }

  if (bombLevel(combo) < 1) {
    const group = groups.find(([, cards]) => cards.length >= 3);
    if (group) return group[1].slice(0, 3);
  }
  if (bombLevel(combo) < 2) {
    const group = groups.find(([, cards]) => cards.length >= 4);
    if (group) return group[1].slice(0, 4);
  }
  return null;
}

function findStraight(byRank, combo) {
  const candidates = [];
  const seen = new Set();
  for (const order of STRAIGHT_ORDERS) {
    for (let start = 0; start + combo.len <= order.length; start++) {
      const ranks = order.slice(start, start + combo.len);
      const key = ranks.join(',');
      if (seen.has(key) || !ranks.every(rank => (byRank.get(rank) || []).length)) continue;
      seen.add(key);
      const rank = sortByStrength([...ranks], STRAIGHT_STRENGTH).at(-1);
      const candidate = { kind: 'straight', rank, len: combo.len };
      if (!canBeat(candidate, combo)) continue;
      candidates.push({
        ranks,
        rank,
        usesFive: ranks.includes(5),
        cards: ranks.map(candidateRank => byRank.get(candidateRank)[0]),
      });
    }
  }
  candidates.sort((a, b) => STRAIGHT_STRENGTH.get(a.rank) - STRAIGHT_STRENGTH.get(b.rank)
    || Number(a.usesFive) - Number(b.usesFive));
  return candidates[0]?.cards || null;
}

function findSequence(byRank, order, rankCount, cardsPerRank, combo) {
  for (let start = 0; start + rankCount <= order.length; start++) {
    const ranks = order.slice(start, start + rankCount);
    if (!ranks.every(rank => (byRank.get(rank) || []).length >= cardsPerRank)) continue;
    const candidate = { kind: combo.kind, rank: ranks[ranks.length - 1], len: combo.len };
    if (!canBeat(candidate, combo)) continue;
    return ranks.flatMap(rank => byRank.get(rank).slice(0, cardsPerRank));
  }
  return null;
}

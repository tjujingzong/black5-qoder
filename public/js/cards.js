// 牌的基础定义：一副标准牌去掉大小王，共 52 张
// 点数编码保持 3~10 原值，J=11 Q=12 K=13 A=14 2=15；牌力使用下方自定义顺序。
// 花色编码：0=♠ 1=♥ 2=♣ 3=♦

export const SUITS = ['♠', '♥', '♣', '♦'];
export const BLACK5_ID = '0-5'; // 黑桃5 —— 决定"黑五"身份的关键牌
export const RANK_ORDER = [4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 3, 5];
// 顺子可经过或跳过 5；姊妹对只能使用 4、6 到 A。
export const STRAIGHT_ORDERS = [
  [15, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  [15, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  // 特殊边界顺子：A-2-3 合法，但不延伸为 K-A-2。
  [15, 3, 14],
];
export const SISTER_PAIR_ORDER = [4, 6, 7, 8, 9, 10, 11, 12, 13, 14];

const RANK_STRENGTH = new Map(RANK_ORDER.map((rank, index) => [rank, index]));

const FACE = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2' };

export function rankChar(r) {
  return r <= 10 ? String(r) : FACE[r];
}

export function rankStrength(rank) {
  return RANK_STRENGTH.get(rank) ?? -1;
}

export function makeDeck() {
  const deck = [];
  for (let suit = 0; suit < 4; suit++) {
    for (let rank = 3; rank <= 15; rank++) {
      deck.push({ id: `${suit}-${rank}`, suit, rank });
    }
  }
  return deck;
}

export function cardLabel(c) {
  return SUITS[c.suit] + rankChar(c.rank);
}

export function isRed(c) {
  return c.suit === 1 || c.suit === 3;
}

export function sortHand(hand) {
  hand.sort((a, b) => rankStrength(a.rank) - rankStrength(b.rank) || a.suit - b.suit);
}

// Fisher–Yates 洗牌
export function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

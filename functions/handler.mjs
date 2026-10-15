// 游戏服务处理器：房间创建、动作处理、状态轮询。
// 替代 Cloudflare Durable Objects，使用 Supabase 持久化 + HTTP 轮询。

import { Game } from "./engine/engine.js";

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 5;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_PLAYERS = 6;

const json = (body, status = 200) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

function generateCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) code += CODE_CHARS[byte % CODE_CHARS.length];
  return code;
}

function validCode(code) {
  return new RegExp(`^[${CODE_CHARS}]{${CODE_LENGTH}}$`).test(code);
}

function restoreGame(saved) {
  if (!saved) return null;
  const game = new Game();
  Object.assign(game, saved);
  return game.normalize();
}

// 解析路径：提取 Function 逻辑子路径
// 网关可能将 /functions/v1/app/rooms 重写为 /app-<id>/rooms
function getAppPath(requestUrl) {
  const url = new URL(requestUrl);
  const pathname = url.pathname;

  // 格式 1: /functions/v1/<name>/<subpath>
  const logicalMatch = pathname.match(/\/functions\/v1\/[^/]+(\/.*)?$/);
  if (logicalMatch) return logicalMatch[1] || "/";

  // 格式 2: /app-<hex-id>/<subpath> (网关重写后)
  const rewrittenMatch = pathname.match(/^\/app-[a-f0-9]+(\/.*)?$/);
  if (rewrittenMatch) return rewrittenMatch[1] || "/";

  return pathname;
}

export async function handleGame({ request, supabase }) {
  const url = new URL(request.url);
  const method = request.method;
  const path = getAppPath(request.url);

  // POST /rooms - 创建房间
  if (path === "/rooms" && method === "POST") {
    return handleCreateRoom(request, supabase);
  }

  // GET /rooms/{code}/state - 轮询状态
  const stateMatch = path.match(/^\/rooms\/([A-Z2-9]{5})\/state$/);
  if (stateMatch && method === "GET") {
    const code = stateMatch[1];
    if (!validCode(code)) return json({ error: "房间号无效" }, 400);
    const token = url.searchParams.get("token");
    return handleGetState(code, token, supabase);
  }

  // POST /rooms/{code}/action - 提交动作
  const actionMatch = path.match(/^\/rooms\/([A-Z2-9]{5})\/action$/);
  if (actionMatch && method === "POST") {
    const code = actionMatch[1];
    if (!validCode(code)) return json({ error: "房间号无效" }, 400);
    return handleAction(code, request, supabase);
  }

  // POST /rooms/{code}/join - 加入房间（首次/重连）
  const joinMatch = path.match(/^\/rooms\/([A-Z2-9]{5})\/join$/);
  if (joinMatch && method === "POST") {
    const code = joinMatch[1];
    if (!validCode(code)) return json({ error: "房间号无效" }, 400);
    return handleJoin(code, request, supabase);
  }

  // POST /rooms/{code}/voice - 上传一个语音片段（服务器中转）
  const voiceMatch = path.match(/^\/rooms\/([A-Z2-9]{5})\/voice$/);
  if (voiceMatch && method === "POST") {
    const code = voiceMatch[1];
    if (!validCode(code)) return json({ error: "房间号无效" }, 400);
    return handleVoicePush(code, request, supabase);
  }
  if (voiceMatch && method === "GET") {
    const code = voiceMatch[1];
    if (!validCode(code)) return json({ error: "房间号无效" }, 400);
    const token = url.searchParams.get("token");
    const since = url.searchParams.get("since") || "0";
    return handleVoicePull(code, token, since, supabase);
  }

  return json({ error: "接口不存在" }, 404);
}

// ─── 创建房间 ───

async function handleCreateRoom(request, supabase) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "请求内容无效" }, 400);
  }
  const name = String(body?.name || "").trim().slice(0, 8);
  if (!name) return json({ error: "请先输入昵称" }, 400);

  // 清理过期房间
  await cleanupExpiredRooms(supabase);

  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateCode();

    // 检查房间是否已存在
    const { data: existing } = await supabase
      .from("rooms")
      .select("code")
      .eq("code", code)
      .maybeSingle();

    if (existing) continue;

    // 创建新游戏
    const game = new Game();
    const result = game.join(name);
    result.player.connected = false;

    const now = Date.now();
    const roomData = {
      code,
      game_state: JSON.parse(JSON.stringify(game)),
      seq: 1,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + ROOM_TTL_MS).toISOString(),
    };

    const { error } = await supabase.from("rooms").insert(roomData);
    if (error) {
      if (error.code === "23505") continue; // 唯一约束冲突，重试
      return json({ error: "创建房间失败" }, 502);
    }

    return json({ code, token: result.player.id }, 201);
  }

  return json({ error: "房间号生成失败，请重试" }, 503);
}

// ─── 加入房间 ───

async function handleJoin(code, request, supabase) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "请求内容无效" }, 400);
  }
  const name = String(body?.name || "").trim().slice(0, 8);
  if (!name) return json({ error: "请先输入昵称" }, 400);
  const token = body?.token || null;

  const room = await loadRoom(code, supabase);
  if (!room) return json({ error: "找不到房间，请检查房间号" }, 404);

  const game = restoreGame(room.game_state);
  if (!game) return json({ error: "房间已失效" }, 404);

  const result = game.join(name, token);
  if (result.error) return json({ error: result.error }, 403);

  // 保存状态
  const newSeq = room.seq + 1;
  const now = Date.now();
  const { error } = await supabase
    .from("rooms")
    .update({
      game_state: JSON.parse(JSON.stringify(game)),
      seq: newSeq,
      expires_at: new Date(now + ROOM_TTL_MS).toISOString(),
    })
    .eq("code", code);

  if (error) return json({ error: "加入失败" }, 502);

  return json({ token: result.player.id, seq: newSeq }, 200);
}

// ─── 获取状态（轮询） ───

async function handleGetState(code, token, supabase) {
  if (!token) return json({ error: "缺少身份令牌" }, 400);

  const room = await loadRoom(code, supabase);
  if (!room) return json({ error: "找不到房间" }, 404);

  const game = restoreGame(room.game_state);
  if (!game) return json({ error: "房间已失效" }, 404);

  // 查找玩家
  const player = game.players.find((p) => p.id === token);
  if (!player) return json({ error: "你不在房间中" }, 403);

  // 标记为在线
  player.connected = true;

  // 返回个性化视图
  const view = game.viewFor(token);
  view.seq = room.seq;

  return json({ view }, 200);
}

// ─── 提交动作 ───

async function handleAction(code, request, supabase) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "请求内容无效" }, 400);
  }

  const token = body?.token;
  if (!token) return json({ error: "缺少身份令牌" }, 400);

  const action = body?.action;
  if (!action || !action.t) return json({ error: "缺少动作" }, 400);

  // 加载房间
  const room = await loadRoom(code, supabase);
  if (!room) return json({ error: "找不到房间" }, 404);

  const game = restoreGame(room.game_state);
  if (!game) return json({ error: "房间已失效" }, 404);

  // 验证玩家身份
  const player = game.players.find((p) => p.id === token);
  if (!player) return json({ error: "你不在房间中" }, 403);

  // 处理超时回合
  game.timeoutTurn();

  // 处理玩家动作
  const error = game.handleMsg(token, action);
  if (error) return json({ error }, 400);

  // 驱动人机
  await runBots(game);

  // 保存状态
  const newSeq = room.seq + 1;
  const now = Date.now();
  const { error: dbError } = await supabase
    .from("rooms")
    .update({
      game_state: JSON.parse(JSON.stringify(game)),
      seq: newSeq,
      expires_at: new Date(now + ROOM_TTL_MS).toISOString(),
    })
    .eq("code", code);

  if (dbError) return json({ error: "保存状态失败" }, 502);

  // 返回更新后的视图
  const view = game.viewFor(token);
  view.seq = newSeq;

  return json({ view }, 200);
}

// ─── 人机驱动 ───

async function runBots(game) {
  let iterations = 0;
  const maxIterations = 50; // 防止无限循环

  while (
    game.phase === "playing" &&
    iterations < maxIterations
  ) {
    const player = game.players[game.turn];
    if (!player || !player.isBot) break;

    // 处理超时
    game.timeoutTurn();

    // 人机出牌
    if (!game.actBot()) break;

    iterations++;
  }
}

// ─── 数据库操作 ───

async function loadRoom(code, supabase) {
  const { data, error } = await supabase
    .from("rooms")
    .select("*")
    .eq("code", code)
    .maybeSingle();

  if (error || !data) return null;

  // 检查是否过期
  const expiresAt = new Date(data.expires_at).getTime();
  if (Date.now() > expiresAt) {
    await supabase.from("rooms").delete().eq("code", code);
    return null;
  }

  return data;
}

async function cleanupExpiredRooms(supabase) {
  const now = new Date().toISOString();
  await supabase.from("rooms").delete().lt("expires_at", now);
}

// ─── 语音中转（片段存于 game_state.voiceRing，仅这两个接口读写） ───

async function handleVoicePush(code, request, supabase) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "请求内容无效" }, 400);
  }
  const token = body?.token;
  if (!token) return json({ error: "缺少身份令牌" }, 400);
  const data = String(body?.data || "");
  if (!data) return json({ error: "语音内容为空" }, 400);
  // 约 400KB base64 上限，防滥用
  if (data.length > 400000) return json({ error: "语音片段过长" }, 413);

  const room = await loadRoom(code, supabase);
  if (!room) return json({ error: "找不到房间" }, 404);
  const game = restoreGame(room.game_state);
  if (!game) return json({ error: "房间已失效" }, 404);
  const player = game.players.find((p) => p.id === token);
  if (!player || player.isBot) return json({ error: "你不在房间中" }, 403);

  const clip = game.pushVoice(player.publicId, body?.mime, data);

  const now = Date.now();
  const { error: dbError } = await supabase
    .from("rooms")
    .update({
      game_state: JSON.parse(JSON.stringify(game)),
      expires_at: new Date(now + ROOM_TTL_MS).toISOString(),
    })
    .eq("code", code);
  if (dbError) return json({ error: "保存语音失败" }, 502);

  return json({ ok: true, seq: clip.seq }, 200);
}

async function handleVoicePull(code, token, since, supabase) {
  if (!token) return json({ error: "缺少身份令牌" }, 400);
  const room = await loadRoom(code, supabase);
  if (!room) return json({ error: "找不到房间" }, 404);
  const game = restoreGame(room.game_state);
  if (!game) return json({ error: "房间已失效" }, 404);
  const player = game.players.find((p) => p.id === token);
  if (!player) return json({ error: "你不在房间中" }, 403);

  const { clips, cursor } = game.takeVoiceSince(player.publicId, since);
  return json({ clips, cursor }, 200);
}

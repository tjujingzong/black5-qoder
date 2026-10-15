// 本地开发服务器：静态文件 + 游戏 API（内存存储，无需 Supabase）。
// 运行：node dev/local-server.mjs
// 访问：http://localhost:3000

import { Game } from "../functions/engine/engine.js";
import { readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(__dirname, "../public");

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 5;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;

// 内存存储
const rooms = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

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

function jsonResponse(res, body, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(body));
}

function getAppPath(url) {
  const parsedUrl = new URL(url, "http://localhost");
  const match = parsedUrl.pathname.match(/\/functions\/v1\/app(\/.*)?$/);
  return match ? match[1] || "/" : null;
}

async function handleCreateRoom(req, res) {
  let body;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return jsonResponse(res, { error: "请求内容无效" }, 400);
  }
  const name = String(body?.name || "").trim().slice(0, 8);
  if (!name) return jsonResponse(res, { error: "请先输入昵称" }, 400);

  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateCode();
    if (rooms.has(code)) continue;

    const game = new Game();
    const result = game.join(name);
    result.player.connected = false;

    const now = Date.now();
    rooms.set(code, {
      code,
      game,
      seq: 1,
      createdAt: now,
      expiresAt: now + ROOM_TTL_MS,
    });

    return jsonResponse(res, { code, token: result.player.id }, 201);
  }

  return jsonResponse(res, { error: "房间号生成失败，请重试" }, 503);
}

async function handleJoin(code, req, res) {
  let body;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return jsonResponse(res, { error: "请求内容无效" }, 400);
  }
  const name = String(body?.name || "").trim().slice(0, 8);
  if (!name) return jsonResponse(res, { error: "请先输入昵称" }, 400);
  const token = body?.token || null;

  const room = rooms.get(code);
  if (!room || Date.now() > room.expiresAt) {
    rooms.delete(code);
    return jsonResponse(res, { error: "找不到房间" }, 404);
  }

  const result = room.game.join(name, token);
  if (result.error) return jsonResponse(res, { error: result.error }, 403);

  room.seq++;
  room.expiresAt = Date.now() + ROOM_TTL_MS;

  return jsonResponse(res, { token: result.player.id, seq: room.seq });
}

async function handleGetState(code, token, res) {
  if (!token) return jsonResponse(res, { error: "缺少身份令牌" }, 400);

  const room = rooms.get(code);
  if (!room || Date.now() > room.expiresAt) {
    rooms.delete(code);
    return jsonResponse(res, { error: "找不到房间" }, 404);
  }

  const player = room.game.players.find((p) => p.id === token);
  if (!player) return jsonResponse(res, { error: "你不在房间中" }, 403);

  player.connected = true;
  const view = room.game.viewFor(token);
  view.seq = room.seq;

  return jsonResponse(res, { view });
}

async function handleAction(code, req, res) {
  let body;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return jsonResponse(res, { error: "请求内容无效" }, 400);
  }

  const token = body?.token;
  if (!token) return jsonResponse(res, { error: "缺少身份令牌" }, 400);

  const action = body?.action;
  if (!action || !action.t) return jsonResponse(res, { error: "缺少动作" }, 400);

  const room = rooms.get(code);
  if (!room || Date.now() > room.expiresAt) {
    rooms.delete(code);
    return jsonResponse(res, { error: "找不到房间" }, 404);
  }

  const player = room.game.players.find((p) => p.id === token);
  if (!player) return jsonResponse(res, { error: "你不在房间中" }, 403);

  room.game.timeoutTurn();
  const error = room.game.handleMsg(token, action);
  if (error) return jsonResponse(res, { error }, 400);

  // 驱动人机
  let iterations = 0;
  while (room.game.phase === "playing" && iterations < 50) {
    const p = room.game.players[room.game.turn];
    if (!p || !p.isBot) break;
    room.game.timeoutTurn();
    if (!room.game.actBot()) break;
    iterations++;
  }

  room.seq++;
  room.expiresAt = Date.now() + ROOM_TTL_MS;

  const view = room.game.viewFor(token);
  view.seq = room.seq;

  return jsonResponse(res, { view });
}

async function handleFunction(req, res, url) {
  const method = req.method;
  const path = getAppPath(url);

  if (!path) return false;

  if (path === "/rooms" && method === "POST") {
    await handleCreateRoom(req, res);
    return true;
  }

  const stateMatch = path.match(/^\/rooms\/([A-Z2-9]{5})\/state$/);
  if (stateMatch && method === "GET") {
    const code = stateMatch[1];
    if (!validCode(code)) return jsonResponse(res, { error: "房间号无效" }, 400), true;
    const parsedUrl = new URL(url, "http://localhost");
    const token = parsedUrl.searchParams.get("token");
    await handleGetState(code, token, res);
    return true;
  }

  const actionMatch = path.match(/^\/rooms\/([A-Z2-9]{5})\/action$/);
  if (actionMatch && method === "POST") {
    const code = actionMatch[1];
    if (!validCode(code)) return jsonResponse(res, { error: "房间号无效" }, 400), true;
    await handleAction(code, req, res);
    return true;
  }

  const joinMatch = path.match(/^\/rooms\/([A-Z2-9]{5})\/join$/);
  if (joinMatch && method === "POST") {
    const code = joinMatch[1];
    if (!validCode(code)) return jsonResponse(res, { error: "房间号无效" }, 400), true;
    await handleJoin(code, req, res);
    return true;
  }

  return jsonResponse(res, { error: "接口不存在" }, 404), true;
}

function serveStaticFile(res, pathname) {
  let filePath = join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname);
  try {
    const content = readFileSync(filePath);
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

// 清理过期房间
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now > room.expiresAt) rooms.delete(code);
  }
}, 60000);

// 启动服务器
const port = parseInt(process.env.PORT || "3000");
console.log(`本地开发服务器：http://localhost:${port}`);
console.log("按 Ctrl+C 停止");

createServer(async (req, res) => {
  const url = req.url || "/";

  // CORS
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  // 函数路由
  if (url.startsWith("/functions/v1/app")) {
    const handled = await handleFunction(req, res, url);
    if (handled) return;
  }

  // 静态文件
  const parsedUrl = new URL(url, "http://localhost");
  if (serveStaticFile(res, parsedUrl.pathname)) return;

  // 404
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
}).listen(port, "localhost");

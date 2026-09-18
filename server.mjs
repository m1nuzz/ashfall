import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { serveStatic } from "./static-server.mjs";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { BOARD_META, createProfileStore, normalizeName } from "./profile-store.mjs";

const DT = 1 / 30;
const TAU = Math.PI * 2;
const SPELLS = Object.freeze({
  fireball: { speed: 42, damage: 10, kb: 9, cd: 0.55, radius: 0.6 },
  lightning: { damage: 10, kb: 20, cd: 4 },
  homing: { speed: 20, damage: 8, kb: 11, cd: 3, radius: 0.6 },
  meteor: { speed: 26, damage: 16, kb: 24, cd: 6, radius: 1.1 },
  shield: { cd: 8 },
  blink: { cd: 5 },
});
const FIELDS = {
  create: ["type", "name"],
  join: ["type", "code", "name"],
  start: ["type"],
  ready: ["type", "ready"],
  authenticate: ["type", "token"],
  input: ["type", "forward", "right", "yaw", "pitch", "jump"],
  cast: ["type", "spell"],
  leave: ["type"],
  buy: ["type", "spell"],
};

function makeCode() {
  let code = "";
  while (code.length < 6) {
    for (const byte of randomBytes(12)) {
      if (byte < 234) code += String.fromCharCode(65 + byte % 26);
      if (code.length === 6) break;
    }
  }
  return code;
}

function normalize(x, y, z) {
  const length = Math.hypot(x, y, z);
  return length > 1e-9 ? { x: x / length, y: y / length, z: z / length } : { x: 0, y: 0, z: -1 };
}

function direction(player) {
  return {
    x: -Math.sin(player.yaw) * Math.cos(player.pitch),
    y: Math.sin(player.pitch),
    z: -Math.cos(player.yaw) * Math.cos(player.pitch),
  };
}

function makePlayer(peer, angle = 0) {
  return {
    id: peer.id, name: peer.name, ready: peer.ready, profileId: peer.profileId,
    gold: peer.gold ?? 8, wins: peer.wins ?? 0, levels: { ...peer.levels },
    skin: peer.skin, nameColor: peer.nameColor, rewardRank: peer.rewardRank,
    x: Math.sin(angle) * 18, y: 0, z: Math.cos(angle) * 18,
    yaw: angle, pitch: 0, hp: 100, damage: 0, alive: true,
    shieldUntil: 0, cooldowns: {}, staggerUntil: 0,
    vx: 0, vy: 0, vz: 0, mx: 0, mz: 0, grounded: true,
    input: { forward: 0, right: 0, jump: false }, inputAt: -1,
  };
}

function validMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  if (typeof message.type !== "string" || !Object.hasOwn(FIELDS, message.type)) return false;
  const fields = FIELDS[message.type];
  if (Object.keys(message).length !== fields.length || !fields.every((field) => Object.hasOwn(message, field))) return false;
  if (message.type === "create" || message.type === "join") {
    if (!normalizeName(message.name)) return false;
  }
  if (message.type === "join" && (typeof message.code !== "string" || !/^[A-Z]{6}$/u.test(message.code))) return false;
  if (message.type === "ready" && typeof message.ready !== "boolean") return false;
  if (message.type === "authenticate" && typeof message.token !== "string") return false;
  if (["cast", "buy"].includes(message.type) && (typeof message.spell !== "string" || !Object.hasOwn(SPELLS, message.spell))) return false;
  if (message.type === "input") {
    if (![message.forward, message.right, message.yaw, message.pitch].every(Number.isFinite)) return false;
    if (Math.abs(message.forward) > 1 || Math.abs(message.right) > 1 || typeof message.jump !== "boolean") return false;
  }
  return true;
}

function firstHit(room, from, to, owner, radius) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const a = dx * dx + dy * dy + dz * dz;
  let best = null;
  for (const player of room.players.values()) {
    if (!player.alive || player.id === owner) continue;
    const ox = from.x - player.x;
    const oy = from.y - player.y - 1;
    const oz = from.z - player.z;
    const c = ox * ox + oy * oy + oz * oz - (1 + radius) ** 2;
    let t = 0;
    if (c > 0) {
      if (a < 1e-12) continue;
      const b = ox * dx + oy * dy + oz * dz;
      const discriminant = b * b - a * c;
      if (discriminant < 0) continue;
      t = (-b - Math.sqrt(discriminant)) / a;
      if (t < 0 || t > 1) continue;
    }
    if (!best || t < best.t) best = { player, t };
  }
  return best;
}

function hurt(room, player, amount, kb = 0, aim = null) {
  if (!player.alive || (kb && room.time < player.shieldUntil)) return;
  player.hp = Math.max(0, player.hp - amount);
  player.damage += amount;
  if (kb && aim) {
    const force = kb * (1 + player.damage * 0.012);
    player.vx += aim.x * force;
    player.vz += aim.z * force;
    player.vy += Math.max(0, aim.y * force * 0.35) + force * 0.1;
    player.staggerUntil = room.time + 0.65;
    player.grounded = false;
  }
  if (player.hp === 0) player.alive = false;
}

function movePlayer(room, player) {
  const input = room.time - player.inputAt <= 0.5 ? player.input : { forward: 0, right: 0, jump: false };
  const staggered = room.time < player.staggerUntil;
  const length = Math.max(1, Math.hypot(input.forward, input.right));
  const speed = staggered ? 0 : 14 / length;
  const wishX = (-Math.sin(player.yaw) * input.forward + Math.cos(player.yaw) * input.right) * speed;
  const wishZ = (-Math.cos(player.yaw) * input.forward - Math.sin(player.yaw) * input.right) * speed;
  const blend = 1 - Math.exp(-8.5 * DT);
  player.mx += (wishX - player.mx) * blend;
  player.mz += (wishZ - player.mz) * blend;
  if (input.jump && player.grounded) {
    player.vy = 9;
    player.grounded = false;
  }
  player.vy -= 26 * DT;
  player.x += (player.mx + player.vx) * DT;
  player.y += player.vy * DT;
  player.z += (player.mz + player.vz) * DT;
  const floor = Math.hypot(player.x, player.z) < room.radius - 0.55 ? 0 : -2.5;
  player.grounded = player.y <= floor;
  if (player.grounded) {
    player.y = floor;
    player.vy = Math.max(0, player.vy);
    if (floor === -2.5) hurt(room, player, 30 * DT);
  }
  const damping = Math.exp(-(staggered ? 1.8 : 8.5) * DT);
  player.vx *= damping;
  player.vz *= damping;
}

function moveProjectiles(room) {
  room.projectiles = room.projectiles.filter((projectile) => {
    if (room.time - projectile.born >= 4) return false;
    const spec = SPELLS[projectile.spell];
    if (projectile.spell === "homing") {
      let target = null;
      let distance = Infinity;
      for (const player of room.players.values()) {
        if (!player.alive || player.id === projectile.owner) continue;
        const d = Math.hypot(player.x - projectile.x, player.y + 1 - projectile.y, player.z - projectile.z);
        if (d < distance) { target = player; distance = d; }
      }
      if (target) {
        const want = normalize(target.x - projectile.x, target.y + 1 - projectile.y, target.z - projectile.z);
        const blend = 1 - Math.exp(-3.5 * DT);
        const aim = normalize(
          projectile.vx / spec.speed * (1 - blend) + want.x * blend,
          projectile.vy / spec.speed * (1 - blend) + want.y * blend,
          projectile.vz / spec.speed * (1 - blend) + want.z * blend,
        );
        projectile.vx = aim.x * spec.speed;
        projectile.vy = aim.y * spec.speed;
        projectile.vz = aim.z * spec.speed;
      }
    }
    const end = { x: projectile.x + projectile.vx * DT, y: projectile.y + projectile.vy * DT, z: projectile.z + projectile.vz * DT };
    const hit = firstHit(room, projectile, end, projectile.owner, spec.radius);
    if (hit) {
      const target = hit.player;
      if (room.time < target.shieldUntil) {
        const previousOwner = room.players.get(projectile.owner);
        const aim = previousOwner
          ? normalize(previousOwner.x - target.x, previousOwner.y - target.y, previousOwner.z - target.z)
          : normalize(-projectile.vx, -projectile.vy, -projectile.vz);
        projectile.owner = target.id;
        projectile.x = target.x + aim.x * (1 + spec.radius + 0.05);
        projectile.y = target.y + 1 + aim.y * (1 + spec.radius + 0.05);
        projectile.z = target.z + aim.z * (1 + spec.radius + 0.05);
        projectile.vx = aim.x * spec.speed;
        projectile.vy = aim.y * spec.speed;
        projectile.vz = aim.z * spec.speed;
        return true;
      }
      hurt(room, target, projectile.damage ?? spec.damage, projectile.kb ?? spec.kb, normalize(projectile.vx, projectile.vy, projectile.vz));
      return false;
    }
    Object.assign(projectile, end);
    return projectile.y >= -2.5;
  });
}

export function createGameServer({
  port = 3001, host = "127.0.0.1", countdownSeconds = 8, store = null, dataPath = null,
  staticDir = null, reconnectSeconds = 20, origins = [], now = () => Date.now(), minMatchSeconds = 30, scoredGamesPerWeek = 20,
} = {}) {
  if (!Number.isFinite(countdownSeconds) || countdownSeconds <= 0) throw new TypeError("Invalid countdownSeconds");
  if (!Array.isArray(origins) || origins.some((origin) => typeof origin !== "string" || new URL(origin).origin !== origin)) throw new TypeError("Invalid origins");
  const ownStore = !store;
  const profileStore = store ?? createProfileStore({ dataPath, now, minMatchSeconds, scoredGamesPerWeek });
  const rooms = new Map();
  const httpServer = createServer((request, response) => {
    void handleHttp(request, response).catch(() => {
      if (!response.headersSent && !response.destroyed) sendJson(request, response, 500, { error: "internal-error" });
      else response.destroy();
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  httpServer.on("upgrade", (request, socket, head) => {
    if (closing || request.url !== "/ws" || !allowedOrigin(request.headers.origin, request)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });
  const apiTokens = new Map();
  let closing = false;
  let closePromise;

  function allowedOrigin(origin, request) {
    if (!origin) return true;
    if (origins.length) return origins.includes(origin);
    return origin === `${request.socket.encrypted ? "https" : "http"}://${request.headers.host ?? ""}`;
  }

  function corsHeaders(request) {
    const headers = { "Content-Type": "application/json; charset=utf-8", Vary: "Origin", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    const origin = request.headers.origin;
    if (origin && allowedOrigin(origin, request)) headers["Access-Control-Allow-Origin"] = origin;
    return headers;
  }

  function sendJson(request, response, status, body) {
    if (response.destroyed) return;
    const headers = corsHeaders(request);
    if (status === 429) headers["Retry-After"] = "1";
    response.writeHead(status, headers);
    response.end(JSON.stringify({ ...body, meta: BOARD_META }));
  }

  function allowApi(request) {
    const timestamp = performance.now();
    const key = request.socket.remoteAddress ?? "unknown";
    for (const [address, bucket] of apiTokens) {
      if (timestamp - bucket.refill > 60000) apiTokens.delete(address);
    }
    let bucket = apiTokens.get(key);
    if (!bucket) {
      if (apiTokens.size >= 10000) return false;
      bucket = { tokens: 60, refill: timestamp };
      apiTokens.set(key, bucket);
    }
    bucket.tokens = Math.min(60, bucket.tokens + (timestamp - bucket.refill) / 1000);
    bucket.refill = timestamp;
    if (bucket.tokens < 1) return false;
    bucket.tokens--;
    return true;
  }

  function readBody(request, limit = 4096) {
    return new Promise((resolveBody, rejectBody) => {
      const chunks = [];
      let size = 0;
      request.on("data", (chunk) => {
        size += chunk.length;
        if (size > limit) {
          rejectBody(new Error("payload-too-large"));
          chunks.length = 0;
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
      request.on("error", rejectBody);
    });
  }

  function publicProfile(profile) {
    return {
      profileId: profile.profileId,
      name: profile.name,
      skin: profile.skin,
      nameColor: profile.nameColor,
      rewardRank: profile.rewardRank,
      rewards: profile.rewards, claimedSkin: profile.claimedSkin, standing: profile.standing,
    };
  }

  async function handleHttp(request, response) {
    const url = new URL(request.url, "http://localhost");
    if (!url.pathname.startsWith("/api/")) {
      if (staticDir && await serveStatic(request, response, staticDir)) return;
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("Not found");
      return;
    }
    const origin = request.headers.origin;
    if (!allowedOrigin(origin, request)) {
      sendJson(request, response, 403, { error: "origin-not-allowed" });
      return;
    }
    if (!allowApi(request)) {
      request.resume();
      sendJson(request, response, 429, { error: "rate-limit" });
      return;
    }
    if (request.method === "OPTIONS") {
      const headers = corsHeaders(request);
      headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Content-Type";
      response.writeHead(204, headers);
      response.end();
      return;
    }
    if (url.pathname === "/api/profile" && request.method === "POST") {
      let body;
      try {
        body = await readBody(request);
      } catch (error) {
        if (error.message === "payload-too-large") {
          sendJson(request, response, 413, { error: "payload-too-large" });
          return;
        }
        throw error;
      }
      let parsed;
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        sendJson(request, response, 400, { error: "invalid-json" });
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        sendJson(request, response, 400, { error: "invalid-json" });
        return;
      }
      const extraKeys = Object.keys(parsed).filter((key) => !["token", "name"].includes(key));
      if (extraKeys.length > 0) {
        sendJson(request, response, 400, { error: "invalid-fields" });
        return;
      }
      const name = "name" in parsed ? normalizeName(parsed.name) : "";
      if ("name" in parsed && !name) {
        sendJson(request, response, 400, { error: "invalid-name" });
        return;
      }
      if ("token" in parsed) {
        if (typeof parsed.token !== "string" || parsed.token.length === 0 || parsed.token.length > 512) {
          sendJson(request, response, 401, { error: "invalid-token" });
          return;
        }
        const profileId = profileStore.resolveToken(parsed.token);
        if (!profileId) {
          sendJson(request, response, 401, { error: "invalid-token" });
          return;
        }
        if (name) profileStore.setName(profileId, name);
        sendJson(request, response, 200, { profile: publicProfile(profileStore.getProfile(profileId)) });
        return;
      }
      const created = profileStore.createProfile(name || "Wizard");
      sendJson(request, response, 201, { token: created.token, profile: publicProfile(created.profile) });
      return;
    }
    if (url.pathname === "/api/leaderboard" && request.method === "GET") {
      sendJson(request, response, 200, profileStore.getLeaderboard(now()));
      return;
    }
    if ((url.pathname === "/api/reward" || url.pathname === "/api/equip") && request.method === "POST") {
      let body;
      try {
        body = await readBody(request);
      } catch (error) {
        if (error.message === "payload-too-large") {
          sendJson(request, response, 413, { error: "payload-too-large" });
          return;
        }
        throw error;
      }
      let parsed;
      try {
        parsed = body ? JSON.parse(body) : null;
      } catch {
        sendJson(request, response, 400, { error: "invalid-json" });
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        typeof parsed.token !== "string" || typeof parsed.skin !== "string" ||
        Object.keys(parsed).length !== 2) {
        sendJson(request, response, 400, { error: "invalid-fields" });
        return;
      }
      const profileId = profileStore.resolveToken(parsed.token);
      if (!profileId) {
        sendJson(request, response, 401, { error: "invalid-token" });
        return;
      }
      if (url.pathname === "/api/equip") {
        const result = profileStore.equip(profileId, parsed.skin);
        if (!result.ok) {
          sendJson(request, response, 400, { error: result.reason });
          return;
        }
        sendJson(request, response, 200, { profile: publicProfile(result.profile) });
        return;
      }
      const result = profileStore.claimReward(profileId, parsed.skin);
      if (!result.ok) {
        sendJson(request, response, 403, { error: result.reason });
        return;
      }
      sendJson(request, response, 200, { profile: publicProfile(result.profile) });
      return;
    }
    sendJson(request, response, 404, { error: "not-found" });
  }

  function send(peer, message) {
    if (peer.ws.readyState !== WebSocket.OPEN) return;
    if (peer.ws.bufferedAmount > 262144) {
      peer.ws.terminate();
      return;
    }
    peer.ws.send(JSON.stringify(message));
  }

  function error(peer, message) {
    send(peer, { type: "error", message });
  }

  function broadcast(room, message) {
    for (const peer of room.peers.values()) send(peer, message);
  }

  function appearance(member) {
    if (!member.profileId) {
      return { name: member.name, profileId: null, skin: "default", nameColor: null, rewardRank: null };
    }
    const profile = profileStore.getProfile(member.profileId);
    return {
      name: profile?.name ?? member.name, profileId: member.profileId,
      skin: profile?.skin ?? "default", nameColor: profile?.nameColor ?? null,
      rewardRank: profile?.rewardRank ?? null,
    };
  }

  function countdown(room) {
    return room.phase === "countdown" ? Math.max(0, Math.ceil((room.countdownEndsAt - Date.now()) / 1000)) : null;
  }

  function roomMessage(room) {
    broadcast(room, {
      type: "room", code: room.code, host: room.host,
      players: [...room.peers.values()].map((member) => ({ id: member.id, ready: member.ready, ...appearance(member) })),
      phase: room.phase, round: room.round, totalRounds: 5, countdown: countdown(room), matchId: room.matchId, meta: BOARD_META,
    });
  }

  function stateMessage(room) {
    broadcast(room, {
      type: "state", code: room.code, phase: room.phase, time: room.time, radius: room.radius,
      countdown: countdown(room), round: room.round, totalRounds: 5, settlement: room.settlement ?? null, matchId: room.matchId, meta: BOARD_META,
      players: [...room.players.values()].map((player) => ({
        id: player.id, name: player.name, x: player.x, y: player.y, z: player.z, yaw: player.yaw,
        hp: player.hp, damage: player.damage, alive: player.alive, shieldUntil: player.shieldUntil,
        gold: room.peers.get(player.id)?.gold ?? player.gold, wins: room.peers.get(player.id)?.wins ?? player.wins, levels: { ...room.peers.get(player.id)?.levels }, connected: room.peers.get(player.id)?.ws.readyState === WebSocket.OPEN,
        cooldowns: { ...player.cooldowns }, ready: player.ready, ...appearance(player),
      })),
      projectiles: room.projectiles.map(({ id, x, y, z, spell, owner }) => ({ id, x, y, z, spell, owner })),
      winner: room.winner,
    });
  }

  function effectMessage(room, spell, owner, from, to) {
    broadcast(room, { type: "effect", id: randomUUID(), spell, owner, from, to });
  }

  function finish(room) {
    if (room.phase !== "fight") return;
    const survivors = [...room.players.values()].filter((player) => player.alive);
    if (survivors.length > 1) return;
    room.phase = "finished";
    room.winner = survivors[0]?.id ?? null;
    room.projectiles = [];
    settleMatch(room);
    for (const member of room.peers.values()) {
      member.gold = (member.gold ?? 8) + (member.id === room.winner ? 10 : 6);
      member.wins = (member.wins ?? 0) + Number(member.id === room.winner);
    }
    resetReadiness(room);
    roomMessage(room);
    stateMessage(room);
  }

  function leave(peer) {
    const room = peer.room;
    if (!room) return;
    peer.room = null;
    peer.ready = false;
    delete peer.reconnectUntil;
    if (room.phase === "fight") room.disconnected = true;
    room.peers.delete(peer.id);
    const player = room.players.get(peer.id);
    if (room.phase === "fight" && player) {
      player.alive = false;
      player.hp = 0;
      player.input = { forward: 0, right: 0, jump: false };
    } else {
      room.players.delete(peer.id);
    }
    if (room.phase === "countdown") cancelCountdown(room);
    if (room.peers.size === 0) {
      rooms.delete(room.code);
      room.projectiles = [];
      room.players.clear();
      return;
    }
    if (room.host === peer.id) room.host = room.peers.keys().next().value;
    finish(room);
    roomMessage(room);
    stateMessage(room);
  }

  function join(peer, room, name) {
    peer.name = peer.profileId ? profileStore.getProfile(peer.profileId).name : normalizeName(name);
    peer.ready = false;
    peer.room = room;
    delete peer.reconnectUntil;
    for (const id of room.players.keys()) {
      if (!room.peers.has(id)) room.players.delete(id);
    }
    room.peers.set(peer.id, peer);
    if (!room.players.has(peer.id)) {
      room.players.set(peer.id, makePlayer(peer, (room.peers.size - 1) * Math.PI / 2));
    }
    roomMessage(room);
    stateMessage(room);
  }

  function startFight(peer) {
    const room = peer.room;
    if (room.host !== peer.id) return error(peer, "Only the host can start");
    if (room.phase === "fight" || room.phase === "countdown") return error(peer, "Match already in progress");
    const connected = [...room.peers.values()].filter((member) => member.ws.readyState === WebSocket.OPEN);
    if (connected.length < 2) return error(peer, "At least two connected players required");
    const notReady = connected.filter((member) => !member.ready);
    if (notReady.length > 0) return error(peer, "All players must be ready");
    room.countdownFrom = room.phase;
    room.phase = "countdown";
    room.countdownEndsAt = Date.now() + countdownSeconds * 1000;
    roomMessage(room);
    stateMessage(room);
  }

  function beginFight(room) {
    if (room.round >= 5) {
      room.round = 0;
      for (const member of room.peers.values()) { member.gold = 8; member.wins = 0; member.levels = {}; }
    }
    room.round++;
    room.settlement = null;
    room.phase = "fight";
    room.time = 0;
    room.radius = 40;
    room.winner = null;
    room.projectiles = [];
    room.matchId = randomUUID();
    room.settled = false;
    room.disconnected = false;
    room.players.clear();
    let index = 0;
    for (const member of room.peers.values()) {
      const player = makePlayer(member, index * TAU / room.peers.size);
      player.ready = member.ready;
      room.players.set(member.id, player);
      member.inputTokens = 2;
      member.inputRefill = performance.now();
      index++;
    }
    roomMessage(room);
    stateMessage(room);
  }

  function settleMatch(room) {
    if (room.settled) return;
    room.settled = true;
    if (!room.matchId) return;
    const participants = [...room.players.values()]
      .filter((player) => player.profileId)
      .map((player) => player.profileId);
    const winner = room.winner ? room.players.get(room.winner) : null;
    room.settlement = profileStore.recordMatch({
      matchId: room.matchId,
      winnerProfileId: winner?.profileId ?? null,
      participants,
      duration: room.time,
      disconnected: participants.length !== room.players.size || room.disconnected || [...room.peers.values()].some((member) => member.ws.readyState !== WebSocket.OPEN),
    });
  }

  function resetReadiness(room) {
    for (const member of room.peers.values()) member.ready = false;
    for (const player of room.players.values()) player.ready = false;
  }

  function cancelCountdown(room) {
    room.phase = room.countdownFrom ?? "lobby";
    room.countdownEndsAt = 0;
    resetReadiness(room);
  }

  function readyHandler(peer, ready) {
    const room = peer.room;
    if (room.phase === "fight") return error(peer, "Readiness cannot change during combat");
    peer.ready = ready;
    room.players.get(peer.id).ready = ready;
    if (room.phase === "countdown" && !ready) cancelCountdown(room);
    roomMessage(room);
    stateMessage(room);
  }

  function cast(peer, spell) {
    const room = peer.room;
    const player = room.players.get(peer.id);
    if (room.phase !== "fight" || !player?.alive) return error(peer, "Player is not fighting");
    if ((player.cooldowns[spell] ?? 0) > room.time) return error(peer, "Spell is on cooldown");
    const level = peer.levels?.[spell] ?? 1;
    const base = SPELLS[spell];
    const spec = { ...base, damage: base.damage + 2 * (level - 1), kb: base.kb * (1 + 0.15 * (level - 1)) };
    player.cooldowns[spell] = room.time + spec.cd * 0.92 ** (level - 1);
    if (spell === "shield") {
      player.shieldUntil = room.time + 2.8 + 0.3 * (level - 1);
      effectMessage(room, spell, player.id, { x: player.x, y: player.y + 1, z: player.z }, { x: player.x, y: player.y + 1, z: player.z });
      return;
    }
    if (spell === "blink") {
      const from = { x: player.x, y: player.y + 1, z: player.z };
      player.x -= Math.sin(player.yaw) * (9 + level);
      player.z -= Math.cos(player.yaw) * (9 + level);
      effectMessage(room, spell, player.id, from, { x: player.x, y: player.y + 1, z: player.z });
      if (Math.hypot(player.x, player.z) < room.radius - 0.55) player.y = Math.max(0, player.y);
      player.vx = 0;
      player.vz = 0;
      player.mx = 0;
      player.mz = 0;
      player.vy = Math.max(0, player.vy);
      player.staggerUntil = 0;
      player.grounded = false;
      return;
    }
    const aim = direction(player);
    const from = { x: player.x, y: player.y + 1, z: player.z };
    if (spell === "lightning") {
      const end = { x: from.x + aim.x * 70, y: from.y + aim.y * 70, z: from.z + aim.z * 70 };
      const hit = firstHit(room, from, end, player.id, 0);
      if (hit) hurt(room, hit.player, spec.damage, spec.kb, aim);
      effectMessage(room, spell, player.id, from, end);
      finish(room);
      return;
    }
    room.projectiles.push({
      id: randomUUID(), owner: player.id, spell, damage: spec.damage, kb: spec.kb,
      x: from.x + aim.x * 1.3, y: from.y + aim.y * 1.3, z: from.z + aim.z * 1.3,
      vx: aim.x * spec.speed, vy: aim.y * spec.speed, vz: aim.z * spec.speed, born: room.time,
    });
  }

  function authenticate(peer, message) {
    if (peer.profileId) {
      error(peer, "Already authenticated");
      return;
    }
    const token = typeof message.token === "string" ? message.token.trim() : "";
    if (!token) {
      error(peer, "Invalid token");
      return;
    }
    const profileId = profileStore.resolveToken(token);
    if (!profileId) {
      error(peer, "Invalid token");
      return;
    }
    const activePeer = profilePeers.get(profileId);
    if (activePeer && activePeer !== peer && activePeer.ws.readyState === WebSocket.OPEN) {
      error(peer, "Profile already connected");
      return;
    }
    const profile = profileStore.getProfile(profileId);
    peer.profileId = profileId;
    peer.name = profile.name;
    peer.skin = profile.skin;
    peer.nameColor = profile.nameColor;
    peer.rewardRank = profile.rewardRank;
    if (activePeer?.room) {
      peer.id = activePeer.id; peer.room = activePeer.room;
      peer.gold = activePeer.gold; peer.wins = activePeer.wins; peer.levels = activePeer.levels;
      peer.room.peers.set(peer.id, peer); activePeer.room = null;
      send(peer, { type: "welcome", id: peer.id, resumed: true });
    }
    profilePeers.set(profileId, peer);
    send(peer, { type: "profile", profile: publicProfile(profile), resumed: !!peer.room });
    if (peer.room) { roomMessage(peer.room); stateMessage(peer.room); }
  }

  const profilePeers = new Map();

  function handle(peer, message) {
    if (message.type === "leave") { leave(peer); return; }
    if (message.type === "authenticate") { authenticate(peer, message); return; }
    if (message.type === "create") {
      if (peer.room) return error(peer, "Leave the current room first");
      if (peer.profileId && peerInRoom(peer.profileId)) return error(peer, "Profile already in a room");
      if (rooms.size >= 100) return error(peer, "Room limit reached");
      let code;
      do { code = makeCode(); } while (rooms.has(code));
      const room = {
        code, host: peer.id, peers: new Map(), players: new Map(), projectiles: [],
        phase: "lobby", time: 0, radius: 40, winner: null, matchId: null, settled: false,
        countdownEndsAt: 0, round: 0,
      };
      rooms.set(code, room);
      join(peer, room, message.name);
      return;
    }
    if (message.type === "join") {
      if (peer.room) return error(peer, "Leave the current room first");
      const room = rooms.get(message.code);
      if (!room) return error(peer, "Room not found");
      if (room.phase === "fight" || room.phase === "countdown") return error(peer, "Match already in progress");
      if (room.peers.size >= 4) return error(peer, "Room is full");
      if (peer.profileId && peerInRoom(peer.profileId)) return error(peer, "Profile already in a room");
      join(peer, room, message.name);
      return;
    }
    if (!peer.room) return error(peer, "Join a room first");
    if (message.type === "start") { startFight(peer); return; }
    if (message.type === "ready") { readyHandler(peer, message.ready); return; }
    if (message.type === "cast") { cast(peer, message.spell); return; }
    if (message.type === "buy") {
      const room = peer.room;
      if (!['lobby', 'finished'].includes(room.phase) || room.round >= 5 || peer.ready) return error(peer, 'Shop is closed');
      const costs = { fireball: 5, lightning: 7, homing: 6, meteor: 8, blink: 6, shield: 6 };
      const level = peer.levels?.[message.spell] ?? 1;
      const cost = Math.round(costs[message.spell] * 1.6 ** level);
      if (level >= 4 || (peer.gold ?? 8) < cost) return error(peer, 'Not enough gold');
      peer.gold = (peer.gold ?? 8) - cost; peer.levels = { ...peer.levels, [message.spell]: level + 1 };
      stateMessage(room); return;
    }
    const room = peer.room;
    const player = room.players.get(peer.id);
    if (room.phase !== "fight" || !player?.alive) return error(peer, "Player is not fighting");
    const now = performance.now();
    peer.inputTokens = Math.min(2, peer.inputTokens + (now - peer.inputRefill) * 0.02);
    peer.inputRefill = now;
    if (peer.inputTokens < 1) return error(peer, "Input rate limit exceeded");
    peer.inputTokens -= 1;
    player.input = { forward: message.forward, right: message.right, jump: message.jump };
    player.yaw = ((message.yaw % TAU) + TAU) % TAU;
    player.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, message.pitch));
    player.inputAt = room.time;
  }

  function peerInRoom(profileId) {
    for (const room of rooms.values()) {
      for (const member of room.peers.values()) {
        if (member.profileId === profileId) return true;
      }
    }
    return false;
  }

  wss.on("connection", (ws) => {
    if (closing) { ws.terminate(); return; }
    const now = performance.now();
    const peer = {
      id: randomUUID(), name: "", ws, room: null, alive: true, tokens: 80, refill: now,
      inputTokens: 2, inputRefill: now, limited: false, ready: false,
      gold: 8, wins: 0, levels: {},
      profileId: null, skin: "default", nameColor: null, rewardRank: null,
    };
    ws.gamePeer = peer;
    ws.on("pong", () => { peer.alive = true; });
    ws.on("close", () => detach(peer));
    ws.on("error", () => ws.terminate());
    ws.on("message", (data, binary) => {
      if (closing || peer.limited) return;
      const received = performance.now();
      peer.tokens = Math.min(80, peer.tokens + (received - peer.refill) * 0.06);
      peer.refill = received;
      if (peer.tokens < 1) {
        peer.limited = true;
        error(peer, "Rate limit exceeded");
        leave(peer);
        releaseProfile(peer);
        ws.close(1008, "Rate limit exceeded");
        return;
      }
      peer.tokens -= 1;
      if (binary) return error(peer, "Expected JSON text");
      let message;
      try { message = JSON.parse(data.toString()); }
      catch { error(peer, "Invalid JSON"); return; }
      if (!validMessage(message)) return error(peer, "Invalid message");
      handle(peer, message);
    });
    send(peer, { type: "welcome", id: peer.id });
  });

  function detach(peer) {
    if (!closing && peer.profileId && peer.room) {
      peer.reconnectUntil = Date.now() + reconnectSeconds * 1000;
      peer.ready = false;
      const room = peer.room;
      if (room.phase === 'fight') room.disconnected = true;
      if (room.phase === 'countdown') cancelCountdown(room);
      const player = room.players.get(peer.id);
      if (player) { player.inputAt = -1; player.ready = false; }
      if (room.host === peer.id) room.host = [...room.peers.values()].find(p => p.ws.readyState === WebSocket.OPEN)?.id ?? peer.id;
      roomMessage(room);
    } else { leave(peer); releaseProfile(peer); }
  }

  function releaseProfile(peer) {
    if (!peer?.profileId) return;
    if (profilePeers.get(peer.profileId) === peer) profilePeers.delete(peer.profileId);
  }

  let previous = performance.now();
  let accumulator = 0;
  let ticks = 0;
  const tickTimer = setInterval(() => {
    const now = performance.now();
    accumulator += Math.min(0.1, Math.max(0, (now - previous) / 1000));
    previous = now;
    while (accumulator >= DT) {
      accumulator -= DT;
      ticks++;
      for (const room of rooms.values()) {
        for (const member of room.peers.values()) if (member.reconnectUntil && Date.now() >= member.reconnectUntil) { leave(member); releaseProfile(member); }
        if (room.phase === "countdown" && Date.now() >= room.countdownEndsAt) {
          beginFight(room);
        }
        if (room.phase === "fight") {
          room.time += DT;
          room.radius = Math.max(0, 40 - room.time * 0.55);
          for (const player of room.players.values()) {
            if (player.alive) movePlayer(room, player);
          }
          moveProjectiles(room);
          finish(room);
          if (room.phase === "finished" && !room.settled) settleMatch(room);
        }
        if (ticks % 2 === 0) stateMessage(room);
      }
    }
  }, 1000 / 30);
  tickTimer.unref();

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const peer = ws.gamePeer;
      if (!peer || !peer.alive || ws.readyState !== WebSocket.OPEN) {
        ws.terminate();
        continue;
      }
      peer.alive = false;
      ws.ping();
    }
  }, 15000);
  heartbeat.unref();

  const readyPromise = new Promise((resolveReady, rejectReady) => {
    httpServer.once("listening", resolveReady);
    httpServer.once("error", rejectReady);
  });
  readyPromise.catch(() => {
    clearInterval(tickTimer);
    clearInterval(heartbeat);
  });
  httpServer.listen(port, host);

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    clearInterval(tickTimer);
    clearInterval(heartbeat);
    closePromise = (async () => {
      await readyPromise.catch(() => {});
      for (const ws of wss.clients) ws.terminate();
      rooms.clear();
      await Promise.all([
        new Promise((done) => wss.close(done)),
        new Promise((done, reject) => {
          httpServer.close((err) => err && err.code !== "ERR_SERVER_NOT_RUNNING" ? reject(err) : done());
          httpServer.closeAllConnections();
        }),
      ]);
      if (ownStore && profileStore?.close) profileStore.close();
    })();
    return closePromise;
  }

  return { server: httpServer, wss, rooms, close, store: profileStore, profilePeers };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? "0.0.0.0";
  const game = createGameServer({ port, host, dataPath: process.env.DATA_PATH ?? "data/profiles.sqlite", staticDir: process.env.STATIC_DIR !== undefined ? (process.env.STATIC_DIR ? resolve(process.env.STATIC_DIR) : null) : (existsSync(resolve("dist")) ? resolve("dist") : null), origins: (process.env.ORIGINS ?? "").split(",").filter(Boolean) });
  game.server.once("listening", () => {
    const address = game.server.address();
    console.log(`Game server listening on ${host}:${address.port} (ws /ws, api /api/*)`);
  });
  game.server.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  process.once("SIGINT", () => { void game.close(); });
  process.once("SIGTERM", () => { void game.close(); });
}

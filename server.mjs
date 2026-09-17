import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

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
  input: ["type", "forward", "right", "yaw", "pitch", "jump"],
  cast: ["type", "spell"],
  leave: ["type"],
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
    id: peer.id, name: peer.name,
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
    if (typeof message.name !== "string" || message.name.trim().length < 1 || message.name.length > 32 || /[\u0000-\u001f\u007f]/u.test(message.name)) return false;
  }
  if (message.type === "join" && (typeof message.code !== "string" || !/^[A-Z]{6}$/u.test(message.code))) return false;
  if (message.type === "cast" && (typeof message.spell !== "string" || !Object.hasOwn(SPELLS, message.spell))) return false;
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
      hurt(room, target, spec.damage, spec.kb, normalize(projectile.vx, projectile.vy, projectile.vz));
      return false;
    }
    Object.assign(projectile, end);
    return projectile.y >= -2.5;
  });
}

export function createGameServer({ port = 3001, host = "127.0.0.1" } = {}) {
  const rooms = new Map();
  const server = createServer((request, response) => {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("Not found");
  });
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 8192, perMessageDeflate: false });
  let closing = false;
  let closePromise;

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

  function roomMessage(room) {
    broadcast(room, {
      type: "room", code: room.code, host: room.host,
      players: [...room.peers.values()].map(({ id, name }) => ({ id, name })), phase: room.phase,
    });
  }

  function stateMessage(room) {
    broadcast(room, {
      type: "state", code: room.code, phase: room.phase, time: room.time, radius: room.radius,
      players: [...room.players.values()].map((player) => ({
        id: player.id, name: player.name, x: player.x, y: player.y, z: player.z, yaw: player.yaw,
        hp: player.hp, damage: player.damage, alive: player.alive, shieldUntil: player.shieldUntil,
        cooldowns: { ...player.cooldowns },
      })),
      projectiles: room.projectiles.map(({ id, x, y, z, spell }) => ({ id, x, y, z, spell })),
      winner: room.winner,
    });
  }

  function finish(room) {
    if (room.phase !== "fight") return;
    const survivors = [...room.players.values()].filter((player) => player.alive);
    if (survivors.length > 1) return;
    room.phase = "finished";
    room.winner = survivors[0]?.id ?? null;
    room.projectiles = [];
    roomMessage(room);
    stateMessage(room);
  }

  function leave(peer) {
    const room = peer.room;
    if (!room) return;
    peer.room = null;
    room.peers.delete(peer.id);
    const player = room.players.get(peer.id);
    if (room.phase === "fight" && player) {
      player.alive = false;
      player.hp = 0;
      player.input = { forward: 0, right: 0, jump: false };
    } else {
      room.players.delete(peer.id);
    }
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
    peer.name = name.trim();
    peer.room = room;
    for (const id of room.players.keys()) {
      if (!room.peers.has(id)) room.players.delete(id);
    }
    room.peers.set(peer.id, peer);
    room.players.set(peer.id, makePlayer(peer, (room.peers.size - 1) * Math.PI / 2));
    roomMessage(room);
    stateMessage(room);
  }

  function start(peer) {
    const room = peer.room;
    if (room.host !== peer.id) return error(peer, "Only the host can start");
    if (room.phase === "fight") return error(peer, "Match already in progress");
    const connected = [...room.peers.values()].filter((member) => member.ws.readyState === WebSocket.OPEN);
    if (connected.length < 2) return error(peer, "At least two connected players required");
    room.phase = "fight";
    room.time = 0;
    room.radius = 40;
    room.winner = null;
    room.projectiles = [];
    room.players.clear();
    connected.forEach((member, index) => {
      room.players.set(member.id, makePlayer(member, index * TAU / connected.length));
      member.inputTokens = 2;
      member.inputRefill = performance.now();
    });
    roomMessage(room);
    stateMessage(room);
  }

  function cast(peer, spell) {
    const room = peer.room;
    const player = room.players.get(peer.id);
    if (room.phase !== "fight" || !player?.alive) return error(peer, "Player is not fighting");
    if ((player.cooldowns[spell] ?? 0) > room.time) return error(peer, "Spell is on cooldown");
    const spec = SPELLS[spell];
    player.cooldowns[spell] = room.time + spec.cd;
    if (spell === "shield") {
      player.shieldUntil = room.time + 2.8;
      return;
    }
    if (spell === "blink") {
      player.x -= Math.sin(player.yaw) * 10;
      player.z -= Math.cos(player.yaw) * 10;
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
      finish(room);
      return;
    }
    room.projectiles.push({
      id: randomUUID(), owner: player.id, spell,
      x: from.x + aim.x * 1.3, y: from.y + aim.y * 1.3, z: from.z + aim.z * 1.3,
      vx: aim.x * spec.speed, vy: aim.y * spec.speed, vz: aim.z * spec.speed, born: room.time,
    });
  }

  function handle(peer, message) {
    if (message.type === "leave") { leave(peer); return; }
    if (message.type === "create") {
      if (peer.room) return error(peer, "Leave the current room first");
      if (rooms.size >= 100) return error(peer, "Room limit reached");
      let code;
      do { code = makeCode(); } while (rooms.has(code));
      const room = { code, host: peer.id, peers: new Map(), players: new Map(), projectiles: [], phase: "lobby", time: 0, radius: 40, winner: null };
      rooms.set(code, room);
      join(peer, room, message.name);
      return;
    }
    if (message.type === "join") {
      if (peer.room) return error(peer, "Leave the current room first");
      const room = rooms.get(message.code);
      if (!room) return error(peer, "Room not found");
      if (room.phase === "fight") return error(peer, "Match already in progress");
      if (room.peers.size >= 4) return error(peer, "Room is full");
      join(peer, room, message.name);
      return;
    }
    if (!peer.room) return error(peer, "Join a room first");
    if (message.type === "start") { start(peer); return; }
    if (message.type === "cast") { cast(peer, message.spell); return; }
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

  wss.on("connection", (ws) => {
    if (closing) { ws.terminate(); return; }
    const now = performance.now();
    const peer = { id: randomUUID(), name: "", ws, room: null, alive: true, tokens: 80, refill: now, inputTokens: 2, inputRefill: now, limited: false };
    ws.on("pong", () => { peer.alive = true; });
    ws.on("close", () => { leave(peer); });
    ws.on("error", () => { leave(peer); ws.terminate(); });
    ws.on("message", (data, binary) => {
      if (closing || peer.limited) return;
      const received = performance.now();
      peer.tokens = Math.min(80, peer.tokens + (received - peer.refill) * 0.06);
      peer.refill = received;
      if (peer.tokens < 1) {
        peer.limited = true;
        error(peer, "Rate limit exceeded");
        leave(peer);
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
    ws.gamePeer = peer;
    send(peer, { type: "welcome", id: peer.id });
  });

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
        if (room.phase === "fight") {
          room.time += DT;
          room.radius = Math.max(8, 40 - room.time * 0.55);
          for (const player of room.players.values()) {
            if (player.alive) movePlayer(room, player);
          }
          moveProjectiles(room);
          finish(room);
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
        if (peer) leave(peer);
        ws.terminate();
        continue;
      }
      peer.alive = false;
      ws.ping();
    }
  }, 15000);
  heartbeat.unref();

  const ready = new Promise((resolveReady, rejectReady) => {
    server.once("listening", resolveReady);
    server.once("error", rejectReady);
  });
  ready.catch(() => {
    clearInterval(tickTimer);
    clearInterval(heartbeat);
  });
  server.listen(port, host);

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    clearInterval(tickTimer);
    clearInterval(heartbeat);
    closePromise = (async () => {
      await ready.catch(() => {});
      for (const ws of wss.clients) ws.terminate();
      rooms.clear();
      await Promise.all([
        new Promise((done) => wss.close(done)),
        new Promise((done, reject) => {
          server.close((err) => err && err.code !== "ERR_SERVER_NOT_RUNNING" ? reject(err) : done());
          server.closeAllConnections();
        }),
      ]);
    })();
    return closePromise;
  }

  return { server, wss, rooms, close };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? "127.0.0.1";
  const game = createGameServer({ port, host });
  game.server.once("listening", () => {
    const address = game.server.address();
    console.log(`WebSocket server listening on ${host}:${address.port}/ws`);
  });
  game.server.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  process.once("SIGINT", () => { void game.close(); });
  process.once("SIGTERM", () => { void game.close(); });
}

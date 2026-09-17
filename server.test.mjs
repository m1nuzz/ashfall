import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { WebSocket } from "ws";
import { createGameServer } from "./server.mjs";

async function setup(t) {
  const game = createGameServer({ port: 0 });
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.ws.terminate();
    await game.close();
  });
  await once(game.server, "listening");
  const url = `ws://127.0.0.1:${game.server.address().port}/ws`;
  async function connect() {
    const ws = new WebSocket(url);
    const messages = [];
    const waiters = new Set();
    const client = {
      ws, messages,
      send(message) { ws.send(JSON.stringify(message)); },
      wait(type, predicate = () => true, after = 0, timeout = 4000) {
        const matches = (message) => message.type === type && predicate(message);
        const existing = messages.slice(after).find(matches);
        if (existing) return Promise.resolve(existing);
        return new Promise((resolve, reject) => {
          const waiter = { matches, resolve: (message) => { clearTimeout(timer); waiters.delete(waiter); resolve(message); } };
          const timer = setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`Timed out waiting for ${type}; received ${JSON.stringify(messages.slice(-4))}`));
          }, timeout);
          waiters.add(waiter);
        });
      },
      async request(message, type, predicate = () => true) {
        const mark = messages.length;
        this.send(message);
        return this.wait(type, predicate, mark);
      },
      async disconnect() {
        if (ws.readyState === WebSocket.CLOSED) return;
        const closed = once(ws, "close");
        ws.close();
        await closed;
      },
    };
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.matches(message)) waiter.resolve(message);
      }
    });
    ws.on("error", () => {});
    clients.push(client);
    await once(ws, "open");
    client.id = (await client.wait("welcome")).id;
    assert.equal(typeof client.id, "string");
    return client;
  }
  return { game, connect, url };
}

async function fight(t) {
  const context = await setup(t);
  const host = await context.connect();
  const guest = await context.connect();
  const room = await host.request({ type: "create", name: "Host" }, "room");
  await guest.request({ type: "join", code: room.code, name: "Guest" }, "room");
  const state = await host.request({ type: "start" }, "state", (message) => message.phase === "fight");
  return { ...context, host, guest, code: room.code, state };
}

function input(overrides = {}) {
  return { type: "input", forward: 0, right: 0, yaw: 0, pitch: 0, jump: false, ...overrides };
}

function finite(value) {
  if (typeof value === "number") assert.ok(Number.isFinite(value));
  else if (Array.isArray(value)) value.forEach(finite);
  else if (value && typeof value === "object") Object.values(value).forEach(finite);
}

async function eventually(predicate, timeout = 2000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() >= deadline) assert.fail("Condition did not become true");
    await delay(10);
  }
}

test("welcome, create, join, host authorization, fight rejection and exact snapshots", async (t) => {
  const { connect } = await setup(t);
  const host = await connect();
  const guest = await connect();
  assert.notEqual(host.id, guest.id);
  assert.deepEqual(Object.keys(host.messages[0]).sort(), ["id", "type"]);
  const room = await host.request({ type: "create", name: " Host " }, "room");
  assert.match(room.code, /^[A-Z]{6}$/u);
  assert.deepEqual(room, { type: "room", code: room.code, host: host.id, players: [{ id: host.id, name: "Host" }], phase: "lobby" });
  await host.request({ type: "start" }, "error", (message) => message.message === "At least two connected players required");
  await guest.request({ type: "join", code: room.code, name: "Guest" }, "room", (message) => message.players.length === 2);
  await guest.request({ type: "start" }, "error", (message) => message.message === "Only the host can start");
  const state = await host.request({ type: "start" }, "state", (message) => message.phase === "fight");
  assert.equal(state.time, 0);
  assert.equal(state.radius, 40);
  assert.equal(state.winner, null);
  assert.deepEqual(Object.keys(state).sort(), ["code", "phase", "players", "projectiles", "radius", "time", "type", "winner"]);
  assert.equal(state.players.length, 2);
  for (const player of state.players) {
    assert.deepEqual(Object.keys(player).sort(), ["alive", "cooldowns", "damage", "hp", "id", "name", "shieldUntil", "x", "y", "yaw", "z"]);
    assert.equal(player.hp, 100);
    assert.equal(player.damage, 0);
    assert.equal(player.alive, true);
    assert.deepEqual(player.cooldowns, {});
  }
  const late = await connect();
  await late.request({ type: "join", code: room.code, name: "Late" }, "error", (message) => message.message === "Match already in progress");
  await host.request({ type: "start" }, "error", (message) => message.message === "Match already in progress");
  await host.wait("state", (message) => message.time >= 0.2);
  host.messages.filter((message) => message.type === "state").forEach(finite);
});

test("malformed, binary, nonfinite and forged fields are rejected without mutation", async (t) => {
  const { host } = await fight(t);
  const invalid = [
    "{", "null", "[]", "42", '{}',
    JSON.stringify({ type: "input", forward: 0, right: 0, yaw: 0, pitch: 0, jump: false, x: 999, hp: 999 }),
    JSON.stringify(input({ forward: 2 })),
    JSON.stringify(input({ right: "1" })),
    JSON.stringify(input({ jump: 1 })),
    JSON.stringify(input({ yaw: null })),
    '{"type":"input","forward":0,"right":0,"yaw":1e999,"pitch":0,"jump":false}',
    JSON.stringify({ type: "cast", spell: "constructor" }),
    JSON.stringify({ type: "cast", spell: "teleport" }),
    JSON.stringify({ type: "cast", spell: "fireball", damage: 500 }),
    JSON.stringify({ type: "admin" }),
    JSON.stringify({ type: {} }),
    JSON.stringify({ type: ["start"] }),
    JSON.stringify({ type: "create", name: "" }),
    JSON.stringify({ type: "create", name: "x".repeat(33) }),
    JSON.stringify({ type: "create", name: "a\nb" }),
    JSON.stringify({ type: "join", code: "abcdef", name: "Guest" }),
    Buffer.from("binary"),
  ];
  for (const payload of invalid) {
    const mark = host.messages.length;
    host.ws.send(payload);
    await host.wait("error", () => true, mark);
  }
  const mark = host.messages.length;
  const state = await host.wait("state", (message) => message.time > 0, mark);
  const player = state.players.find((entry) => entry.id === host.id);
  assert.equal(player.x, 0);
  assert.equal(player.z, 18);
  assert.equal(player.hp, 100);
  assert.deepEqual(player.cooldowns, {});
  host.send(input({ yaw: Number.MAX_VALUE, pitch: -Number.MAX_VALUE }));
  const next = await host.wait("state", (message) => message.time > state.time);
  finite(next);
  assert.ok(next.players[0].yaw >= 0 && next.players[0].yaw < Math.PI * 2);
});

test("authoritative movement, yaw, jump, shrink and input expiry", async (t) => {
  const { host, state } = await fight(t);
  host.send(input({ forward: 1, jump: true }));
  const moved = await host.wait("state", (message) => message.time >= 0.3);
  const player = moved.players.find((entry) => entry.id === host.id);
  assert.ok(player.z < 17 && player.z > 13);
  assert.equal(player.x, 0);
  assert.ok(player.y > 1);
  assert.ok(Math.abs(moved.radius - (40 - moved.time * 0.55)) < 1e-9);
  host.send(input({ forward: 1, yaw: Math.PI / 2 }));
  const turned = await host.wait("state", (message) => message.time >= moved.time + 0.3);
  assert.ok(turned.players[0].x < -1);
  const settled = await host.wait("state", (message) => message.time >= moved.time + 1.4);
  const later = await host.wait("state", (message) => message.time >= settled.time + 0.3);
  assert.ok(Math.abs(later.players[0].x - settled.players[0].x) < 0.02);
  assert.equal(later.players[0].y, 0);
  assert.ok(later.time > state.time);
  const snapshots = host.messages.filter((message) => message.type === "state" && message.time > 0);
  snapshots.forEach(finite);
  for (let index = 1; index < snapshots.length; index++) {
    assert.ok(Math.abs(snapshots[index].time - snapshots[index - 1].time - 2 / 30) < 1e-8);
  }
});

test("fireball cooldown, projectile schema, swept hit and preserved knockback", async (t) => {
  const { host, guest } = await fight(t);
  host.send({ type: "cast", spell: "fireball" });
  const cast = await host.wait("state", (message) => message.projectiles.length === 1);
  assert.deepEqual(Object.keys(cast.projectiles[0]).sort(), ["id", "spell", "x", "y", "z"]);
  assert.equal(cast.projectiles[0].spell, "fireball");
  const deadline = cast.players[0].cooldowns.fireball;
  assert.ok(deadline >= 0.55 && deadline <= cast.time + 0.55);
  await host.request({ type: "cast", spell: "fireball" }, "error", (message) => message.message === "Spell is on cooldown");
  const hit = await host.wait("state", (message) => message.players.find((entry) => entry.id === guest.id)?.hp === 90);
  const victim = hit.players.find((entry) => entry.id === guest.id);
  assert.equal(victim.damage, 10);
  assert.equal(hit.players[0].cooldowns.fireball, deadline);
  guest.send(input({ forward: 1, yaw: Math.PI }));
  const staggered = await host.wait("state", (message) => message.time >= hit.time + 0.25);
  assert.ok(staggered.players[1].z < victim.z - 0.5);
  const mark = host.messages.length;
  host.send({ type: "cast", spell: "fireball" });
  await host.wait("state", (message) => message.players[0].cooldowns.fireball > deadline, mark);
});

test("lightning uses yaw and pitch, and utility and projectile spell cooldowns are authoritative", async (t) => {
  const { host, guest } = await fight(t);
  host.send(input({ pitch: Math.PI / 2 }));
  host.send({ type: "cast", spell: "lightning" });
  const miss = await host.wait("state", (message) => message.players[0].cooldowns.lightning > 0);
  assert.equal(miss.players[1].hp, 100);
  guest.send(input({ yaw: Math.PI }));
  guest.send({ type: "cast", spell: "lightning" });
  const hit = await host.wait("state", (message) => message.players[0].hp === 90);
  assert.equal(hit.players[0].damage, 10);
  host.send({ type: "cast", spell: "shield" });
  host.send({ type: "cast", spell: "blink" });
  host.send({ type: "cast", spell: "homing" });
  host.send({ type: "cast", spell: "meteor" });
  const utilities = await host.wait("state", (message) => message.players[0].cooldowns.meteor > 0);
  const player = utilities.players[0];
  assert.ok(Math.abs(player.cooldowns.shield - player.shieldUntil - 5.2) < 1e-8);
  assert.ok(player.z < hit.players[0].z - 9);
  assert.ok(player.cooldowns.blink >= 5);
  assert.ok(player.cooldowns.homing >= 3);
  assert.ok(player.cooldowns.meteor >= 6);
  for (const spell of ["lightning", "shield", "blink", "homing", "meteor"]) {
    await host.request({ type: "cast", spell }, "error", (message) => message.message === "Spell is on cooldown");
  }
  utilities.projectiles.forEach(finite);
});

test("shield reflects fireball back to its owner without resetting its lifetime", async (t) => {
  const { host, guest } = await fight(t);
  guest.send({ type: "cast", spell: "shield" });
  await guest.wait("state", (message) => message.players[1].shieldUntil > 0);
  host.send({ type: "cast", spell: "fireball" });
  const reflected = await host.wait("state", (message) => message.players[0].hp === 90, 0, 4000);
  assert.equal(reflected.players[1].hp, 100);
  assert.equal(reflected.projectiles.length, 0);
});

test("missed projectiles expire after four simulation seconds", async (t) => {
  const { host } = await fight(t);
  host.send(input({ pitch: Math.PI / 2 }));
  host.send({ type: "cast", spell: "meteor" });
  const active = await host.wait("state", (message) => message.projectiles.length === 1);
  const id = active.projectiles[0].id;
  const before = await host.wait("state", (message) => message.time >= 3.8, 0, 6000);
  assert.ok(before.projectiles.some((projectile) => projectile.id === id));
  const expired = await host.wait("state", (message) => message.time >= 4.1);
  assert.ok(!expired.projectiles.some((projectile) => projectile.id === id));
});

test("lava deals 30 damage per second and blink rescues to the arena floor", async (t) => {
  const { host } = await fight(t);
  host.send(input({ forward: -1 }));
  const movement = setInterval(() => host.send(input({ forward: -1 })), 55);
  t.after(() => clearInterval(movement));
  const nearEdge = await host.wait("state", (message) => message.players[0].z >= 41, 0, 6000);
  clearInterval(movement);
  await delay(60);
  host.send(input());
  const lava = await host.wait("state", (message) => message.time > nearEdge.time && message.players[0].hp < 100);
  assert.equal(lava.players[0].y, -2.5);
  const burned = await host.wait("state", (message) => message.time >= lava.time + 0.3);
  assert.ok(Math.abs(lava.players[0].hp - burned.players[0].hp - 30 * (burned.time - lava.time)) < 1e-7);
  host.send({ type: "cast", spell: "blink" });
  const rescued = await host.wait("state", (message) => message.players[0].cooldowns.blink > 0);
  assert.equal(rescued.players[0].y, 0);
  assert.ok(rescued.players[0].z < rescued.radius - 0.55);
  assert.ok(rescued.players[0].alive);
});

test("disconnect marks dead, reassigns host, ends match, permits restart and cleans rooms", async (t) => {
  const { game, host, guest, connect, code } = await fight(t);
  await host.disconnect();
  const ended = await guest.wait("state", (message) => message.phase === "finished");
  assert.equal(ended.winner, guest.id);
  assert.equal(ended.players.find((entry) => entry.id === host.id).alive, false);
  assert.equal(ended.players.find((entry) => entry.id === host.id).hp, 0);
  await guest.wait("room", (message) => message.host === guest.id && message.players.length === 1);
  await guest.request({ type: "start" }, "error", (message) => message.message === "At least two connected players required");
  const newcomer = await connect();
  await newcomer.request({ type: "join", code, name: "New" }, "room");
  const restarted = await guest.request({ type: "start" }, "state", (message) => message.phase === "fight");
  assert.equal(restarted.time, 0);
  assert.equal(restarted.radius, 40);
  assert.equal(restarted.winner, null);
  assert.equal(restarted.players.length, 2);
  assert.ok(restarted.players.every((player) => player.alive && player.hp === 100));
  const mark = guest.messages.length;
  newcomer.send({ type: "leave" });
  await guest.wait("state", (message) => message.phase === "finished", mark);
  await guest.disconnect();
  await eventually(() => game.rooms.size === 0);
  const fresh = await newcomer.request({ type: "create", name: "Again" }, "room");
  assert.equal(fresh.phase, "lobby");
  assert.equal(fresh.host, newcomer.id);
  await newcomer.disconnect();
  await eventually(() => game.rooms.size === 0);
});

test("rooms allow four peers and lobby host reassignment", async (t) => {
  const { connect } = await setup(t);
  const clients = [];
  for (let index = 0; index < 5; index++) clients.push(await connect());
  const room = await clients[0].request({ type: "create", name: "Host" }, "room");
  for (let index = 1; index < 4; index++) {
    await clients[index].request({ type: "join", code: room.code, name: `Guest ${index}` }, "room");
  }
  await clients[4].request({ type: "join", code: room.code, name: "Extra" }, "error", (message) => message.message === "Room is full");
  clients[0].send({ type: "leave" });
  await clients[1].wait("room", (message) => message.host === clients[1].id && message.players.length === 3);
  await clients[4].request({ type: "join", code: room.code, name: "Extra" }, "room", (message) => message.players.length === 4);
});

test("room count is capped at 100 and reclaimed on disconnect", async (t) => {
  const { game, connect } = await setup(t);
  const clients = [];
  const codes = new Set();
  for (let index = 0; index < 100; index++) {
    const client = await connect();
    clients.push(client);
    const room = await client.request({ type: "create", name: `Host ${index}` }, "room");
    codes.add(room.code);
  }
  assert.equal(codes.size, 100);
  assert.equal(game.rooms.size, 100);
  const extra = await connect();
  await extra.request({ type: "create", name: "Extra" }, "error", (message) => message.message === "Room limit reached");
  await clients[0].disconnect();
  await eventually(() => game.rooms.size === 99);
  await extra.request({ type: "create", name: "Extra" }, "room");
  assert.equal(game.rooms.size, 100);
});

test("input and general message rates are limited", async (t) => {
  const { host, guest } = await fight(t);
  for (let index = 0; index < 8; index++) host.send(input());
  await host.wait("error", (message) => message.message === "Input rate limit exceeded");
  const closed = once(guest.ws, "close");
  for (let index = 0; index < 200; index++) guest.ws.send("{}");
  const [code] = await closed;
  assert.equal(code, 1008);
  await host.wait("state", (message) => message.phase === "finished");
});

test("oversized payload closes with 1009 and removes its room", async (t) => {
  const { game, connect } = await setup(t);
  const client = await connect();
  await client.request({ type: "create", name: "Host" }, "room");
  const closed = once(client.ws, "close");
  client.ws.send("x".repeat(8193));
  const [code] = await closed;
  assert.equal(code, 1009);
  await eventually(() => game.rooms.size === 0);
});

test("only /ws upgrades and close is idempotent with active peers", async (t) => {
  const { game, connect, url } = await setup(t);
  const bad = new WebSocket(url.replace(/\/ws$/u, "/other"));
  t.after(() => bad.terminate());
  await once(bad, "error");
  assert.notEqual(bad.readyState, WebSocket.OPEN);
  const peer = await connect();
  const closed = once(peer.ws, "close");
  const first = game.close();
  assert.equal(first, game.close());
  await first;
  await closed;
  assert.equal(game.server.listening, false);
  assert.equal(game.rooms.size, 0);
});

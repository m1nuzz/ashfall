import * as THREE from "three";
import { createWorld, ARENA_RADIUS } from "./world.js";
import { createWizard, BOT_COLORS } from "./wizard.js";
import { mountSettings, mouseRadians } from "./settings.js";
import { createAudio } from "./audio.js";
import { createMultiplayer } from "./multiplayer.js";

const GRAVITY = 26;
const MOVE_SPEED = 14;
const JUMP_SPEED = 9;
const FRICTION = 8.5;
const PLAYER_RADIUS = 0.55;
const PLAYER_HEIGHT = 1.7;
const MAX_HP = 100;
const BOT_COUNT = 3;
const LAVA_Y = -2.5;
const TOTAL_ROUNDS = 5;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = false;
document.getElementById("app").appendChild(renderer.domElement);

const world = createWorld();
const { scene, arena, ring, updateWorld } = world;
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 300);
let sound;
const settings = mountSettings(value => {
  sound?.setVolume(value.volume);
  camera.fov = value.fov;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, value.quality === 'low' ? 1 : 2));
});

const entities = [];
const projectiles = [];
const bolts = [];

const keys = {};
let yaw = 0, pitch = 0;
let locked = false;
let requestingLock = false;

const ui = {
  hp: document.getElementById("hp-fill"),
  hpText: document.getElementById("hp-text"),
  gold: document.getElementById("gold"),
  round: document.getElementById("round"),
  alive: document.getElementById("alive"),
  spells: document.getElementById("spellbar"),
  crosshair: document.getElementById("crosshair"),
  menu: document.getElementById("menu"),
  shop: document.getElementById("shop"),
  shopItems: document.getElementById("shop-items"),
  shopTitle: document.getElementById("shop-title"),
  shopSubtitle: document.getElementById("shop-subtitle"),
  shopGold: document.getElementById("shop-gold"),
  nextBtn: document.getElementById("next-btn"),
  msg: document.getElementById("msg"),
  dmgFlash: document.getElementById("dmg-flash"),
  lavaWarn: document.getElementById("lava-warning"),
  dmgPts: document.getElementById("damage-points"),
  arenaSize: document.getElementById("arena-size"),
  end: document.getElementById("end"),
  endText: document.getElementById("end-text"),
  endBtn: document.getElementById("end-btn"),
  pause: document.getElementById("pause"),
  resumeBtn: document.getElementById("resume-btn"),
  feed: document.getElementById("feed"),
};

const SPELL_DEFS = {
  fireball: { id: "fireball", name: "Огнешар", key: "ЛКМ", code: "LMB", desc: "Быстрый снаряд. Надёжный урон и толчок.", cd: 0.55, dmg: 8, kb: 7, speed: 42, radius: 0.6, level: 0, maxLevel: 4 },
  lightning: { id: "lightning", name: "Молния", key: "2", code: "Digit2", desc: "Мгновенный разряд в цель. Мощный толчок.", hitscan: true, cd: 4, dmg: 6, kb: 17, level: 0, maxLevel: 4 },
  homing: { id: "homing", name: "Охотник", key: "3", code: "Digit3", desc: "Сам наводится на ближайшего мага.", cd: 3, dmg: 6, kb: 9, speed: 20, radius: 0.6, homing: true, level: 0, maxLevel: 4 },
  meteor: { id: "meteor", name: "Метеор", key: "4", code: "Digit4", desc: "Тяжёлое ядро. Больной урон и отброс.", cd: 6, dmg: 14, kb: 21, speed: 26, radius: 1.1, level: 0, maxLevel: 4 },
};
const UTIL_DEFS = {
  blink: { id: "blink", name: "Рывок", key: "Q", code: "KeyQ", desc: "Мгновенный прыжок вперёд. Спасение у лавы.", level: 0, maxLevel: 4 },
  shield: { id: "shield", name: "Щит", key: "E", code: "KeyE", desc: "Отражает снаряды обратно в атакующего.", level: 0, maxLevel: 4 },
};

const STATE = {
  gold: 8,
  round: 1,
  lavaDmg: 15,
  arenaShrink: 0.55,
};

function makePlayer() {
  const wiz = createWizard(0xdd6622);
  wiz.group.visible = false;
  scene.add(wiz.group);
  return {
    pos: new THREE.Vector3(0, 0, 0),
    vel: new THREE.Vector3(),
    onGround: true,
    hp: MAX_HP,
    dmgPts: 0,
    alive: true,
    shieldUntil: 0,
    cds: {},
    wiz,
    isBot: false,
    name: "Ты",
    kills: 0,
  };
}

const player = makePlayer();

function makeBot(i, pos) {
  const wiz = createWizard(BOT_COLORS[i % BOT_COLORS.length]);
  scene.add(wiz.group);
  return {
    pos: pos.clone(),
    vel: new THREE.Vector3(),
    onGround: true,
    hp: MAX_HP,
    dmgPts: 0,
    alive: true,
    shieldUntil: 0,
    fireCd: 0,
    thinkCd: Math.random() * 1.5,
    wiz,
    isBot: true,
    name: "Маг " + (i + 1),
    kills: 0,
    strafeDir: 1,
    strafeT: 0,
  };
}

function spawnPos(angle, radius) {
  return new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
}

let arenaRadius = ARENA_RADIUS;
let phase = "menu";
let paused = false;
let gameTime = 0;
let wins = 0;
let mouseHeld = false;
let castPulse = 0;
sound = createAudio(() => settings.volume, message => {
  document.getElementById('audio-status').textContent = message;
});
let mode = 'bots';
let onlineId = null;
let onlineState = null;
let onlineInputTime = 0;
const remoteEntities = new Map();
const remoteProjectiles = new Map();
const multiplayer = createMultiplayer({ onState: receiveOnlineState, onMatch: beginOnlineMatch, onLeave: returnToMenu, onEffect: event => {
  const from = new THREE.Vector3(event.from.x, event.from.y, event.from.z);
  const to = new THREE.Vector3(event.to.x, event.to.y, event.to.z);
  spawnBolt(from, to);
  if (event.owner !== onlineId) playAt('lightning', from);
} });
const costs = { fireball: 5, lightning: 7, homing: 6, meteor: 8, blink: 6, shield: 6 };
for (const s of [...Object.values(SPELL_DEFS), ...Object.values(UTIL_DEFS)]) {
  s.cost = costs[s.id];
  s.level = 1;
}

function disposeObject(object) {
  scene.remove(object);
  const geometries = new Set();
  const materials = new Set();
  object.traverse((child) => {
    if (child.geometry) geometries.add(child.geometry);
    if (child.material) {
      for (const mat of Array.isArray(child.material) ? child.material : [child.material]) materials.add(mat);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}

function clearEffects() {
  for (const p of projectiles) disposeObject(p.mesh);
  for (const b of bolts) disposeObject(b.line);
  projectiles.length = 0;
  bolts.length = 0;
}

function playAt(name, position) {
  const offset = position.clone().sub(camera.position);
  const distance = offset.length();
  if (distance > 45) return;
  const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  sound.play(name, { gain: 0.5 / (1 + distance * 0.1), pan: offset.normalize().dot(right) });
}

const hand = new THREE.Group();
const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.065, 1.7, 8), new THREE.MeshStandardMaterial({ color: 0x594330, metalness: 0.5, roughness: 0.45 }));
shaft.rotation.z = -0.16;
hand.add(shaft);
const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.17), new THREE.MeshBasicMaterial({ color: 0xffae68 }));
crystal.position.set(0.13, 0.85, 0);
hand.add(crystal);
const crown = new THREE.Mesh(new THREE.TorusGeometry(0.23, 0.025, 6, 24), new THREE.MeshStandardMaterial({ color: 0xbf9360, metalness: 0.8, roughness: 0.3 }));
crown.position.copy(crystal.position);
hand.add(crown);
hand.position.set(0.65, -0.75, -1.1);
camera.add(hand);
scene.add(camera);
hand.visible = false;
camera.position.set(23, 16, 31);
camera.lookAt(0, 0, 0);
for (let i = 0; i < BOT_COUNT; i++) {
  const bot = makeBot(i, spawnPos(i * Math.PI * 2 / BOT_COUNT, 10));
  bot.wiz.group.position.copy(bot.pos);
  entities.push(bot);
}

function clearOnlineObjects() {
  for (const e of remoteEntities.values()) disposeObject(e.wiz.group);
  for (const mesh of remoteProjectiles.values()) disposeObject(mesh);
  remoteEntities.clear();
  remoteProjectiles.clear();
}

function returnToMenu() {
  sound.stop();
  phase = 'menu';
  mode = 'bots';
  paused = false;
  onlineState = null;
  clearInput();
  document.exitPointerLock();
  clearEffects();
  clearOnlineObjects();
  for (const e of entities) if (e !== player) disposeObject(e.wiz.group);
  entities.length = 0;
  ui.menu.hidden = false;
  ui.pause.hidden = true;
  ui.shop.hidden = true;
  ui.hudShow(false);
  ui.lavaWarn.hidden = true;
  hand.visible = false;
  camera.position.set(23, 16, 31);
  camera.lookAt(0, 0, 0);
  arena.scale.setScalar(1);
  ring.scale.setScalar(1);
}

function beginOnlineMatch(id) {
  clearEffects();
  clearOnlineObjects();
  for (const e of entities) if (e !== player) disposeObject(e.wiz.group);
  entities.length = 0;
  mode = 'online';
  phase = 'fight';
  onlineId = id;
  onlineState = null;
  onlineInputTime = 0;
  player.hp = 100;
  player.alive = true;
  player.cds = {};
  gameTime = 0;
  yaw = 0;
  pitch = 0;
  paused = true;
  clearInput();
  ui.menu.hidden = true;
  ui.shop.hidden = true;
  ui.pause.hidden = false;
  ui.hudShow(true);
  document.getElementById('pause-text').textContent = 'Матч начался. Нажми «Продолжить». В онлайне бой не останавливается.';
  for (const s of [...Object.values(SPELL_DEFS), ...Object.values(UTIL_DEFS)]) s.level = 1;
}

function receiveOnlineState(snapshot, id) {
  if (mode !== 'online') return;
  const first = !onlineState;
  onlineState = snapshot;
  onlineId = id;
  const previousPhase = phase;
  if (['countdown', 'lobby', 'finished'].includes(snapshot.phase)) phase = snapshot.phase === 'countdown' ? 'online-countdown' : phase === 'online-finished' ? phase : previousPhase;
  gameTime = snapshot.time;
  arenaRadius = snapshot.radius;
  arena.scale.setScalar(arenaRadius / ARENA_RADIUS);
  ring.scale.setScalar(arenaRadius / ARENA_RADIUS);
  const local = snapshot.players.find(p => p.id === id);
  if (local) {
    if (local.hp < player.hp) flashDamage();
    player.hp = local.hp;
    player.dmgPts = local.damage;
    player.alive = local.alive;
    player.cds = local.cooldowns;
    player.shieldUntil = local.shieldUntil;
    if (first) { yaw = local.yaw; player.pos.set(local.x, local.y, local.z); }
  }
  const seen = new Set();
  for (const [index, peer] of snapshot.players.entries()) {
    if (peer.id === id) continue;
    seen.add(peer.id);
    let e = remoteEntities.get(peer.id);
    if (!e) {
      e = { wiz: createWizard(BOT_COLORS[index % BOT_COLORS.length]), target: new THREE.Vector3() };
      e.wiz.group.position.set(peer.x, peer.y, peer.z);
      scene.add(e.wiz.group);
      remoteEntities.set(peer.id, e);
    }
    e.target.set(peer.x, peer.y, peer.z);
    e.wiz.group.rotation.y = peer.yaw + Math.PI;
    e.wiz.group.visible = peer.alive;
    e.wiz.shield.visible = peer.shieldUntil > snapshot.time;
  }
  for (const [key, e] of remoteEntities) if (!seen.has(key)) { disposeObject(e.wiz.group); remoteEntities.delete(key); }
  const seenProjectiles = new Set();
  for (const p of snapshot.projectiles) {
    seenProjectiles.add(p.id);
    let mesh = remoteProjectiles.get(p.id);
    if (!mesh) {
      const colors = { fireball: 0xff6622, homing: 0x5599ff, meteor: 0xffaa22 };
      mesh = new THREE.Mesh(new THREE.SphereGeometry(p.spell === 'meteor' ? 1.1 : 0.6, 10, 10), new THREE.MeshBasicMaterial({ color: colors[p.spell] || 0xffffff }));
      scene.add(mesh);
      remoteProjectiles.set(p.id, mesh);
      if (Math.hypot(p.x - player.pos.x, p.z - player.pos.z) > 3) playAt(p.spell, new THREE.Vector3(p.x, p.y, p.z));
    }
    mesh.position.set(p.x, p.y, p.z);
  }
  for (const [key, mesh] of remoteProjectiles) if (!seenProjectiles.has(key)) { disposeObject(mesh); remoteProjectiles.delete(key); }
  if (snapshot.phase === 'finished') {
    if (phase !== 'online-finished') sound.play(snapshot.winner === id ? 'victory' : 'hit');
    phase = 'online-finished';
    clearInput();
    document.exitPointerLock();
    ui.pause.hidden = true;
    ui.hudShow(false);
    for (const panel of document.querySelectorAll('.subpanel')) panel.hidden = true;
  }
}

function sendOnlineInput() {
  multiplayer.send({ type: 'input', forward: paused || !player.alive ? 0 : Number(!!keys.w) - Number(!!keys.s), right: paused || !player.alive ? 0 : Number(!!keys.d) - Number(!!keys.a), yaw, pitch: -pitch, jump: !paused && player.alive && !!keys.space });
}

function castOnline(spell) {
  if (phase !== 'fight' || paused || !player.alive || (player.cds[spell] || 0) > gameTime) return;
  sendOnlineInput();
  multiplayer.send({ type: 'cast', spell });
  const cooldown = SPELL_DEFS[spell]?.cd || (spell === 'blink' ? 5 : 8);
  player.cds[spell] = gameTime + cooldown;
  sound.play(spell);
  castPulse = 1;
}

function updateOnline(dt) {
  if (!onlineState) return;
  const local = onlineState.players.find(p => p.id === onlineId);
  if (local) {
    const target = new THREE.Vector3(local.x, local.y, local.z);
    if (player.pos.distanceTo(target) > 5) player.pos.copy(target);
    else player.pos.lerp(target, 1 - Math.exp(-24 * dt));
  }
  for (const e of remoteEntities.values()) e.wiz.group.position.lerp(e.target, 1 - Math.exp(-18 * dt));
  onlineInputTime += dt;
  if (onlineInputTime >= 0.06) { onlineInputTime = 0; sendOnlineInput(); }
  if (mouseHeld) castOnline('fireball');
  updateCamera();
}

function setupRound() {
  for (const e of entities) if (e.isBot) disposeObject(e.wiz.group);
  entities.length = 0;
  clearEffects();
  gameTime = 0;
  yaw = 0;
  pitch = 0;
  player.onGround = true;
  player._lavaTick = 0;
  player.lastHit = null;
  player.staggerUntil = 0;
  player.pos.set(0, 0, 18);
  player.vel.set(0, 0, 0);
  player.hp = MAX_HP;
  player.dmgPts = 0;
  player.alive = true;
  player.shieldUntil = 0;
  player.cds = {};
  player.wiz.group.visible = false;
  entities.push(player);
  for (let i = 0; i < BOT_COUNT; i++) {
    const a = (i / BOT_COUNT) * Math.PI * 2 + 0.5;
    entities.push(makeBot(i, spawnPos(a, 12)));
  }
  arena.scale.setScalar(1);
  ring.scale.setScalar(1);
  arenaRadius = ARENA_RADIUS;
  ui.feed.innerHTML = "";
}

function currentKb(e) {
  return 1 + e.dmgPts * 0.012;
}

function addFeed(killerName, victimName) {
  const row = document.createElement("div");
  row.innerHTML = `<b>${killerName}</b> столкнул ${victimName} в лаву`;
  ui.feed.prepend(row);
  setTimeout(() => row.remove(), 6000);
}

function damage(target, dmg, kbVec, source) {
  if (!target.alive) return;
  const now = gameTime;
  if (source && now < target.shieldUntil) return;
  if (source) {
    target.lastHit = source;
    target.lastHitTime = gameTime;
  }
  target.hp -= dmg;
  target.dmgPts += dmg;
  if (kbVec && kbVec.lengthSq() > 0.0001) {
    applyKb(target, kbVec.clone().multiplyScalar(currentKb(target)));
    playAt('hit', target.pos);
  }
  if (target === player) flashDamage();
  if (target.hp <= 0) killEntity(target, source);
}

function applyKb(e, kb) {
  e.vel.x += kb.x * 0.9;
  e.vel.z += kb.z * 0.9;
  e.vel.y += Math.max(0, kb.y * 0.35) + kb.length() * 0.1;
  e.onGround = false;
  e.staggerUntil = gameTime + 0.65;
}

function killEntity(e, source) {
  e.alive = false;
  e.hp = 0;
  e.wiz.group.visible = false;
  if (source && source !== e) {
    source.kills++;
    if (source === player) STATE.gold += 2;
    addFeed(source.name, e.name);
    playAt('hit', e.pos);
  } else {
    addFeed("Лава", e.name);
  }
}

function physics(e, dt) {
  e.vel.y -= GRAVITY * dt;
  e.pos.x += e.vel.x * dt;
  e.pos.y += e.vel.y * dt;
  e.pos.z += e.vel.z * dt;

  const inside = Math.hypot(e.pos.x, e.pos.z) < arenaRadius - PLAYER_RADIUS;
  const floor = inside ? 0 : LAVA_Y;
  e.onGround = e.pos.y <= floor;
  if (e.onGround) {
    e.pos.y = floor;
    e.vel.y = Math.max(0, e.vel.y);
  }
  if (gameTime < (e.staggerUntil || 0)) {
    e.vel.x *= Math.exp(-1.8 * dt);
    e.vel.z *= Math.exp(-1.8 * dt);
  }

  e.wiz.group.position.copy(e.pos);
  if (e.isBot) {
    e.wiz.group.rotation.y = Math.atan2(player.pos.x - e.pos.x, player.pos.z - e.pos.z);
  }
}

function fireProjectile(owner, from, dir, spec) {
  if (owner !== player) playAt(spec.id, from);
  const colorMap = { fireball: 0xff6622, homing: 0x5599ff, meteor: 0xffaa22 };
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(spec.radius, 10, 10),
    new THREE.MeshBasicMaterial({ color: colorMap[spec.id] || 0xffaa33 })
  );
  mesh.position.copy(from);
  scene.add(mesh);
  projectiles.push({
    mesh, owner, spec,
    vel: dir.clone().normalize().multiplyScalar(spec.speed),
    born: gameTime,
  });
}

function spawnBolt(from, to) {
  const points = [];
  for (let i = 0; i <= 24; i++) {
    const point = from.clone().lerp(to, i / 24);
    if (i && i < 24) point.add(new THREE.Vector3((Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6));
    points.push(point);
  }
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0xcfeaff, transparent: true, opacity: 0.95 }));
  const flash = new THREE.PointLight(0x8acaff, 20, 16);
  flash.position.copy(to);
  const group = new THREE.Group();
  group.add(line, flash);
  scene.add(group);
  bolts.push({ line: group, born: gameTime, expires: performance.now() + 180 });
}

function hitscan(from, dir) {
  let best = null, bestT = Infinity;
  for (const e of entities) {
    if (!e.alive || e === player) continue;
    const c = e.pos.clone(); c.y += 1.0;
    const toC = c.clone().sub(from);
    const t = toC.dot(dir);
    if (t < 0) continue;
    const closest = from.clone().add(dir.clone().multiplyScalar(t));
    if (closest.distanceTo(c) < 1.0 && t < bestT) { best = e; bestT = t; }
  }
  if (best) return { ent: best, point: from.clone().add(dir.clone().multiplyScalar(bestT)) };
  return null;
}

function playerShoot(spec) {
  if (mode === 'online') { castOnline(spec.id); return; }
  if (!player.alive || phase !== "fight" || paused) return;
  const now = gameTime;
  if ((player.cds[spec.id] || 0) > now) return;
  player.cds[spec.id] = now + spec.cd * Math.pow(0.92, spec.level - 1);
  castPulse = 1;
  sound.play(spec.id);
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const from = camera.position.clone().add(dir.clone().multiplyScalar(1.2));
  from.y -= 0.25;
  if (spec.hitscan) {
    const res = hitscan(camera.position, dir);
    if (res) {
      const kb = dir.clone().setY(0.35).normalize().multiplyScalar(spec.kb + spec.kb * 0.15 * spec.level);
      damage(res.ent, spec.dmg + 2 * spec.level, kb, player);
      spawnBolt(from, res.point);
    } else {
      spawnBolt(from, camera.position.clone().add(dir.clone().multiplyScalar(60)));
    }
  } else {
    fireProjectile(player, from, dir, spec);
  }
}

function tryBlink() {
  if (mode === 'online') { castOnline('blink'); return; }
  if (!player.alive || phase !== "fight" || paused) return;
  const now = gameTime;
  if ((player.cds["blink"] || 0) > now) return;
  player.cds["blink"] = now + 5 * Math.pow(0.92, UTIL_DEFS.blink.level - 1);
  const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const dest = player.pos.clone().addScaledVector(fwd, 9 + UTIL_DEFS.blink.level);
  player.pos.copy(dest);
  if (Math.hypot(dest.x, dest.z) < arenaRadius - PLAYER_RADIUS) player.pos.y = Math.max(0, player.pos.y);
  player.vel.set(0, Math.max(player.vel.y, 0), 0);
  player.staggerUntil = 0;
  sound.play('blink');
  updateCamera();
}

function tryShield() {
  if (mode === 'online') { castOnline('shield'); return; }
  if (!player.alive || phase !== "fight" || paused) return;
  const now = gameTime;
  if ((player.cds["shield"] || 0) > now) return;
  player.cds["shield"] = now + 8 * Math.pow(0.92, UTIL_DEFS.shield.level - 1);
  player.shieldUntil = now + 2.5 + 0.3 * UTIL_DEFS.shield.level;
  sound.play('shield');
}

function botAI(e, dt) {
  if (!e.alive) return;
  e.strafeT -= dt;
  if (e.strafeT <= 0) { e.strafeT = 0.8 + Math.random() * 1.2; e.strafeDir = Math.random() < 0.5 ? -1 : 1; }
  let target = null, bd = 1e9;
  for (const o of entities) {
    if (!o.alive || o === e) continue;
    const d = o.pos.distanceTo(e.pos);
    if (d < bd) { bd = d; target = o; }
  }
  if (!target) return;
  const toT = target.pos.clone().sub(e.pos);
  toT.y = 0;
  const dist = toT.length();
  toT.normalize();

  const desired = new THREE.Vector3();
  const away = dist < 13 ? -1 : dist > 24 ? 1 : 0;
  desired.addScaledVector(toT, away * 0.7);
  desired.addScaledVector(new THREE.Vector3(-toT.z, 0, toT.x), e.strafeDir * 0.85);
  desired.normalize();

  const edge = Math.hypot(e.pos.x, e.pos.z);
  const centerPull = new THREE.Vector3(-e.pos.x, 0, -e.pos.z).normalize();
  if (edge > arenaRadius - 6) desired.addScaledVector(centerPull, 1.8);
  if (e.pos.y < -1.2) desired.addScaledVector(centerPull, 2.2);

  if (gameTime >= (e.staggerUntil || 0)) {
    desired.normalize().multiplyScalar(MOVE_SPEED * 0.58);
    const blend = 1 - Math.exp(-5 * dt);
    e.vel.x += (desired.x - e.vel.x) * blend;
    e.vel.z += (desired.z - e.vel.z) * blend;
  }

  e.fireCd -= dt;
  if (e.fireCd <= 0 && dist < 34) {
    const aim = target.pos.clone().add(new THREE.Vector3(0, 1, 0)).sub(e.pos.clone().add(new THREE.Vector3(0, 1.2, 0))).normalize();
    aim.x += (Math.random() - 0.5) * 0.07;
    aim.z += (Math.random() - 0.5) * 0.07;
    e.fireCd = 0.9 + Math.random() * 1.3;
    fireProjectile(e, e.pos.clone().setY(1.2), aim, { id: "fireball", dmg: 8, kb: 7, speed: 34, radius: 0.5 });
  }
}

function updateShieldVisuals(now) {
  for (const e of entities) {
    const on = now < e.shieldUntil;
    e.wiz.shield.visible = on;
    if (on) e.wiz.shield.scale.setScalar(1 + Math.sin(now * 8) * 0.03);
  }
}

function updatePlayerMove(dt) {
  if (!player.alive) return;
  const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const wish = new THREE.Vector3();
  if (keys.w) wish.add(fwd);
  if (keys.s) wish.sub(fwd);
  if (keys.d) wish.add(right);
  if (keys.a) wish.sub(right);
  if (gameTime >= (player.staggerUntil || 0)) {
    wish.normalize().multiplyScalar(MOVE_SPEED);
    const blend = 1 - Math.exp(-FRICTION * dt);
    player.vel.x += (wish.x - player.vel.x) * blend;
    player.vel.z += (wish.z - player.vel.z) * blend;
  }
  if (keys.space && player.onGround) {
    player.vel.y = JUMP_SPEED;
    player.onGround = false;
  }
}

function updateCamera() {
  camera.position.set(player.pos.x, player.pos.y + PLAYER_HEIGHT, player.pos.z);
  camera.rotation.order = "YXZ";
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;
  camera.rotation.z = 0;
}

function flashDamage() {
  sound.play('hit');
  ui.dmgFlash.style.opacity = "0.45";
  setTimeout(() => (ui.dmgFlash.style.opacity = "0"), 120);
}

let msgTimer = null;
function showMsg(text, dur = 2) {
  ui.msg.textContent = text;
  ui.msg.style.opacity = "1";
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => (ui.msg.style.opacity = "0"), dur * 1000);
}

function startFight() {
  setupRound();
  phase = "fight";
  paused = false;
  ui.menu.hidden = true;
  ui.pause.hidden = true;
  ui.shop.hidden = true;
  ui.hudShow(true);
  hand.visible = true;
  updateCamera();
  requestLock();
  showMsg("Раунд " + STATE.round + " — бой!", 2);
}

function endRound(playerWon) {
  sound.stop();
  sound.play(playerWon ? 'victory' : 'hit');
  phase = "shop";
  paused = false;
  clearInput();
  document.exitPointerLock();
  clearEffects();
  if (playerWon) wins++;
  const reward = playerWon ? 10 : 6;
  STATE.gold += reward;
  openShop();
  const finished = STATE.round >= TOTAL_ROUNDS;
  ui.shopTitle.textContent = finished ? "Турнир завершён" : playerWon ? "Арена твоя" : "Пламя победило";
  ui.shopSubtitle.textContent = finished
    ? `Победы: ${wins} из ${TOTAL_ROUNDS}. Убийства: ${player.kills}.`
    : `Раунд ${STATE.round}/${TOTAL_ROUNDS} · +${reward} золота. Подготовься к следующему бою.`;
  ui.shopItems.hidden = finished;
  ui.nextBtn.textContent = finished ? "НОВЫЙ ТУРНИР →" : "СЛЕДУЮЩИЙ РАУНД →";
}

function checkRoundEnd() {
  if (phase !== "fight") return;
  if (!player.alive) endRound(false);
  else if (entities.filter((e) => e.alive).length === 1) endRound(true);
}

function lavaCheck(e) {
  if (e.pos.y < LAVA_Y + 0.6) {
    const now = gameTime;
    if ((e._lavaTick || 0) < now) {
      e._lavaTick = now + 0.5;
      const source = gameTime - (e.lastHitTime || -100) < 8 ? e.lastHit : null;
      damage(e, STATE.lavaDmg, null, null);
      if (!e.alive && source === player && e !== player) {
        player.kills++;
        STATE.gold += 2;
      }
      if (e === player) showMsg("ЛАВА! Рывок (Q) к центру!", 0.9);
      e.vel.y = Math.max(e.vel.y, 7);
      e.vel.x *= 0.5;
      e.vel.z *= 0.5;
    }
  }
}

const SPELLS_FOR_SHOP = () => [
  ...Object.values(SPELL_DEFS).map((s) => ({ ...s, type: "spell" })),
  ...Object.values(UTIL_DEFS).map((s) => ({ ...s, type: "util" })),
];

function openShop() {
  phase = "shop";
  ui.shop.hidden = false;
  ui.hudShow(false);
  ui.shopTitle.textContent = "Раунд " + STATE.round + " из " + TOTAL_ROUNDS;
  ui.shopSubtitle.textContent = "Вложи золото в заклинания перед боем";
  ui.shopGold.textContent = "Золото: " + STATE.gold;
  renderShop();
}

function closeShop() {
  if (STATE.round >= TOTAL_ROUNDS) resetTournament();
  else STATE.round++;
  ui.shop.hidden = true;
  startFight();
}

function resetTournament() {
  STATE.round = 1;
  STATE.gold = 8;
  wins = 0;
  player.kills = 0;
  for (const s of [...Object.values(SPELL_DEFS), ...Object.values(UTIL_DEFS)]) s.level = 1;
}

function renderShop() {
  ui.shopGold.textContent = "Золото: " + STATE.gold;
  ui.shopItems.innerHTML = "";
  for (const item of SPELLS_FOR_SHOP()) {
    const lvl = item.level;
    const card = document.createElement("button");
    card.className = "shop-card";
    const maxed = lvl >= item.maxLevel;
    const cost = maxed ? 0 : Math.round(item.cost * Math.pow(1.6, lvl));
    card.disabled = maxed || cost > STATE.gold;
    const lvls = "◆".repeat(lvl) + "◇".repeat(item.maxLevel - lvl);
    card.innerHTML = `<span class="sc-level">${item.key} · ${lvls}</span>
      <span class="sc-name">${item.name}</span>
      <span class="sc-desc">${item.desc}</span>
      <span class="sc-price">${maxed ? "Максимум" : cost + " золота"}</span>`;
    if (!maxed && cost <= STATE.gold) {
      card.addEventListener("click", () => {
        STATE.gold -= cost;
        if (item.type === "spell") SPELL_DEFS[item.id].level++;
        else UTIL_DEFS[item.id].level++;
        renderShop();
      });
    }
    ui.shopItems.appendChild(card);
  }
}

function updateSpellbar() {
  ui.spells.innerHTML = "";
  const now = gameTime;
  const all = [...Object.values(SPELL_DEFS), ...Object.values(UTIL_DEFS)];
  for (const s of all) {
    const el = document.createElement("div");
    const cdLeft = Math.max(0, (player.cds[s.id] || 0) - now);
    const shadeH = cdLeft > 0 ? Math.min(100, (cdLeft / (s.cd || 5)) * 100) : 0;
    el.className = "spell" + (cdLeft > 0.05 ? " active" : "");
    el.innerHTML = `<span class="key">${s.key}</span><span class="name">${s.name}</span>
      <span class="level">ур. ${s.level}</span><span class="cooldown">${cdLeft > 0.05 ? cdLeft.toFixed(1) : ""}</span>
      <div class="shade" style="transform:scaleY(${shadeH / 100})"></div>`;
    ui.spells.appendChild(el);
  }
}

function hudVisible(v) {
  document.getElementById("hud").hidden = !v;
}
ui.hudShow = hudVisible;

let lastTime = performance.now();

function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
  let dt = (now - lastTime) / 1000;
  lastTime = now;
  dt = Math.min(dt, 0.05);
  const t = now / 1000;

  updateWorld(t);

  if (phase === 'fight' && mode === 'online') updateOnline(dt);
  if (phase === "fight" && !paused && mode === 'bots') {
    gameTime += dt;
    if (mouseHeld) playerShoot(SPELL_DEFS.fireball);
    arenaRadius = Math.max(8, arenaRadius - STATE.arenaShrink * dt);
    arena.scale.setScalar(arenaRadius / ARENA_RADIUS);
    ring.scale.setScalar(arenaRadius / ARENA_RADIUS);

    updatePlayerMove(dt);
    for (const e of entities) {
      if (!e.alive) continue;
      if (e.isBot) botAI(e, dt);
      physics(e, dt);
      lavaCheck(e);
    }
    updateProjectiles(dt);
    updateShieldVisuals(gameTime);
    updateCamera();
    checkRoundEnd();
  }

  if (phase === "fight") {
    ui.hp.style.width = Math.max(0, player.hp) + "%";
    ui.hpText.textContent = Math.max(0, player.hp | 0);
    ui.gold.textContent = mode === 'online' ? 'Без ботов · серверный бой' : "Золото " + STATE.gold;
    ui.round.textContent = mode === 'online' ? 'Комната ' + (onlineState?.code || '') : "Раунд " + STATE.round + "/" + TOTAL_ROUNDS;
    ui.alive.textContent = "Живых: " + (mode === 'online' ? onlineState?.players.filter(e => e.alive).length || 0 : entities.filter((e) => e.alive).length);
    ui.dmgPts.textContent = "Урон: " + (player.dmgPts | 0);
    ui.arenaSize.textContent = "Арена: " + (arenaRadius | 0) + " м";
    ui.lavaWarn.hidden = Math.hypot(player.pos.x, player.pos.z) < arenaRadius - 4;
    updateSpellbar();
  }

  for (let i = bolts.length - 1; i >= 0; i--) {
    if (performance.now() > bolts[i].expires) { disposeObject(bolts[i].line); bolts.splice(i, 1); }
  }
  if (phase !== "fight") ui.lavaWarn.hidden = true;
  hand.visible = phase === "fight";
  castPulse = Math.max(0, castPulse - dt * 4);
  hand.position.z = -1.1 + castPulse * 0.2;
  crystal.rotation.y += dt;
  renderer.render(scene, camera);
}

function updateProjectiles(dt) {
  const now = gameTime;
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    if (p.spec.homing) {
      let target = null, bd = 1e9;
      for (const e of entities) {
        if (!e.alive || e === p.owner) continue;
        const d = e.pos.clone().add(new THREE.Vector3(0, 1, 0)).distanceTo(p.mesh.position);
        if (d < bd) { bd = d; target = e; }
      }
      if (target && bd < 25) {
        const want = target.pos.clone().add(new THREE.Vector3(0, 1, 0)).sub(p.mesh.position).normalize().multiplyScalar(p.spec.speed);
        p.vel.lerp(want, Math.min(1, dt * 3.5));
      }
    }
    const previous = p.mesh.position.clone();
    p.mesh.position.addScaledVector(p.vel, dt);
    const segment = new THREE.Line3(previous, p.mesh.position);
    let hit = false;
    for (const e of entities) {
      if (!e.alive || e === p.owner) continue;
      const c = e.pos.clone().add(new THREE.Vector3(0, 1, 0));
      const closest = segment.closestPointToPoint(c, true, new THREE.Vector3());
      if (closest.distanceTo(c) < 1.0 + p.spec.radius) {
        if (gameTime < e.shieldUntil) {
          const previousOwner = p.owner;
          p.owner = e;
          p.vel.copy(previousOwner.pos).add(new THREE.Vector3(0, 1, 0)).sub(c).normalize().multiplyScalar(p.spec.speed);
          p.mesh.position.copy(c).addScaledVector(p.vel.clone().normalize(), 2.2);
          p.born = gameTime;
          break;
        }
        const kb = p.vel.clone().setY(0.4).normalize().multiplyScalar(p.spec.kb + p.spec.kb * 0.15 * (p.spec.level || 1));
        damage(e, p.spec.dmg + 2 * (p.spec.level || 1), kb, p.owner);
        hit = true;
        break;
      }
    }
    if (p.mesh.position.y < LAVA_Y) hit = true;
    if (hit || now - p.born > 4) {
      disposeObject(p.mesh);
      projectiles.splice(i, 1);
    }
  }
  for (let i = bolts.length - 1; i >= 0; i--) {
    if (now - bolts[i].born > 0.25) {
      disposeObject(bolts[i].line);
      bolts.splice(i, 1);
    }
  }
}

document.addEventListener("keydown", (ev) => {
  const k = ev.code.replace("Key", "").toLowerCase();
  keys[k] = true;
  if (ev.code === 'Space' && phase === 'fight' && !paused) ev.preventDefault();
  if (ev.code === 'Escape') {
    const openPanel = document.querySelector('.subpanel:not([hidden])');
    if (openPanel) openPanel.hidden = true;
    else if (phase === 'fight' && !paused) pauseGame();
    return;
  }
  if (phase !== "fight" || paused) return;
  if (ev.code === "Digit1" || ev.code === "KeyF") playerShoot(SPELL_DEFS.fireball);
  if (ev.code === "Digit2") playerShoot(SPELL_DEFS.lightning);
  if (ev.code === "Digit3") playerShoot(SPELL_DEFS.homing);
  if (ev.code === "Digit4") playerShoot(SPELL_DEFS.meteor);
  if (ev.code === "KeyQ") tryBlink();
  if (ev.code === "KeyE") tryShield();
});
document.addEventListener("keyup", (ev) => {
  keys[ev.code.replace("Key", "").toLowerCase()] = false;
});

function clearInput() {
  for (const key of Object.keys(keys)) delete keys[key];
  mouseHeld = false;
}

function pauseGame() {
  if (phase !== "fight") return;
  paused = true;
  clearInput();
  ui.pause.hidden = false;
  document.exitPointerLock();
}

async function requestLock() {
  void sound.unlock();
  paused = true;
  clearInput();
  const rawStatus = document.getElementById('raw-input-status');
  requestingLock = true;
  try {
    try {
      const request = renderer.domElement.requestPointerLock({ unadjustedMovement: true });
      await request;
      rawStatus.textContent = request && typeof request.then === 'function'
        ? 'Raw input активен: стандартная шкала CS2 без ускорения ОС.'
        : 'Браузер не подтверждает raw input: точное совпадение с CS2 не гарантируется.';
    } catch (error) {
      if (error.name !== 'NotSupportedError') throw error;
      await renderer.domElement.requestPointerLock();
      rawStatus.textContent = 'Raw input недоступен. Ускорение и настройки ОС могут менять сенсу.';
    }
  } catch {
    pauseGame();
    document.getElementById("pause-text").textContent = "Браузер не захватил мышь. Нажми «Продолжить» ещё раз.";
  } finally {
    requestingLock = false;
  }
}

function togglePause() {
  if (phase !== "fight") return;
  if (paused) requestLock();
  else pauseGame();
}

document.addEventListener("mousemove", (ev) => {
  if (locked && phase === "fight" && !paused) {
    yaw -= mouseRadians(ev.movementX, settings.sensitivity);
    pitch -= mouseRadians(ev.movementY, settings.sensitivity) * (settings.invertY ? -1 : 1);
    pitch = Math.max(-1.5, Math.min(1.5, pitch));
  }
});

renderer.domElement.addEventListener("mousedown", (ev) => {
  if (phase === "fight" && !paused && ev.button === 0) {
    mouseHeld = true;
    playerShoot(SPELL_DEFS.fireball);
  }
});

document.addEventListener("mouseup", () => { mouseHeld = false; });
window.addEventListener("blur", pauseGame);
document.addEventListener("pointerlockerror", () => {
  if (requestingLock || document.pointerLockElement === renderer.domElement || phase !== 'fight') return;
  paused = true;
  clearInput();
  ui.pause.hidden = false;
});

document.addEventListener("pointerlockchange", () => {
  locked = document.pointerLockElement === renderer.domElement;
  if (phase !== "fight") return;
  paused = !locked;
  ui.pause.hidden = locked;
  clearInput();
});

ui.resumeBtn.addEventListener("click", () => togglePause());
ui.nextBtn.addEventListener("click", closeShop);
document.getElementById("start-btn").addEventListener("click", () => {
  multiplayer.disconnect(false);
  mode = 'bots';
  document.getElementById('pause-text').textContent = 'Бой остановлен. Нажми «Продолжить».';
  resetTournament();
  void sound.unlock();
  startFight();
});

document.addEventListener('pointerdown', () => { void sound.unlock(); }, { once: true });
document.addEventListener('click', event => {
  if (event.target.closest('button')) {
    void sound.unlock();
    sound.play('ui');
  }
});
document.getElementById('audio-preview').addEventListener('click', () => sound.preview());
document.getElementById('exit-game-btn').addEventListener('click', () => multiplayer.disconnect());
for (const s of [...Object.values(SPELL_DEFS), ...Object.values(UTIL_DEFS)]) {
  const article = document.createElement('article');
  const title = document.createElement('b');
  title.textContent = s.key + ' · ' + s.name;
  const text = document.createElement('p');
  text.textContent = s.desc;
  article.append(title, text);
  document.getElementById('grimoire-spells').append(article);
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

tick();

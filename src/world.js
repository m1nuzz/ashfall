import * as THREE from "three";

const ARENA_RADIUS = 40;

const SPELLS = {
  fireball: { name: "Fireball", key: "1", cd: 0.55, dmg: 8, kb: 7, speed: 42, radius: 0.6, cost: 8, level: 0, maxLevel: 4 },
  lightning: { name: "Lightning", key: "2", cd: 4, dmg: 6, kb: 16, hitscan: true, cost: 10, level: 0, maxLevel: 4 },
  homing: { name: "Homing", key: "3", cd: 3, dmg: 6, kb: 9, speed: 20, radius: 0.6, homing: true, cost: 9, level: 0, maxLevel: 4 },
  meteor: { name: "Meteor", key: "4", cd: 6, dmg: 14, kb: 20, speed: 26, radius: 1.1, cost: 12, level: 0, maxLevel: 4 },
};

const UTILS = {
  blink: { name: "Blink", key: "q", cd: 5, dist: 9, cost: 7, level: 0, maxLevel: 4 },
  shield: { name: "Shield", key: "e", cd: 8, dur: 2.5, cost: 7, level: 0, maxLevel: 4 },
};

export const STATE = {
  gold: 5,
  round: 1,
  lavaDmg: 15,
  arenaShrink: 0.5,
};

function makeStoneTexture() {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d");
  g.fillStyle = "#26262c";
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 2800; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 1 + Math.random() * 9;
    const v = (20 + Math.random() * 42) | 0;
    g.fillStyle = `rgba(${v},${v},${v + 8},${0.05 + Math.random() * 0.14})`;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  for (let i = 0; i < 90; i++) {
    let x = Math.random() * size;
    let y = Math.random() * size;
    let a = Math.random() * Math.PI * 2;
    g.strokeStyle = "rgba(8,6,6,0.55)";
    g.lineWidth = 0.6 + Math.random() * 1.6;
    g.beginPath();
    g.moveTo(x, y);
    for (let s = 0; s < 8; s++) {
      a += (Math.random() - 0.5) * 1.3;
      x += Math.cos(a) * (6 + Math.random() * 18);
      y += Math.sin(a) * (6 + Math.random() * 18);
      g.lineTo(x, y);
    }
    g.stroke();
  }
  for (let i = 0; i < 26; i++) {
    let x = Math.random() * size;
    let y = Math.random() * size;
    let a = Math.random() * Math.PI * 2;
    g.strokeStyle = "rgba(255,110,30,0.22)";
    g.lineWidth = 0.5 + Math.random() * 1;
    g.beginPath();
    g.moveTo(x, y);
    for (let s = 0; s < 6; s++) {
      a += (Math.random() - 0.5) * 1.1;
      x += Math.cos(a) * (4 + Math.random() * 14);
      y += Math.sin(a) * (4 + Math.random() * 14);
      g.lineTo(x, y);
    }
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(9, 9);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function makeRuneTexture() {
  const size = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d");
  g.clearRect(0, 0, size, size);
  const c = size / 2;
  g.strokeStyle = "rgba(255,175,70,0.85)";
  g.lineWidth = 4;
  g.beginPath();
  g.arc(c, c, 480, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 2;
  g.beginPath();
  g.arc(c, c, 452, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.arc(c, c, 200, 0, Math.PI * 2);
  g.stroke();
  const slots = 40;
  for (let i = 0; i < slots; i++) {
    const a = (i / slots) * Math.PI * 2;
    const rx = c + Math.cos(a) * 326;
    const ry = c + Math.sin(a) * 326;
    g.save();
    g.translate(rx, ry);
    g.rotate(a + Math.PI / 2);
    g.strokeStyle = "rgba(255,180,80,0.9)";
    g.lineWidth = 3.5;
    g.beginPath();
    const h = 26;
    g.moveTo(0, -h);
    g.lineTo(0, h);
    const n = 1 + ((Math.random() * 3) | 0);
    for (let k = 0; k < n; k++) {
      const yy = -h + (k + 1) * ((2 * h) / (n + 1));
      const dir = Math.random() < 0.5 ? -1 : 1;
      g.moveTo(0, yy);
      g.lineTo(dir * (6 + Math.random() * 8), yy + (Math.random() - 0.5) * 8);
    }
    if (Math.random() < 0.5) {
      g.moveTo(-6, -h + 4);
      g.lineTo(6, -h + 4);
    }
    g.stroke();
    g.restore();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export function createWorld() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a12);
  scene.fog = new THREE.Fog(0x0a0a12, 60, 140);

  const hemi = new THREE.HemisphereLight(0x8888aa, 0x30201a, 0.7);
  scene.add(hemi);

  const dir = new THREE.DirectionalLight(0xff8844, 0.35);
  dir.position.set(-20, 30, 10);
  scene.add(dir);

  const lavaUniforms = { uTime: { value: 0 } };
  const lava = new THREE.Mesh(
    new THREE.CircleGeometry(ARENA_RADIUS + 30, 64),
    new THREE.ShaderMaterial({
      uniforms: lavaUniforms,
      vertexShader:
        "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader:
        "uniform float uTime; varying vec2 vUv;" +
        "float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }" +
        "float noise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);" +
        "  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }" +
        "float fbm(vec2 p){ float v = 0.0; float a = 0.5;" +
        "  for(int k = 0; k < 5; k++){ v += a * noise(p); p = p * 2.03 + vec2(17.0, 9.0); a *= 0.5; } return v; }" +
        "void main(){" +
        "  vec2 p = vUv * 16.0;" +
        "  float t = uTime * 0.06;" +
        "  float n1 = fbm(p + vec2(t, t * 0.7));" +
        "  float n2 = fbm(p * 1.9 - vec2(t * 1.4, t * 0.5));" +
        "  float m = n1 * 0.6 + n2 * 0.4;" +
        "  vec3 cool = vec3(0.16, 0.02, 0.0);" +
        "  vec3 mid = vec3(0.9, 0.22, 0.02);" +
        "  vec3 hot = vec3(1.0, 0.78, 0.3);" +
        "  vec3 col = mix(cool, mid, smoothstep(0.34, 0.6, m));" +
        "  col = mix(col, hot, smoothstep(0.6, 0.84, m));" +
        "  gl_FragColor = vec4(col * 1.7, 1.0);" +
        "}"
    })
  );
  lava.rotation.x = -Math.PI / 2;
  lava.position.y = -2.5;
  scene.add(lava);

  const emberCount = 420;
  const emberPos = new Float32Array(emberCount * 3);
  for (let i = 0; i < emberCount; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = ARENA_RADIUS + 2 + Math.random() * 55;
    emberPos[i * 3] = Math.cos(a) * r;
    emberPos[i * 3 + 1] = -2 + Math.random() * 9;
    emberPos[i * 3 + 2] = Math.sin(a) * r;
  }
  const emberGeo = new THREE.BufferGeometry();
  emberGeo.setAttribute("position", new THREE.BufferAttribute(emberPos, 3));
  const embers = new THREE.Points(
    emberGeo,
    new THREE.PointsMaterial({
      color: 0xff7a2a,
      size: 0.4,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    })
  );
  scene.add(embers);

  const spireMat = new THREE.MeshStandardMaterial({ color: 0x14141c, roughness: 0.95, metalness: 0.05 });
  for (let i = 0; i < 34; i++) {
    const a = (i / 34) * Math.PI * 2 + (Math.random() - 0.5) * 0.25;
    const r = ARENA_RADIUS + 14 + Math.random() * 26;
    const h = 10 + Math.random() * 26;
    const rad = 1.6 + Math.random() * 3.4;
    const spire = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.35, rad, h, 6, 1), spireMat);
    spire.position.set(Math.cos(a) * r, h / 2 - 3, Math.sin(a) * r);
    spire.rotation.z = (Math.random() - 0.5) * 0.14;
    spire.rotation.x = (Math.random() - 0.5) * 0.14;
    scene.add(spire);
  }

  const arena = new THREE.Mesh(
    new THREE.CircleGeometry(ARENA_RADIUS, 72),
    new THREE.MeshStandardMaterial({ color: 0x8a8a92, map: makeStoneTexture(), roughness: 0.92, metalness: 0.05 })
  );
  arena.rotation.x = -Math.PI / 2;
  scene.add(arena);

  const runeTex = makeRuneTexture();
  const runeMat = new THREE.MeshBasicMaterial({ map: runeTex, transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const runeRing = new THREE.Mesh(new THREE.RingGeometry(ARENA_RADIUS * 0.52, ARENA_RADIUS * 0.9, 96), runeMat);
  runeRing.position.z = 0.03;
  arena.add(runeRing);

  const innerRune = new THREE.Mesh(
    new THREE.RingGeometry(ARENA_RADIUS * 0.16, ARENA_RADIUS * 0.21, 48),
    new THREE.MeshBasicMaterial({ color: 0xffaa33, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide })
  );
  innerRune.position.z = 0.03;
  arena.add(innerRune);

  const rockMat = new THREE.MeshStandardMaterial({ color: 0x2a2a32, roughness: 0.9 });
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 6 + Math.random() * (ARENA_RADIUS - 9);
    const s = 0.4 + Math.random() * 1.4;
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), rockMat);
    rock.position.set(Math.cos(a) * r, Math.sin(a) * r, s * 0.25);
    rock.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    rock.scale.y = 0.6 + Math.random() * 0.5;
    arena.add(rock);
  }

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(ARENA_RADIUS - 0.6, ARENA_RADIUS, 72),
    new THREE.MeshBasicMaterial({ color: 0xffaa33, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  scene.add(ring);

  function updateWorld(time) {
    lavaUniforms.uTime.value = time;
  }

  return { scene, lava, arena, ring, ARENA_RADIUS, SPELLS, UTILS, updateWorld };
}

export { ARENA_RADIUS };

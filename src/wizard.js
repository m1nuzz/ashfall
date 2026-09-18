import * as THREE from "three";

const BOT_COLORS = [0xcc4444, 0x4466cc, 0x66cc44, 0xccaa44, 0xaa44cc, 0x44cccc];

export function createWizard(color = 0xdd6622, skin = 'default') {
  const palette = { ember: 0xff713b, void: 0xb383ff, storm: 0x63dcff };
  const premium = Object.hasOwn(palette, skin);
  color = palette[skin] ?? color;
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.55), roughness: 0.8, metalness: 0.15 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.62, 1.6, 12), bodyMat);
  body.position.y = 0.8;
  group.add(body);
  const trim = new THREE.MeshStandardMaterial({ color: premium ? color : 0xb99a68, metalness: 0.7, roughness: 0.3, emissive: premium ? color : 0, emissiveIntensity: 0.3 });
  const add = (geometry, material, x, y, z) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z); group.add(mesh); return mesh;
  };
  add(new THREE.TorusGeometry(0.31, 0.045, 6, 20), trim, 0, 1.3, 0).rotation.x = Math.PI / 2;
  add(new THREE.CylinderGeometry(0.39, 0.5, 0.25, 8), bodyMat, -0.31, 1.52, 0).rotation.z = -0.6;
  add(new THREE.CylinderGeometry(0.39, 0.5, 0.25, 8), bodyMat, 0.31, 1.52, 0).rotation.z = 0.6;
  for (const side of [-1, 1]) {
    add(new THREE.CylinderGeometry(0.14, 0.21, 0.65, 8), bodyMat, side * 0.42, 1.15, 0.12).rotation.z = side * 0.25;
    add(new THREE.OctahedronGeometry(0.14), trim, side * 0.38, 1.65, 0.1);
  }
  for (let i = 0; i < 8; i++) {
    const angle = i * Math.PI / 4;
    const strip = add(new THREE.BoxGeometry(0.035, 1.2, 0.025), trim, Math.sin(angle) * 0.45, 0.65, Math.cos(angle) * 0.45);
    strip.rotation.y = angle; strip.rotation.x = -0.18;
  }
  if (premium) {
    const halo = add(new THREE.TorusGeometry(0.52, 0.022, 6, skin === 'void' ? 6 : 32), trim, 0, 2.45, 0);
    halo.rotation.x = Math.PI / 2;
    for (let i = 0; i < 3; i++) add(new THREE.OctahedronGeometry(0.12), trim, Math.sin(i * 2.1) * 0.48, 2.52, Math.cos(i * 2.1) * 0.48);
  }
  group.userData.skin = skin;

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.28, 12, 12),
    new THREE.MeshStandardMaterial({ color: 0x111019, roughness: 0.95 })
  );
  head.position.y = 1.85;
  group.add(head);

  const hatMat = new THREE.MeshStandardMaterial({ color, roughness: 0.5 });
  const hatBrim = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.5, 0.06, 12), hatMat);
  hatBrim.position.y = 2.0;
  group.add(hatBrim);
  const hatCone = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.55, 12), hatMat);
  hatCone.position.y = 2.28;
  group.add(hatCone);

  const staff = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.05, 1.8, 6),
    new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.9 })
  );
  staff.position.set(0.45, 1.0, 0.1);
  staff.rotation.z = 0.12;
  group.add(staff);

  const orb = new THREE.Mesh(
    new THREE.SphereGeometry(0.11, 10, 10),
    new THREE.MeshBasicMaterial({ color: premium ? color : 0xffaa33 })
  );
  orb.position.set(0.55, 1.95, 0.1);
  group.add(orb);

  const eyeGeo = new THREE.SphereGeometry(0.04, 6, 6);
  const eyeMat = new THREE.MeshBasicMaterial({ color: premium ? color : 0xffb675 });
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  eyeL.position.set(-0.09, 1.88, 0.26);
  group.add(eyeL);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
  eyeR.position.set(0.09, 1.88, 0.26);
  group.add(eyeR);

  const shieldGeo = new THREE.SphereGeometry(1.3, 16, 12);
  const shieldMat = new THREE.MeshBasicMaterial({
    color: 0x66ddff,
    transparent: true,
    opacity: 0.28,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const shield = new THREE.Mesh(shieldGeo, shieldMat);
  shield.position.y = 1.0;
  shield.visible = false;
  group.add(shield);

  return { group, shield, orb };
}

export { BOT_COLORS };

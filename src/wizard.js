import * as THREE from "three";

const BOT_COLORS = [0xcc4444, 0x4466cc, 0x66cc44, 0xccaa44, 0xaa44cc, 0x44cccc];

export function createWizard(color = 0xdd6622) {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1 });
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.6, 8), bodyMat);
  body.position.y = 0.8;
  group.add(body);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.28, 12, 12),
    new THREE.MeshStandardMaterial({ color: 0xe8c39e, roughness: 0.7 })
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
    new THREE.MeshBasicMaterial({ color: 0xffaa33 })
  );
  orb.position.set(0.55, 1.95, 0.1);
  group.add(orb);

  const eyeGeo = new THREE.SphereGeometry(0.04, 6, 6);
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
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

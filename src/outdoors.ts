// 窓の外の景色。庭の芝生・塀・生け垣・木・隣家。窓から見える遠景なので、凝らずに淡い色の箱で組む
import * as THREE from "three";

/** 淡い色。部屋の家具（Kenney）の色づかいに合わせる */
const COLOR = {
  grass: 0x9bc77a,
  fence: 0xf3ead8,
  fenceBase: 0xbdb4a2,
  hedge: 0x6aa65e,
  trunk: 0x8a6a4a,
  leaf: 0x78b862,
  leafDark: 0x5fa352,
  wall: 0xeadfca,
  roof: 0xc27564,
  glass: 0x7da6c4,
};

/** 外は日なたで明るすぎるので、淡い色を少し落とす（落とさないと白く飛ぶ） */
const OUTDOOR_DIM = 0.62;
const material = (color: number) => {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 1, envMapIntensity: 0 });
  m.color.multiplyScalar(OUTDOOR_DIM);
  return m;
};

function box(w: number, h: number, d: number, color: number, x: number, y: number, z: number) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material(color));
  m.position.set(x, y + h / 2, z);
  return m;
}

function tree(x: number, z: number, scale: number) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(2.4 * scale, 3.2 * scale, 42 * scale, 8), material(COLOR.trunk));
  trunk.position.y = 21 * scale;
  const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(24 * scale, 1), material(COLOR.leaf));
  crown.position.y = 58 * scale;
  const crown2 = new THREE.Mesh(new THREE.IcosahedronGeometry(16 * scale, 1), material(COLOR.leafDark));
  crown2.position.set(13 * scale, 48 * scale, 6 * scale);
  g.add(trunk, crown, crown2);
  g.position.set(x, 0, z);
  return g;
}

/** 隣の家。四角い壁、方形の屋根、窓の列 */
function neighbour(x: number, z: number, w: number, d: number, h: number) {
  const g = new THREE.Group();
  g.add(box(w, h, d, COLOR.wall, 0, 0, 0));
  const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.hypot(w, d) / 2 * 1.08, h * 0.45, 4), material(COLOR.roof));
  roof.rotation.y = Math.PI / 4;
  roof.scale.set(w / Math.hypot(w, d) * 1.45, 1, d / Math.hypot(w, d) * 1.45);
  roof.position.y = h + h * 0.225;
  g.add(roof);
  // 窓: 手前の面（+z 側。部屋の窓から見える面）に2段
  const cols = Math.max(2, Math.floor(w / 50));
  for (let row = 0; row < 2; row++) {
    for (let c = 0; c < cols; c++) {
      const wx = -w / 2 + (w / (cols + 1)) * (c + 1);
      g.add(box(16, 20, 1, COLOR.glass, wx, h * (0.2 + row * 0.42), d / 2 + 0.5));
    }
  }
  g.position.set(x, 0, z);
  return g;
}

/** 部屋の外側。z が負の側（窓のある奥）に景色を置き、左右にも少し足す。house は家の半幅と奥行 */
export function addOutdoors(scene: THREE.Scene, houseHalf: number) {
  const g = new THREE.Group();
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(1800, 1800), material(COLOR.grass));
  grass.rotation.x = -Math.PI / 2;
  // 居間の床（-0.04）と近いと、奥行きの精度が足りず床に緑がちらつく。床の下へ十分に離す
  grass.position.y = -1.2;
  g.add(grass);

  // 奥の塀と生け垣（窓の正面）。塀は板の列、足元に石の基礎
  const fenceZ = -165; // 窓の前に庭の芝生が見えるくらい離す
  g.add(box(520, 6, 3, COLOR.fenceBase, 0, 0, fenceZ));
  for (let x = -260; x <= 260; x += 6) g.add(box(4.2, 30, 1.2, COLOR.fence, x, 6, fenceZ));
  g.add(box(520, 4, 2.4, COLOR.fence, 0, 22, fenceZ + 0.2));
  g.add(box(520, 26, 12, COLOR.hedge, 0, 0, fenceZ - 14));

  // 木と隣家
  g.add(tree(-55, -125, 1.0), tree(75, -135, 1.25), tree(-190, -150, 0.9), tree(190, -140, 1.1));
  g.add(neighbour(-20, -300, 230, 140, 130), neighbour(260, -330, 180, 130, 110));

  // 左右（廊下の玄関の先・畳の部屋の窓の先）にも塀と木を少し
  for (const side of [-1, 1]) {
    const sx = side * (houseHalf + 175);
    g.add(box(3, 6, 260, COLOR.fenceBase, sx, 0, 8));
    for (let z = -120; z <= 136; z += 6) g.add(box(1.2, 30, 4.2, COLOR.fence, sx, 6, z));
    g.add(tree(side * (houseHalf + 215), 20, 1.1));
    g.add(tree(side * (houseHalf + 215), -60, 0.95));
  }
  // 家は庭より一段高い。玄関の土間（床より下）が芝に隠れない深さまで、庭ごと下げる
  g.position.y = -GARDEN_DROP;
  scene.add(g);
  return g;
}

/** 庭を床から下げる量。玄関の上がり框の段（`STEP_UP`）より深くする */
export const GARDEN_DROP = 4.7;

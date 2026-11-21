// マットに直に置く町なみ（Unity §10.7）。ビル・家・山・木・森を、寸法から作る。
// 形と寸法はカタログ（json）が決め、色と細部（窓・扉・瓦・葉の塊）はここで描く。レールが主役なので、
// 彩度は抑えつつ、Unity 版の暗い塊よりずっと明るい、玩具の街の色にする
import * as THREE from "three";

export interface PropDef {
  id: string;
  label: string;
  at: string;
  build: string;
  size?: number[];
  height?: number;
  storey?: number;
  crown?: number;
  member?: number;
  clump?: number;
  colours?: string[];
}

/** コースに保存する形（Unity の `SavedProp` と同じ） */
export interface PropSave {
  id: string;
  position: { x: number; y: number; z: number };
  yaw: number;
}

export function extractFreeProps(defs: PropDef[]): PropDef[] {
  const free = defs.filter((d) => d.at === "free").map((d) => ({ ...d }));
  // 木は2種類（広葉樹と針葉樹）。木 2 は web 版で足した。森は2種類を交互に植える
  const tree = free.find((d) => d.id === "Tree");
  if (tree) {
    tree.label = "木 1";
    free.splice(free.indexOf(tree) + 1, 0, { ...tree, id: "Tree2", label: "木 2" });
  }
  return free;
}

export async function loadProps(base: string): Promise<PropDef[]> {
  const ids: string[] = await (await fetch(`${base}data/scenery.json`)).json();
  const defs = await Promise.all(
    ids.map(async (id) => (await (await fetch(`${base}data/Scenery/${id}/${id}.json`)).json()) as PropDef),
  );
  return extractFreeProps(defs);
}

// --- 材質と絵 ---

const mat = (color: number | string | THREE.Texture, roughness = 0.85) =>
  new THREE.MeshStandardMaterial(
    color instanceof THREE.Texture ? { map: color, roughness, metalness: 0 } : { color: new THREE.Color(color), roughness, metalness: 0 },
  );

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext("2d")!);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

const cache = new Map<string, THREE.Texture>();
const cached = (key: string, make: () => THREE.Texture) => {
  let t = cache.get(key);
  if (!t) cache.set(key, (t = make()));
  return t;
};

/** ビルの1階ぶんの壁。cols 列の窓。窓は空を映す青、枠と窓台は白、壁は wall 色 */
function floorTexture(cols: number, wall: string, glass: [string, string], trim: string) {
  return cached(`floor:${cols}:${wall}:${glass[0]}`, () => {
    const cw = 96;
    const t = canvasTexture(cw * cols, 128, (g) => {
      g.fillStyle = wall;
      g.fillRect(0, 0, cw * cols, 128);
      // 床の継ぎ目（上端の細い帯）
      g.fillStyle = "rgba(0,0,0,0.10)";
      g.fillRect(0, 0, cw * cols, 6);
      g.fillStyle = "rgba(255,255,255,0.22)";
      g.fillRect(0, 6, cw * cols, 3);
      for (let c = 0; c < cols; c++) {
        const x = c * cw + 18;
        const y = 30;
        const w = cw - 36;
        const h = 62;
        // 窓枠
        g.fillStyle = trim;
        g.fillRect(x - 4, y - 4, w + 8, h + 8);
        // 窓ガラス（上が明るい）
        const grad = g.createLinearGradient(0, y, 0, y + h);
        grad.addColorStop(0, glass[0]);
        grad.addColorStop(1, glass[1]);
        g.fillStyle = grad;
        g.fillRect(x, y, w, h);
        // 桟と、反射の斜め線
        g.fillStyle = trim;
        g.fillRect(x + w / 2 - 1.5, y, 3, h);
        g.fillStyle = "rgba(255,255,255,0.28)";
        g.beginPath();
        g.moveTo(x + 6, y + h);
        g.lineTo(x + 24, y);
        g.lineTo(x + 36, y);
        g.lineTo(x + 18, y + h);
        g.fill();
        // 窓台
        g.fillStyle = "rgba(0,0,0,0.18)";
        g.fillRect(x - 6, y + h + 4, w + 12, 5);
      }
    });
    return t;
  });
}

/** ビルの1階（店先）。大きなガラスの店と、入口の扉、ひさし */
function shopTexture(cols: number, wall: string, accent: string) {
  return cached(`shop:${cols}:${wall}:${accent}`, () => {
    const cw = 96;
    return canvasTexture(cw * cols, 128, (g) => {
      g.fillStyle = wall;
      g.fillRect(0, 0, cw * cols, 128);
      const doorCol = Math.floor(cols / 2);
      for (let c = 0; c < cols; c++) {
        const x = c * cw + 8;
        if (c === doorCol) {
          g.fillStyle = "#4a3a30";
          g.fillRect(x + 6, 28, cw - 28, 100);
          g.fillStyle = "#9ec3d6";
          g.fillRect(x + 12, 34, cw - 40, 70);
          g.fillStyle = "#e8d9a8";
          g.fillRect(x + cw - 34, 78, 4, 14);
        } else {
          g.fillStyle = "#3b3f45";
          g.fillRect(x - 2, 38, cw - 12, 80);
          const grad = g.createLinearGradient(0, 40, 0, 116);
          grad.addColorStop(0, "#bfe0ee");
          grad.addColorStop(1, "#7aa8c0");
          g.fillStyle = grad;
          g.fillRect(x + 2, 42, cw - 20, 72);
          g.fillStyle = "rgba(255,255,255,0.3)";
          g.beginPath();
          g.moveTo(x + 8, 114);
          g.lineTo(x + 30, 42);
          g.lineTo(x + 44, 42);
          g.lineTo(x + 22, 114);
          g.fill();
        }
      }
      // ひさし（縞）
      for (let x = 0; x < cw * cols; x += 24) {
        g.fillStyle = (x / 24) % 2 === 0 ? accent : "#f4efe4";
        g.fillRect(x, 6, 24, 24);
      }
      g.fillStyle = "rgba(0,0,0,0.25)";
      g.fillRect(0, 30, cw * cols, 5);
    });
  });
}

/** 家の正面。扉と窓（雨戸つき） */
function houseFront(wall: string, trim: string) {
  return cached(`hfront:${wall}`, () =>
    canvasTexture(256, 192, (g) => {
      g.fillStyle = wall;
      g.fillRect(0, 0, 256, 192);
      g.fillStyle = "rgba(0,0,0,0.08)";
      g.fillRect(0, 176, 256, 16);
      // 窓（左と右）
      for (const x of [22, 168]) {
        g.fillStyle = trim;
        g.fillRect(x - 6, 36, 76, 66);
        const grad = g.createLinearGradient(0, 40, 0, 98);
        grad.addColorStop(0, "#cfe8f3");
        grad.addColorStop(1, "#86b2c9");
        g.fillStyle = grad;
        g.fillRect(x, 42, 64, 54);
        g.fillStyle = trim;
        g.fillRect(x + 31, 42, 3, 54);
        g.fillRect(x, 67, 64, 3);
        // 雨戸
        g.fillStyle = "#7f9b78";
        g.fillRect(x - 20, 36, 14, 66);
        g.fillRect(x + 70, 36, 14, 66);
      }
      // 扉
      g.fillStyle = trim;
      g.fillRect(104, 60, 48, 132);
      g.fillStyle = "#8b5a3c";
      g.fillRect(109, 66, 38, 126);
      g.fillStyle = "#6e4630";
      g.fillRect(114, 74, 28, 40);
      g.fillRect(114, 122, 28, 56);
      g.fillStyle = "#e6c866";
      g.beginPath();
      g.arc(140, 132, 3, 0, Math.PI * 2);
      g.fill();
    }),
  );
}

/** 家の側面・背面。窓がひとつ */
function houseSide(wall: string, trim: string) {
  return cached(`hside:${wall}`, () =>
    canvasTexture(256, 192, (g) => {
      g.fillStyle = wall;
      g.fillRect(0, 0, 256, 192);
      g.fillStyle = "rgba(0,0,0,0.08)";
      g.fillRect(0, 176, 256, 16);
      g.fillStyle = trim;
      g.fillRect(90, 50, 76, 70);
      const grad = g.createLinearGradient(0, 56, 0, 114);
      grad.addColorStop(0, "#cfe8f3");
      grad.addColorStop(1, "#86b2c9");
      g.fillStyle = grad;
      g.fillRect(96, 56, 64, 58);
      g.fillStyle = trim;
      g.fillRect(126, 56, 3, 58);
    }),
  );
}

/** 瓦屋根。棟と平行な段 */
function tileTexture(color: string) {
  return cached(`tile:${color}`, () =>
    canvasTexture(128, 128, (g) => {
      g.fillStyle = color;
      g.fillRect(0, 0, 128, 128);
      for (let y = 0; y < 128; y += 16) {
        g.fillStyle = "rgba(0,0,0,0.22)";
        g.fillRect(0, y, 128, 3);
        g.fillStyle = "rgba(255,255,255,0.12)";
        g.fillRect(0, y + 3, 128, 2);
        for (let x = (y / 16) % 2 ? 0 : 8; x < 128; x += 16) {
          g.fillStyle = "rgba(0,0,0,0.12)";
          g.fillRect(x, y + 3, 2, 13);
        }
      }
    }),
  );
}

// --- 形 ---

function mesh(geo: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const o = new THREE.Mesh(geo, m);
  o.position.set(x, y, z);
  o.castShadow = true;
  o.receiveShadow = true;
  return o;
}

/** ビルの色の組。同じ色が並ぶと1つの塊に見えるので、種類ごとに変える */
const BLOCK_STYLES: Record<string, { wall: string; trim: string; glass: [string, string]; accent: string; roof: number }> = {
  BuildingLarge: { wall: "#d8c9ae", trim: "#f6f1e6", glass: ["#bfe2f2", "#6f9fbd"], accent: "#c8553d", roof: 0x8a8d90 },
  BuildingSmall: { wall: "#b9c7d3", trim: "#fbfbf8", glass: ["#d3ecf6", "#7fb0cc"], accent: "#3f7fb5", roof: 0x7d8286 },
};

/** ビル。1階は店先、上は窓の列。屋上に手すりと室外機（大は水槽も） */
function block(def: PropDef, g: THREE.Group) {
  const w = def.size?.[0] ?? 1.5;
  const d = def.size?.[1] ?? 1.5;
  const tall = def.height ?? 3;
  const storey = def.storey ?? 0.8333;
  const style = BLOCK_STYLES[def.id] ?? BLOCK_STYLES.BuildingSmall!;
  const cols = Math.max(2, Math.round(w / 0.75));
  const colsDeep = Math.max(2, Math.round(d / 0.75));
  const floors = Math.max(2, Math.round(tall / storey));
  const upper = (floors - 1) * storey;
  const roofMat = mat(style.roof, 0.9);

  // 1階（店先）。正面・背面は店、側面は壁
  const shopFront = shopTexture(cols, style.wall, style.accent);
  const wallSide = floorTexture(colsDeep, style.wall, style.glass, style.trim);
  const ground = new THREE.Mesh(new THREE.BoxGeometry(w, storey, d), [
    mat(wallSide.clone(), 0.8),
    mat(wallSide.clone(), 0.8),
    roofMat,
    roofMat,
    mat(shopFront, 0.8),
    mat(shopFront, 0.8),
  ]);
  ground.position.y = storey / 2;
  ground.castShadow = ground.receiveShadow = true;
  g.add(ground);

  // 上の階。窓の列を階数ぶん繰り返す
  const front = floorTexture(cols, style.wall, style.glass, style.trim).clone();
  front.repeat.set(1, floors - 1);
  front.needsUpdate = true;
  const sideT = floorTexture(colsDeep, style.wall, style.glass, style.trim).clone();
  sideT.repeat.set(1, floors - 1);
  sideT.needsUpdate = true;
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, upper, d), [
    mat(sideT, 0.8),
    mat(sideT, 0.8),
    roofMat,
    roofMat,
    mat(front, 0.8),
    mat(front, 0.8),
  ]);
  body.position.y = storey + upper / 2;
  body.castShadow = body.receiveShadow = true;
  g.add(body);

  // 屋上の縁と、設備
  const rim = 0.07;
  const top = storey + upper;
  const trimMat = mat(style.trim, 0.8);
  g.add(mesh(new THREE.BoxGeometry(w + 0.1, 0.06, d + 0.1), trimMat, 0, top + 0.03, 0));
  for (const [sx, sz, lx, lz] of [
    [0, d / 2, w, rim],
    [0, -d / 2, w, rim],
    [w / 2, 0, rim, d],
    [-w / 2, 0, rim, d],
  ] as const) {
    g.add(mesh(new THREE.BoxGeometry(lx, 0.12, lz), trimMat, sx, top + 0.12, sz));
  }
  const unit = mat(0xcfd3d6, 0.6);
  g.add(mesh(new THREE.BoxGeometry(w * 0.28, 0.16, d * 0.28), unit, -w * 0.22, top + 0.14, -d * 0.18));
  g.add(mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.03, 12), mat(0x555a5e), -w * 0.22, top + 0.23, -d * 0.18));
  if (def.id === "BuildingLarge") {
    // 水槽と、塔屋
    g.add(mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.34, 14), mat(0xb7bcc0, 0.6), w * 0.2, top + 0.3, d * 0.15));
    g.add(mesh(new THREE.ConeGeometry(0.22, 0.12, 14), mat(0x8a8f93), w * 0.2, top + 0.53, d * 0.15));
    g.add(mesh(new THREE.BoxGeometry(w * 0.3, 0.24, d * 0.3), trimMat, -w * 0.2, top + 0.2, d * 0.2));
    // アンテナ
    g.add(mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.6, 6), mat(0x9a9a9a), w * 0.3, top + 0.4, -d * 0.3));
  }
}

/** 家。正面に扉と窓、切妻の瓦屋根（軒を出す）、煙突、玄関の段 */
function house(def: PropDef, g: THREE.Group) {
  const w = def.size?.[0] ?? 1.5;
  const d = def.size?.[1] ?? 2.25;
  const eaves = def.height ?? 1.39;
  const ridge = def.storey ?? 0.78;
  const out = def.member ?? 0.17;
  const wall = "#efe3c9";
  const trim = "#fbf6ea";
  // 棟は長いほうへ。正面は短辺側（家の顔）
  const alongZ = d >= w;
  const frontT = houseFront(wall, trim).clone();
  frontT.needsUpdate = true;
  const sideT = houseSide(wall, trim).clone();
  sideT.needsUpdate = true;
  const plain = mat(wall, 0.9);
  // 箱: +x -x +y -y +z -z。棟が z 方向なら、顔は +z（妻側）。x 方向なら顔は -x ではなく +z（平側）
  const faces = alongZ
    ? [mat(sideT, 0.85), mat(sideT.clone(), 0.85), plain, plain, mat(frontT, 0.85), mat(sideT.clone(), 0.85)]
    : [mat(sideT, 0.85), mat(sideT.clone(), 0.85), plain, plain, mat(frontT, 0.85), mat(sideT.clone(), 0.85)];
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, eaves, d), faces);
  body.position.y = eaves / 2;
  body.castShadow = body.receiveShadow = true;
  g.add(body);

  const along = (alongZ ? d : w) / 2;
  const across = (alongZ ? w : d) / 2;
  // 妻壁の三角
  const shape = new THREE.Shape([new THREE.Vector2(-across, 0), new THREE.Vector2(across, 0), new THREE.Vector2(0, ridge)]);
  const gableMat = mat(wall, 0.9);
  gableMat.side = THREE.DoubleSide;
  for (const side of [-1, 1]) {
    const tri = mesh(new THREE.ShapeGeometry(shape), gableMat);
    tri.position.set(alongZ ? 0 : side * along, eaves, alongZ ? side * along : 0);
    tri.rotation.y = alongZ ? 0 : Math.PI / 2;
    g.add(tri);
  }
  // 屋根の斜面2枚（瓦）
  const slopeLen = Math.hypot(across + out, ridge);
  const angle = Math.atan2(ridge, across + out);
  for (const side of [-1, 1]) {
    const tile = tileTexture("#b4573c").clone();
    tile.needsUpdate = true;
    tile.repeat.set(Math.max(1, Math.round((along + out) * 2.4)), Math.max(1, Math.round(slopeLen * 2.4)));
    const lenAlong = 2 * (along + out);
    const slab = mesh(new THREE.BoxGeometry(alongZ ? slopeLen : lenAlong, 0.05, alongZ ? lenAlong : slopeLen), mat(tile, 0.8));
    const mid = (across + out) / 2;
    if (alongZ) {
      slab.position.set(side * mid, eaves + ridge / 2 + 0.02, 0);
      slab.rotation.z = -side * angle;
    } else {
      slab.position.set(0, eaves + ridge / 2 + 0.02, side * mid);
      slab.rotation.x = side * angle;
    }
    g.add(slab);
  }
  // 棟の押さえ
  const ridgeBox = mesh(
    new THREE.BoxGeometry(alongZ ? 0.09 : 2 * (along + out), 0.07, alongZ ? 2 * (along + out) : 0.09),
    mat(0x8e3f2c, 0.8),
    0,
    eaves + ridge + 0.04,
    0,
  );
  g.add(ridgeBox);
  // 煙突
  const chimneyPos = alongZ ? [across * 0.45, -along * 0.4] : [-along * 0.4, across * 0.45];
  const cx = chimneyPos[0]!;
  const cz = chimneyPos[1]!;
  g.add(mesh(new THREE.BoxGeometry(0.2, ridge * 0.9, 0.2), mat(0x9a6b55, 0.9), cx, eaves + ridge * 0.75, cz));
  g.add(mesh(new THREE.BoxGeometry(0.26, 0.05, 0.26), mat(0x6c4a3c, 0.9), cx, eaves + ridge * 1.22, cz));
  // 玄関の段（顔の前）
  g.add(mesh(new THREE.BoxGeometry(0.34, 0.04, 0.2), mat(0xb9b3a6, 0.9), 0, 0.02, (alongZ ? along : across) + 0.1));
}

/** 山。ゆるい起伏のある草の塊。頂は明るく、裾は濃く。岩を少し */
function hill(def: PropDef, g: THREE.Group) {
  const r = (def.size?.[0] ?? 6) / 2;
  const tall = def.height ?? 3.33;
  const rings = 7;
  const sides = 14;
  const geo = new THREE.BufferGeometry();
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const base = new THREE.Color(0x4f8f3e);
  const top = new THREE.Color(0x9cd16a);
  const rock = new THREE.Color(0x9a958c);
  // 決め打ちの起伏（置き直しで形が変わらない）
  const wob = (i: number, j: number) => Math.sin(i * 12.9898 + j * 78.233) * 0.5 + 0.5;
  for (let j = 0; j <= rings; j++) {
    const t = j / rings;
    const radius = r * (1 - t) ** 0.85 * (j === rings ? 0.08 : 1);
    const height = tall * (1 - (1 - t) ** 1.7);
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const bump = 1 + (wob(i, j) - 0.5) * 0.16 * (1 - t);
      pos.push(Math.cos(a) * radius * bump, height + (wob(j, i) - 0.5) * 0.12 * (1 - t), Math.sin(a) * radius * bump);
      const c = base.clone().lerp(top, Math.min(1, t * 1.15));
      if (t > 0.55 && wob(i, j) > 0.8) c.lerp(rock, 0.6); // 稜線に岩肌
      col.push(c.r, c.g, c.b);
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < sides; i++) {
      const a = j * sides + i;
      const b = j * sides + ((i + 1) % sides);
      idx.push(a, a + sides, b, b, a + sides, b + sides);
    }
  }
  // 頂の蓋
  const topCentre = pos.length / 3;
  pos.push(0, tall + 0.02, 0);
  col.push(top.r, top.g, top.b);
  for (let i = 0; i < sides; i++) idx.push(rings * sides + i, topCentre, rings * sides + ((i + 1) % sides));
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  const flat = geo.toNonIndexed();
  flat.computeVertexNormals();
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true, side: THREE.DoubleSide });
  g.add(mesh(flat, m));
  // 裾に岩と、小さな灌木
  const rockMat = mat(0x8f8b83, 0.95);
  rockMat.flatShading = true;
  for (const [a, k, s] of [[0.5, 0.82, 0.3], [2.3, 0.9, 0.22], [4.1, 0.78, 0.26]] as const) {
    const rk = mesh(new THREE.DodecahedronGeometry(s, 0), rockMat, Math.cos(a) * r * k, s * 0.45, Math.sin(a) * r * k);
    rk.rotation.set(a, a * 2, 0);
    g.add(rk);
  }
}

/** 葉の塊の色。1本ごとに少しずつ変える */
const LEAVES = [0x5aa845, 0x6cba52, 0x4a9a3c, 0x7bc45a];

function blob(radius: number, color: number, x: number, y: number, z: number, squash = 0.88) {
  const geo = new THREE.IcosahedronGeometry(radius, 1);
  geo.scale(1, squash, 1);
  const m = mat(color, 0.9);
  m.flatShading = true;
  return mesh(geo, m, x, y, z);
}

/** 木。幹と、3つの丸い葉の塊。clump 本まとめると森（針葉樹を混ぜる）。並べ方は決め打ち */
function trees(def: PropDef, g: THREE.Group) {
  const count = Math.max(1, def.clump ?? 1);
  const crown = def.crown ?? def.size?.[0] ?? 0.95;
  const spreadOver = def.size?.[0] ?? crown;
  const tall = def.height ?? 1.67;
  const trunk = def.member ?? 0.22;
  const bark = mat(0x7a5532, 0.95);
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / Math.max(1, count - (count > 1 ? 1 : 0));
    const spread = count > 1 ? Math.max(0, spreadOver - crown) * 0.5 : 0;
    const x = Math.cos(angle) * spread * (i % 2 === 0 ? 1 : 0.55);
    const z = Math.sin(angle * 1.3) * spread * 0.7;
    const size = count > 1 ? (i % 3 === 0 ? 0.8 : 1) : 1;
    const top = tall * size;
    const radius = (crown * size) / 2;
    const conifer = count > 1 ? i % 2 === 1 : def.id === "Tree2";
    // 幹（根元が太い）
    g.add(mesh(new THREE.CylinderGeometry(trunk * 0.32, trunk * 0.5, top * 0.5, 8), bark, x, (top * 0.5) / 2, z));
    if (conifer) {
      // 針葉樹: 重ねた円錐
      for (let k = 0; k < 3; k++) {
        const kr = radius * (1.05 - k * 0.25);
        const cone = new THREE.ConeGeometry(kr, top * 0.36, 9);
        const m = mat(k % 2 ? 0x2f7a3e : 0x3a8a47, 0.9);
        m.flatShading = true;
        g.add(mesh(cone, m, x, top * (0.42 + k * 0.2), z));
      }
    } else {
      const c = LEAVES[i % LEAVES.length]!;
      g.add(blob(radius, c, x, top * 0.62, z));
      g.add(blob(radius * 0.72, LEAVES[(i + 1) % LEAVES.length]!, x + radius * 0.4, top * 0.74, z + radius * 0.15, 0.9));
      g.add(blob(radius * 0.62, LEAVES[(i + 2) % LEAVES.length]!, x - radius * 0.35, top * 0.8, z - radius * 0.2, 0.9));
    }
  }
}

const BUILDERS: Record<string, (def: PropDef, g: THREE.Group) => void> = { block, house, hill, tree: trees };

/** 部品の局所（Unity の座標。左手系の x をそのまま置く）で組んだ物 */
export function buildProp(def: PropDef): THREE.Group {
  const g = new THREE.Group();
  BUILDERS[def.build]?.(def, g);
  return g;
}

/** 平面での外形の半径（選択の枠と当たり判定の目安） */
export function propRadius(def: PropDef): number {
  const w = def.size?.[0] ?? 1;
  const d = def.size?.[1] ?? w;
  return Math.hypot(w, d) / 2;
}

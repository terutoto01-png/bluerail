// 高架の橋脚。高さのある継ぎ目の真下に自動で積む（Unity 版 §10.4）。置いた橋脚という概念は持たず、毎回作り直す
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import type { Catalog } from "./catalog";
import type { PieceSave } from "./course";
import { samplePath, toWorld } from "./track";
import { toStandard } from "./scenery";

/** ミニ橋脚の高さ。ブロック橋脚はこの4個ぶん（1.6667）。単位は Unity 版と同じ */
export const MINI_HEIGHT = 0.4166667;
const BLOCK_MINIS = 4;
const LEVEL_HEIGHT = MINI_HEIGHT * BLOCK_MINIS;
/** ミニ橋脚の半分に満たない高さには立てない */
const MIN_HEIGHT = MINI_HEIGHT / 2;
/** 柱を共有する平面上のセル（m）。同じ継ぎ目に集まる複数の部品が、同じ場所へ橋脚を重ねない */
const CELL = 0.25;

/** 道床の幅（Unity の `ShadowWidth`） */
const TRACK_WIDTH = 1.0556;
/** 橋脚の半幅＋道床の半幅。足元からこの距離に下の線路があれば、柱は線路を横切って立つ */
const PIER_CLEAR = LEVEL_HEIGHT * 0.5 + TRACK_WIDTH * 0.5;
/** 柱を脇へ寄せるときの歩幅と、諦める距離（レール半分） */
const SHIFT_STEP = 0.25;
const SHIFT_LIMIT = 3;
/** 柱を貫かれる角度。塔は許して交差は止める。cos 30° */
const ALONG_DOT = 0.87;
/** 函の屋根の縁。継ぎ目は函の端そのものなので、回転の誤差で裏返らないよう半枡ぶん食い込ませる */
const DECK_SLACK = 0.125;

export interface PierModels {
  block: THREE.Group;
  mini: THREE.Group;
}

const loader = new FBXLoader();
let models: Promise<PierModels> | null = null;

/** 橋脚のモデル。FBX は cm・右手系なので 0.01 倍して x を反転し、底面を y=0・平面の中心を原点にそろえる */
export function loadPierModels(baseUrl: string): Promise<PierModels> {
  models ??= (async () => {
    const one = async (name: string) => {
      const src = await loader.loadAsync(`${baseUrl}data/Piers/${name}.fbx`);
      src.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.material = Array.isArray(o.material) ? o.material.map((m) => toStandard(m, 0.66)) : toStandard(o.material, 0.66);
        o.castShadow = o.receiveShadow = true;
      });
      const holder = new THREE.Group();
      src.scale.set(-0.01, 0.01, 0.01);
      holder.add(src);
      holder.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(holder);
      const c = box.getCenter(new THREE.Vector3());
      src.position.set(-c.x, -box.min.y, -c.z);
      return holder;
    };
    return { block: await one("Bridge_Pier_Block"), mini: await one("Bridge_Pier_Mini") };
  })();
  return models;
}

/** ミニ橋脚 n 個ぶんの高さを、ミニ橋脚・ブロック橋脚の並びにする。余りのミニは下 */
export function pierStack(n: number): ("mini" | "block")[] {
  const out: ("mini" | "block")[] = [];
  for (let i = 0; i < n % BLOCK_MINIS; i++) out.push("mini");
  for (let i = 0; i < Math.floor(n / BLOCK_MINIS); i++) out.push("block");
  return out;
}

interface Joint {
  x: number;
  y: number;
  z: number;
  /** 道床の向き（Unity の yaw、度） */
  yaw: number;
}

interface TrackPoint {
  x: number;
  y: number;
  z: number;
  /** 進む向き（水平）の単位ベクトル */
  dx: number;
  dz: number;
}

/** 置かれた線路の中心線を刻んだ点。**宣言された道を全部**刻む（複線の2本目も、いま刃が向いていない脚も） */
function trackPoints(catalog: Catalog, pieces: PieceSave[]): TrackPoint[] {
  const out: TrackPoint[] = [];
  for (const piece of pieces) {
    const def = catalog.of(piece);
    if (!def) continue;
    const yaw = (piece.euler.y * Math.PI) / 180;
    for (const path of def.paths) {
      if ((path as { frames?: unknown }).frames) continue;
      for (const q of samplePath(def, path, 0.38)) {
        const [x, y, z] = toWorld(piece, [q.x, q.y, q.z]);
        const h = q.heading - yaw;
        out.push({ x, y, z, dx: Math.sin(h), dz: -Math.cos(h) });
      }
    }
  }
  return out;
}

/** この柱の足元を、下の線路が横切っているか。from は積み始める高さ、facing は支えるレールの向き */
function trackUnder(points: TrackPoint[], at: THREE.Vector3, from: number, facing: THREE.Vector2): boolean {
  const r2 = PIER_CLEAR * PIER_CLEAR;
  for (const p of points) {
    if (p.y > at.y - MINI_HEIGHT * 0.5) continue; // 支える当のレールは対象外。足元より下だけ見る
    if (p.y < from - MINI_HEIGHT * 0.5) continue;
    const dx = p.x - at.x;
    const dz = p.z - at.z;
    if (dx * dx + dz * dz > r2) continue;
    if (Math.abs(p.dx * facing.x + p.dz * facing.y) >= ALONG_DOT) continue; // 真上に重ねた塔はレールの継ぎ目に載る
    return true;
  }
  return false;
}

/** 交差の手前（sign −1）か先（+1）で、下のレールに掛からないいちばん近い所 */
function clearSpot(points: TrackPoint[], joint: THREE.Vector3, along: THREE.Vector2, from: number, sign: number) {
  for (let step = SHIFT_STEP; step <= SHIFT_LIMIT; step += SHIFT_STEP) {
    const spot = new THREE.Vector3(joint.x + along.x * step * sign, joint.y, joint.z + along.y * step * sign);
    if (!trackUnder(points, spot, from, along)) return spot;
  }
  return null;
}

/** 函の屋根（`deck`）。屋根の上面の高さと、平面上の外形 */
interface Deck {
  top: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function decksOf(
  catalog: Catalog,
  pieces: PieceSave[],
  localBounds: (kind: string) => THREE.Box3 | null,
): Deck[] {
  const out: Deck[] = [];
  for (const piece of pieces) {
    const def = catalog.get(piece.kind);
    const box = def?.deck ? localBounds(piece.kind) : null;
    if (!def?.deck || !box) continue;
    const xs: number[] = [];
    const zs: number[] = [];
    for (const lx of [box.min.x, box.max.x]) {
      for (const lz of [box.min.z, box.max.z]) {
        const [x, , z] = toWorld(piece, [lx, 0, lz]);
        xs.push(x);
        zs.push(z);
      }
    }
    out.push({
      top: def.deck + piece.position.y,
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minZ: Math.min(...zs),
      maxZ: Math.max(...zs),
    });
  }
  return out;
}

/** その継ぎ目は、函の屋根の上に座っているか。函が支えているので柱は要らない */
function standsOnDeck(decks: Deck[], j: Joint): boolean {
  return decks.some(
    (d) =>
      Math.abs(j.y - d.top) <= MINI_HEIGHT * 0.5 &&
      j.x >= d.minX - DECK_SLACK &&
      j.x <= d.maxX + DECK_SLACK &&
      j.z >= d.minZ - DECK_SLACK &&
      j.z <= d.maxZ + DECK_SLACK,
  );
}

/**
 * 橋脚を積んだグループ（Unity の座標）を返す。
 * 柱は平面上の1か所に1本。地面からいちばん低い継ぎ目まで積み、そこから次の継ぎ目まで積み足す。
 * 各区間は「いま立っている高さ」から測るので、丸めの誤差が柱の中でずれていかない。
 * 函の屋根の上の継ぎ目には積まない。下を線路が横切る継ぎ目では、柱を脇へ寄せて2本にする
 */
export function buildSupports(
  catalog: Catalog,
  pieces: PieceSave[],
  pier: PierModels,
  /** 部品の外形（Unity の局所座標）。函の屋根の判定に使う */
  localBounds: (kind: string) => THREE.Box3 | null,
): THREE.Group {
  const group = new THREE.Group();
  const cells = new Map<string, Joint[]>();
  for (const piece of pieces) {
    const def = catalog.of(piece);
    if (!def) continue;
    for (const port of def.ports) {
      const [x, y, z] = toWorld(piece, port.position);
      if (y < MIN_HEIGHT) continue;
      const key = `${Math.round(x / CELL)}:${Math.round(z / CELL)}`;
      const joints = cells.get(key) ?? [];
      // 同じ高さの継ぎ目は1つにまとめる（同じ継ぎ目に集まる複数の部品）
      if (!joints.some((j) => Math.abs(j.y - y) < MINI_HEIGHT * 0.5)) {
        joints.push({ x, y, z, yaw: piece.euler.y + port.euler[1] });
      }
      cells.set(key, joints);
    }
  }
  if (!cells.size) return group;

  const points = trackPoints(catalog, pieces);
  const decks = decksOf(catalog, pieces, localBounds);

  for (const joints of cells.values()) {
    joints.sort((a, b) => a.y - b.y);
    let top = 0;
    for (const joint of joints) {
      if (standsOnDeck(decks, joint)) {
        top = joint.y; // 函が支えている。柱はここから先へ続く
        continue;
      }
      const yaw = THREE.MathUtils.degToRad(joint.yaw);
      const along = new THREE.Vector2(Math.sin(yaw), Math.cos(yaw));
      const at = new THREE.Vector3(joint.x, joint.y, joint.z);
      const spots: THREE.Vector3[] = [];
      if (trackUnder(points, at, top, along)) {
        for (const sign of [-1, 1]) {
          const s = clearSpot(points, at, along, top, sign);
          if (s) spots.push(s);
        }
      } else spots.push(at);

      // 数えるのは1度。2本立てるときも同じ高さの山を2つ積む
      const n = Math.round((joint.y - top) / MINI_HEIGHT);
      if (n <= 0) continue; // すでに立っている柱で届いている
      for (const spot of spots) {
        let stood = top;
        for (const kind of pierStack(n)) {
          const p = pier[kind].clone();
          p.position.set(spot.x, stood, spot.z);
          // 道床の向きへ。モデル自身の取り込み回転に掛ける（置き換えると仰向けに倒れる）
          p.rotation.y = yaw;
          group.add(p);
          stood += kind === "block" ? LEVEL_HEIGHT : MINI_HEIGHT;
        }
      }
      top += n * MINI_HEIGHT;
    }
  }
  return group;
}

// 人がかぶせる装飾（トンネル・鉄橋。Unity §10.6）。形は部品の道に沿って実行時に組む
import * as THREE from "three";
import type { Catalog, RailDef } from "./catalog";
import type { PieceSave } from "./course";
import { layPath } from "./route";
import { toWorld } from "./track";

export interface WornDef {
  id: string;
  label: string;
  build: "tube" | "truss";
  profile?: number[];
  frames?: number[];
  height?: number;
  member?: number;
  panel?: number;
  topFrom?: number;
  tallHeight?: number;
  skip?: string[];
  colours?: string[];
}

/**
 * `scenery.tunnel.*` / `scenery.bridge.*` の色。Unity の値（UiPalette.json）は画面で暗く沈むので、
 * web 版は明るい草と石、赤い鉄骨に描き直した
 */
const COLOURS: Record<string, number> = {
  "scenery.tunnel.shell": 0x5f9f4a,
  "scenery.tunnel.bore": 0x2b2f2a,
  "scenery.tunnel.portal": 0xbdb6a6,
  "scenery.bridge.red": 0xd04a3a,
  "scenery.bridge.redTop": 0xe8624f,
};

export const WORN_IDS = ["Tunnel", "Bridge"];

const defs = new Map<string, Promise<WornDef>>();
export function loadWorn(base: string, id: string): Promise<WornDef> {
  let p = defs.get(id);
  if (!p) {
    p = fetch(`${base}data/Scenery/${id}/${id}.json`).then((r) => r.json() as Promise<WornDef>);
    defs.set(id, p);
  }
  return p;
}

/** 中央の道が1本で、弧が1つまで。分岐・S字・複線には掛けられない（Unity の `StraightRun`） */
export function centrePath(def: RailDef) {
  const paths = def.paths.filter((p) => !p.lane && !(p as { frames?: unknown }).frames);
  if (paths.length !== 1 || def.paths.some((p) => p.lane)) return null;
  const arcs = paths[0]!.segments.filter((s) => s.turn !== 0).length;
  return arcs <= 1 ? paths[0]! : null;
}

export const wearable = (def: RailDef | undefined, worn: WornDef) =>
  !!def && !!centrePath(def) && !(worn.skip ?? []).some((c) => def.categories.includes(c));

interface Frame {
  p: THREE.Vector3;
  /** 進行方向に直交する水平の横向き */
  side: THREE.Vector3;
}

/** 部品の中心線を世界の点列と横向きにする */
function centreline(def: RailDef, piece: PieceSave): Frame[] {
  const poses = layPath(def, centrePath(def)!);
  const yaw = (piece.euler.y * Math.PI) / 180;
  return poses.map((q) => {
    const [x, y, z] = toWorld(piece, [q.x, q.y, q.z]);
    const h = q.heading - yaw;
    return { p: new THREE.Vector3(x, y, z), side: new THREE.Vector3(Math.cos(h), 0, Math.sin(h)) };
  });
}

const material = (c: string | undefined, side: THREE.Side = THREE.DoubleSide) =>
  new THREE.MeshStandardMaterial({ color: COLOURS[c ?? ""] ?? 0x808080, roughness: 0.9, metalness: 0, side });

function addMesh(g: THREE.Group, verts: number[], idx: number[], mat: THREE.Material) {
  if (!idx.length) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = m.receiveShadow = true;
  g.add(m);
}

/** トンネル。断面（外を1周して内を逆に戻る輪）を中心線に沿って掃く。口は繋がっていない側だけ */
function tube(def: RailDef, piece: PieceSave, worn: WornDef, g: THREE.Group, portals: [boolean, boolean]) {
  const prof = worn.profile!;
  const pts: [number, number][] = [];
  for (let i = 0; i < prof.length; i += 2) pts.push([prof[i]!, prof[i + 1]!]);
  // 外周は、最初に y=0 へ戻る点（右の裾）まで。残りが内張り
  const k = pts.findIndex((p, i) => i > 0 && p[1] === 0);
  const frames = centreline(def, piece);
  const at = (f: Frame, j: number) => f.p.clone().addScaledVector(f.side, pts[j]![0]).add(new THREE.Vector3(0, pts[j]![1], 0));
  const shell: number[] = [];
  const shellIdx: number[] = [];
  const bore: number[] = [];
  const boreIdx: number[] = [];
  const ring = (verts: number[], f: Frame, from: number, to: number) => {
    for (let j = from; j <= to; j++) verts.push(...at(f, j).toArray());
  };
  const sweep = (verts: number[], idx: number[], from: number, to: number) => {
    const n = to - from + 1;
    frames.forEach((f) => ring(verts, f, from, to));
    for (let i = 0; i < frames.length - 1; i++) {
      for (let j = 0; j < n - 1; j++) {
        const a = i * n + j;
        const b = (i + 1) * n + j;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  };
  sweep(shell, shellIdx, 0, k);
  sweep(bore, boreIdx, k + 1, pts.length - 1);
  addMesh(g, shell, shellIdx, material(worn.colours?.[0]));
  addMesh(g, bore, boreIdx, material(worn.colours?.[1]));
  // 坑門（輪の形の蓋）
  const outer = pts.slice(0, k + 1).map((p) => new THREE.Vector2(p[0], p[1]));
  const inner = pts.slice(k + 1).map((p) => new THREE.Vector2(p[0], p[1]));
  const tri = THREE.ShapeUtils.triangulateShape(outer, [inner]);
  const portal: number[] = [];
  const portalIdx: number[] = [];
  [0, frames.length - 1].forEach((fi, e) => {
    if (!portals[e]) return;
    const base = portal.length / 3;
    const f = frames[fi]!;
    for (let j = 0; j < pts.length; j++) portal.push(...at(f, j).toArray());
    for (const t of tri) portalIdx.push(base + t[0]!, base + t[1]!, base + t[2]!);
  });
  addMesh(g, portal, portalIdx, material(worn.colours?.[2]));
}

/** 鉄橋。弦・斜材・柱を箱の部材で組む。区画は偶数（斜めが交互に向く） */
function truss(frames: Frame[], worn: WornDef, g: THREE.Group) {
  const run = [0];
  for (let i = 1; i < frames.length; i++) run.push(run[i - 1]! + frames[i]!.p.distanceTo(frames[i - 1]!.p));
  const total = run[run.length - 1]!;
  if (total < 0.01) return;
  const panels = Math.max(2, 2 * Math.round(total / Math.max(0.01, worn.panel ?? 1.5) / 2));
  const half = (worn.member ?? 0.22) / 2;
  const large = (worn.topFrom ?? 0) > 0 && total >= (worn.topFrom ?? 0);
  const rise = large && worn.tallHeight ? worn.tallHeight : (worn.height ?? 1.67);
  const along = (s: number): Frame => {
    let i = 1;
    while (i < run.length - 1 && run[i]! < s) i++;
    const t = Math.min(1, Math.max(0, (s - run[i - 1]!) / Math.max(1e-4, run[i]! - run[i - 1]!)));
    return { p: frames[i - 1]!.p.clone().lerp(frames[i]!.p, t), side: frames[i]!.side };
  };
  const node = (panel: number, top: boolean, side: number) => {
    const f = along((total * panel) / panels);
    return f.p.clone().addScaledVector(f.side, side).add(new THREE.Vector3(0, top ? rise : 0, 0));
  };
  const mat = material(worn.colours?.[0], THREE.FrontSide);
  const beam = (a: THREE.Vector3, b: THREE.Vector3, trim = 0) => {
    const len = a.distanceTo(b) - trim * 2;
    if (len <= 0.001) return;
    const m = new THREE.Mesh(new THREE.BoxGeometry(half * 2, half * 2, len), mat);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.lookAt(b);
    m.castShadow = m.receiveShadow = true;
    g.add(m);
  };
  const sides = worn.frames ?? [-0.64, 0.64];
  for (const side of sides) {
    for (let i = 0; i < panels; i++) {
      beam(node(i, false, side), node(i + 1, false, side), -half);
      if (i > 0 && i < panels - 1) beam(node(i, true, side), node(i + 1, true, side), -half);
      const low = node(i % 2 === 0 ? i : i + 1, false, side);
      const high = node(i % 2 === 0 ? i + 1 : i, true, side);
      const slope = Math.max(0.25, Math.abs(high.y - low.y) / Math.max(1e-4, low.distanceTo(high)));
      beam(low, high, half / slope);
    }
  }
  if (large && sides.length >= 2) {
    for (let i = 1; i < panels; i += 2) beam(node(i, true, sides[0]!), node(i, true, sides[sides.length - 1]!));
  }
}

/** 隣の部品も同じ装飾を着ているか（継ぎ目の口が重なる部品）。着ていれば坑門を立てない */
function wornNeighbour(catalog: Catalog, pieces: PieceSave[], piece: PieceSave, end: [number, number, number], id: string) {
  return pieces.some((o) => {
    if (o === piece || !(o.decorations ?? []).includes(id)) return false;
    return (catalog.of(o)?.ports ?? []).some((q) => {
      const w = toWorld(o, q.position);
      return Math.hypot(w[0] - end[0], w[1] - end[1], w[2] - end[2]) < 0.05;
    });
  });
}

/**
 * 同じ装飾を着て、1本に繋がった部品の並びを、1本の中心線にする（Unity の `RunOf`）。
 * 枝分かれ・輪になる並びは1本にできないので、部品ごとに任せる（戻り値に含めない）
 */
function runsOf(catalog: Catalog, pieces: PieceSave[], id: string, worn: WornDef): { members: number[]; frames: Frame[] }[] {
  const wearing = pieces.map((p, i) => i).filter((i) => (pieces[i]!.decorations ?? []).includes(id) && wearable(catalog.of(pieces[i]!), worn));
  const lines = new Map(wearing.map((i) => [i, centreline(catalog.of(pieces[i]!)!, pieces[i]!)]));
  const near = (a: Frame, b: Frame) => a.p.distanceTo(b.p) < 0.05;
  const ends = (i: number) => [lines.get(i)![0]!, lines.get(i)!.at(-1)!];
  const links = new Map<number, number[]>(wearing.map((i) => [i, wearing.filter((j) => j !== i && ends(i).some((a) => ends(j).some((b) => near(a, b))))]));
  const seen = new Set<number>();
  const out: { members: number[]; frames: Frame[] }[] = [];
  for (const start of wearing) {
    if (seen.has(start)) continue;
    // 連結成分
    const comp = [start];
    seen.add(start);
    for (let k = 0; k < comp.length; k++) for (const j of links.get(comp[k]!)!) if (!seen.has(j)) (seen.add(j), comp.push(j));
    const simple = comp.every((i) => links.get(i)!.length <= 2) && comp.some((i) => links.get(i)!.length <= 1);
    if (!simple) continue;
    // 端から順に並べ、向きを揃えて繋ぐ
    const first = comp.find((i) => links.get(i)!.length <= 1)!;
    const order = [first];
    while (order.length < comp.length) {
      const next = links.get(order.at(-1)!)!.find((j) => !order.includes(j));
      if (next === undefined) break;
      order.push(next);
    }
    let frames: Frame[] = [];
    order.forEach((i, k) => {
      let line = lines.get(i)!;
      const joinWith = frames.length ? frames.at(-1)! : order[1] !== undefined ? ends(order[1])[0]! : null;
      if (frames.length) {
        if (!near(line[0]!, joinWith!)) line = [...line].reverse();
      } else if (joinWith && !ends(order[1]!).some((b) => near(line.at(-1)!, b))) line = [...line].reverse();
      frames = frames.concat(frames.length ? line.slice(1) : line);
      void k;
    });
    out.push({ members: order, frames });
  }
  return out;
}

export async function buildWorn(base: string, catalog: Catalog, pieces: PieceSave[]): Promise<THREE.Group> {
  const out = new THREE.Group();
  // 鉄橋は、繋がった部品を1本の橋にする
  const bridged = new Set<number>();
  for (const id of WORN_IDS) {
    const worn = await loadWorn(base, id);
    if (worn.build !== "truss") continue;
    for (const run of runsOf(catalog, pieces, id, worn)) {
      const g = new THREE.Group();
      truss(run.frames, worn, g);
      out.add(g);
      run.members.forEach((i) => bridged.add(i));
    }
  }
  for (const [pi, piece] of pieces.entries()) {
    const def = catalog.of(piece);
    for (const id of piece.decorations ?? []) {
      if (!WORN_IDS.includes(id) || !def) continue;
      const worn = await loadWorn(base, id);
      if (!wearable(def, worn)) continue;
      if (worn.build === "truss" && bridged.has(pi)) continue;
      const g = new THREE.Group();
      if (worn.build === "tube") {
        const line = centreline(def, piece);
        const ends: [number, number, number][] = [
          [line[0]!.p.x, line[0]!.p.y, line[0]!.p.z],
          [line.at(-1)!.p.x, line.at(-1)!.p.y, line.at(-1)!.p.z],
        ];
        tube(def, piece, worn, g, [!wornNeighbour(catalog, pieces, piece, ends[0]!, id), !wornNeighbour(catalog, pieces, piece, ends[1]!, id)]);
      } else truss(centreline(def, piece), worn, g);
      out.add(g);
    }
  }
  return out;
}

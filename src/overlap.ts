// 置けるかどうかの判定（Unity §5.6）。経路を短い帯に割り、平面の分離軸で当たりを取る。three には依存しない
import type { Catalog, PathDef, RailDef } from "./catalog";
import type { PieceSave } from "./course";
import { isUpstream, type OpenPort } from "./place";
import { portHeading, samplePath, toWorld } from "./track";

/** 継ぎ目とみなす距離（Unity の `JoinEpsilon` / `JoinTolerance`） */
const JOIN = 0.05;
/** 帯の刻み幅（Unity と同じ 0.38） */
const STEP = 0.38;
/** 1階層。橋脚1本ぶん */
const LEVEL = 1.6667;
/** ミニ橋脚の高さ */
const MINI = 0.4167;
/** 下を電車が通れる高さ。Unity の `StoreyClearance` は車の背丈から測るが、上限が階層−ミニの1/4で、実際はこの上限に張り付く（§5.6） */
export const STOREY_CLEARANCE = LEVEL - MINI * 0.25;

interface Strip {
  cx: number;
  cz: number;
  fx: number;
  fz: number;
  /** 進行方向に直交する向き */
  rx: number;
  rz: number;
  half: number;
  height: number;
  from: string;
  to: string;
}

export interface Hit {
  /** 当たった部品の番号。ground・taken のときは無い */
  piece?: number;
  /** 高さの差（小さいほど深く食い込む） */
  gap?: number;
  kind: "overlap" | "ground" | "taken" | "seam";
}

/** 部品の局所での帯。経路ごとに一度だけ作る */
const cache = new WeakMap<RailDef, { from: string; to: string; pts: [number, number, number][] }[]>();

/** 経路を `to` の口に着く向きで刻む。口は入口にも出口にもなるので、着くほうの始点の向きを採る */
function localPaths(def: RailDef) {
  let out = cache.get(def);
  if (out) return out;
  out = [];
  for (const path of def.paths) {
    if ((path as { frames?: unknown }).frames) continue; // 焼き込みの輪（ループ）は扱わない
    const pts = sampleLanding(def, path);
    if (pts) out.push({ from: path.from, to: path.to, pts });
  }
  cache.set(def, out);
  return out;
}

function sampleLanding(def: RailDef, path: PathDef): [number, number, number][] | null {
  const from = def.ports.find((p) => p.id === path.from);
  const to = def.ports.find((p) => p.id === path.to);
  if (!from || !to) return null;
  let best: { d: number; pts: [number, number, number][] } | null = null;
  for (const start of [portHeading(from), portHeading(from) + Math.PI]) {
    const poses = samplePath(def, path, STEP, start);
    const end = poses[poses.length - 1]!;
    const d = Math.hypot(end.x - to.position[0], end.z - to.position[2]);
    if (!best || d < best.d) best = { d, pts: poses.map((q) => [q.x, q.y, q.z]) };
  }
  return best ? best.pts : null;
}

function stripsOf(catalog: Catalog, piece: PieceSave): Strip[] {
  const def = catalog.of(piece);
  if (!def) return [];
  const out: Strip[] = [];
  for (const path of localPaths(def)) {
    let prev = toWorld(piece, path.pts[0]!);
    for (let i = 1; i < path.pts.length; i++) {
      const next = toWorld(piece, path.pts[i]!);
      const dx = next[0] - prev[0];
      const dz = next[2] - prev[2];
      const len = Math.hypot(dx, dz);
      if (len > 1e-6) {
        out.push({
          cx: (prev[0] + next[0]) / 2,
          cz: (prev[2] + next[2]) / 2,
          fx: dx / len,
          fz: dz / len,
          rx: dz / len,
          rz: -dx / len,
          half: len * 0.45,
          height: (prev[1] + next[1]) / 2,
          from: path.from,
          to: path.to,
        });
      }
      prev = next;
    }
  }
  return out;
}

function extentOf(strips: Strip[], hw: number): [number, number, number, number] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const s of strips) {
    const ex = s.half * Math.abs(s.fx) + hw * Math.abs(s.rx);
    const ez = s.half * Math.abs(s.fz) + hw * Math.abs(s.rz);
    minX = Math.min(minX, s.cx - ex);
    maxX = Math.max(maxX, s.cx + ex);
    minZ = Math.min(minZ, s.cz - ez);
    maxZ = Math.max(maxZ, s.cz + ez);
  }
  return [minX, maxX, minZ, maxZ];
}

const apart = (a: number[], b: number[]) => a[1]! < b[0]! || b[1]! < a[0]! || a[3]! < b[2]! || b[3]! < a[2]!;

/** 分離軸 axis（単位ベクトル）で2本の帯が離れているか */
function separated(ax: number, az: number, a: Strip, b: Strip, hw: number): boolean {
  const ra = a.half * Math.abs(ax * a.fx + az * a.fz) + hw * Math.abs(ax * a.rx + az * a.rz);
  const rb = b.half * Math.abs(ax * b.fx + az * b.fz) + hw * Math.abs(ax * b.rx + az * b.rz);
  return Math.abs((b.cx - a.cx) * ax + (b.cz - a.cz) * az) >= ra + rb;
}

function stripsOverlap(a: Strip, b: Strip, hw: number): boolean {
  return (
    !separated(a.fx, a.fz, a, b, hw) &&
    !separated(a.rx, a.rz, a, b, hw) &&
    !separated(b.fx, b.fz, a, b, hw) &&
    !separated(b.rx, b.rz, a, b, hw)
  );
}

/** 両部品が継ぎ目で重ねている口の名前を、それぞれの側で集める */
function seamPorts(catalog: Catalog, a: PieceSave, b: PieceSave): [Set<string>, Set<string>] {
  const mine = new Set<string>();
  const theirs = new Set<string>();
  const da = catalog.of(a);
  const db = catalog.of(b);
  if (!da || !db) return [mine, theirs];
  for (const p of da.ports) {
    const wp = toWorld(a, p.position);
    for (const q of db.ports) {
      const wq = toWorld(b, q.position);
      if (Math.hypot(wp[0] - wq[0], wp[1] - wq[1], wp[2] - wq[2]) <= JOIN) {
        mine.add(p.id);
        theirs.add(q.id);
      }
    }
  }
  return [mine, theirs];
}

/** 部品の帯を貯めておく。置いた部品は動かないので、位置が同じなら使い回す */
const stripMemo = new WeakMap<PieceSave, { stamp: string; strips: Strip[]; extent: number[] }>();

function memo(catalog: Catalog, piece: PieceSave, hw: number) {
  const stamp = `${piece.kind}|${piece.position.x}|${piece.position.y}|${piece.position.z}|${piece.euler.y}`;
  let m = stripMemo.get(piece);
  if (!m || m.stamp !== stamp) {
    const strips = stripsOf(catalog, piece);
    m = { stamp, strips, extent: extentOf(strips, hw) };
    stripMemo.set(piece, m);
  }
  return m;
}

/**
 * 候補 `cand` を `pieces` に置いたときの食い違い。空なら置ける。
 * 免除するのは、**両側とも継ぎ目の口を端に持つ道どうしだけ**（部品ごとに免除すると、複線の片方へつないだ坂がもう片方を突き抜ける）
 * @param open 開いている口。既に誰かと繋がっている口へ3つ目が来るのを断るのに使う
 * @param halfWidth レールの半幅（直線の外形から測る）
 */
export function findOverlaps(catalog: Catalog, pieces: PieceSave[], cand: PieceSave, open: OpenPort[], halfWidth: number): Hit[] {
  const hits: Hit[] = [];
  const def = catalog.of(cand);
  if (!def) return hits;

  // 地面の下へ潜る部品（地面から下る坂）
  if (def.ports.some((p) => toWorld(cand, p.position)[1] < -0.01)) hits.push({ kind: "ground" });

  // 既に相手の居る口へ、3つ目が刺さる
  for (const p of def.ports) {
    const w = toWorld(cand, p.position);
    for (const [i, other] of pieces.entries()) {
      const od = catalog.of(other);
      if (!od) continue;
      for (const q of od.ports) {
        const wq = toWorld(other, q.position);
        if (Math.hypot(w[0] - wq[0], w[1] - wq[1], w[2] - wq[2]) > JOIN) continue;
        const isOpen = open.some((o) => o.piece === i && o.id === q.id);
        if (!isOpen) {
          hits.push({ kind: "taken", piece: i });
          continue;
        }
        // 位置は合うのに向きが違う口は、繋がっていないのに繋がって見える偽の継ぎ目（Unity §5.11）
        const mineH = portHeading(p) - (cand.euler.y * Math.PI) / 180;
        const theirH = portHeading(q) - (other.euler.y * Math.PI) / 180;
        const want = isUpstream(def, p) !== isUpstream(od, q) ? 0 : Math.PI;
        const diff = Math.abs(Math.atan2(Math.sin(mineH - theirH - want), Math.cos(mineH - theirH - want)));
        if (diff > (5 * Math.PI) / 180) hits.push({ kind: "seam", piece: i });
      }
    }
  }

  const mine = memo(catalog, cand, halfWidth);
  pieces.forEach((other, i) => {
    if (other === cand) return;
    const theirs = memo(catalog, other, halfWidth);
    if (apart(mine.extent, theirs.extent)) return;
    const [mineSeam, theirSeam] = seamPorts(catalog, cand, other);
    let closest = Infinity;
    for (const x of mine.strips) {
      for (const y of theirs.strips) {
        if (mineSeam.size && (mineSeam.has(x.from) || mineSeam.has(x.to)) && (theirSeam.has(y.from) || theirSeam.has(y.to))) continue;
        const gap = Math.abs(x.height - y.height);
        if (gap >= STOREY_CLEARANCE) continue; // 1階層以上離れていれば、またげる
        if (!stripsOverlap(x, y, halfWidth)) continue;
        closest = Math.min(closest, gap);
      }
    }
    if (closest !== Infinity) hits.push({ kind: "overlap", piece: i, gap: closest });
  });
  return hits;
}

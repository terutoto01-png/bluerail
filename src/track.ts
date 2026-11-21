// 経路と継ぎ目の幾何。Unity の座標（左手系、前方は局所 -z）のまま扱う
import type { Catalog, PathDef, PortDef, RailDef, SegmentDef, Vec3 } from "./catalog";
import type { PieceSave } from "./course";

const rad = (d: number) => (d * Math.PI) / 180;

/** 向き θ（rad）。θ=0 が局所 -z、正が +x 側。Unity の yaw とは符号が逆 */
export interface Pose {
  x: number;
  y: number;
  z: number;
  heading: number;
}

/** 部品の局所座標を世界へ（y 軸まわりの回転のみ。傾いた部品は後で） */
export function toWorld(piece: PieceSave, local: Vec3): [number, number, number] {
  const yaw = rad(piece.euler.y);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const [x, y, z] = local;
  return [piece.position.x + x * c + z * s, piece.position.y + y, piece.position.z - x * s + z * c];
}

/** port が外へ向く方位（θ）。euler の yaw を θ へ直す */
export const portHeading = (p: PortDef) => -rad(p.euler[1]);

/** 車線の幅。Unity の `AdvanceLane`（0.5277778）と同じ値 */
export const ADVANCE_LANE = 0.5277778;

/** その車線が中心線から横へ寄る量。+ が進行方向の左 */
export const laneShift = (lane?: string) => (lane === "L" ? ADVANCE_LANE / 2 : lane === "R" ? -ADVANCE_LANE / 2 : 0);

/** 道が車線を跨ぐか。跨ぐ道は形を自分で持つので、弧に車線の寄せを掛けてはいけない */
export const crossesLane = (path: PathDef) => !!path.laneTo && path.laneTo !== path.lane;

/** 進行方向 θ から見て左を向く単位ベクトル（x, z）。θ=0（-z へ進む）の左は +x */
export const leftOf = (heading: number): [number, number] => [Math.cos(heading), Math.sin(heading)];

/**
 * 区間を辿って中心線を作る。turn: -1 左（+x 側へ）/ 0 直線 / +1 右。
 * 平面の走りは `run`（無ければ length）。length は坂の斜めの長さで、弧の角度にも使わない。
 * startHeading を省くと from の port の向き。port は入口にも出口にもなるので、逆向きは呼び手が試す
 */
export function samplePath(def: RailDef, path: PathDef, step = 0.1, startHeading?: number): Pose[] {
  const from = def.ports.find((p) => p.id === path.from);
  const to = def.ports.find((p) => p.id === path.to);
  if (!from || !to) throw new Error(`${def.id}/${path.id}: port が無い`);
  let [x, , z] = from.position;
  let heading = startHeading ?? portHeading(from);
  // 車線は中心線から横へ寄る。跨がない道は弧の中心を保って半径を変え、跨ぐ道は形を自分で持つ
  const shift = laneShift(path.lane);
  const own = crossesLane(path);
  x += Math.cos(heading) * shift;
  z += Math.sin(heading) * shift;
  const flat = (s: { length: number; run?: number }) => s.run ?? s.length;
  const radiusOf = (s: SegmentDef) => (own ? (s.radius ?? 0) : (s.radius ?? 0) + shift * s.turn);
  const scaleOf = (s: SegmentDef) => (s.turn !== 0 && (s.radius ?? 0) > 0 && !own ? radiusOf(s) / (s.radius as number) : 1);
  const total = path.segments.reduce((a, s) => a + flat(s) * scaleOf(s), 0);
  const out: Pose[] = [{ x, y: from.position[1], z, heading }];
  let done = 0;
  for (const seg of path.segments) {
    const len = flat(seg) * scaleOf(seg);
    const n = Math.max(1, Math.ceil(len / step));
    const ds = len / n;
    const curve = seg.turn !== 0 && (seg.radius ?? 0) > 0 ? -seg.turn / radiusOf(seg) : 0;
    for (let i = 0; i < n; i++) {
      // 中点法。弧の上でも1ステップの誤差が十分小さい
      const mid = heading + (curve * ds) / 2;
      x += Math.sin(mid) * ds;
      z += -Math.cos(mid) * ds;
      heading += curve * ds;
      done += ds;
      const t = done / total;
      // 成形の坂は両端で水平（smoothstep）。継ぎ目で傾きが跳ばない。Unity の `SlopeProfile` と同じ式
      const rise = def.climbs ? t * t * (3 - 2 * t) : t;
      out.push({ x, y: from.position[1] + (to.position[1] - from.position[1]) * rise, z, heading });
    }
  }
  return out;
}

const TOLERANCE = 0.015;

/** 角度の差を [0, π] へ折り返す */
const angleGap = (a: number, b: number) => {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return Math.min(d, 2 * Math.PI - d);
};

export interface CheckResult {
  errors: string[];
  /** 扱わない道（焼き込み経路のループ）。失敗ではなく数える */
  skipped: string[];
}

/**
 * 全部品の全経路を検算する。終点が to の port に着かなければ Route mismatch。
 * 入口の向きは port の向きと逆の両方を試し、着くほうを採る（Unity の `LandsOnExit` と同じ考え）
 */
export function checkCatalog(catalog: Catalog): CheckResult {
  const errors: string[] = [];
  const skipped: string[] = [];
  for (const def of catalog.values()) {
    for (const path of def.paths) {
      const id = `${def.id}/${path.id}`;
      if ((path as { frames?: unknown }).frames) {
        skipped.push(id);
        continue;
      }
      const from = def.ports.find((p) => p.id === path.from);
      const to = def.ports.find((p) => p.id === path.to);
      if (!from || !to) {
        errors.push(`${id}: port が無い`);
        continue;
      }
      let best = { d: Infinity, dh: Infinity };
      for (const start of [portHeading(from), portHeading(from) + Math.PI]) {
        const end = samplePath(def, path, 0.1, start).at(-1)!;
        // 出口も車線のぶん寄る（進行方向の左が +）
        const [lx, lz] = leftOf(end.heading);
        const exitShift = laneShift(path.laneTo ?? path.lane);
        const d = Math.hypot(
          end.x - (to.position[0] + lx * exitShift),
          end.y - to.position[1],
          end.z - (to.position[2] + lz * exitShift),
        );
        // 出口の向きは軸だけを見る（port は入口にも出口にもなる）
        const h = portHeading(to);
        const dh = Math.min(angleGap(end.heading, h), angleGap(end.heading, h + Math.PI));
        if (d < best.d) best = { d, dh };
      }
      if (best.d > TOLERANCE || best.dh > rad(0.5)) {
        errors.push(`Route mismatch ${id}: 位置 ${best.d.toFixed(4)}m 向き ${((best.dh * 180) / Math.PI).toFixed(2)}°`);
      }
    }
  }
  return { errors, skipped };
}

export interface Joint {
  a: string;
  b: string;
  distance: number;
}

/** 近くにあるのに合っていない口の組を返す。範囲 1m 以内で最も近いもの同士を見る */
export function looseJoints(catalog: Catalog, pieces: PieceSave[], near = 1.0, tol = 0.02): Joint[] {
  const ports: { id: string; p: [number, number, number] }[] = [];
  pieces.forEach((piece, i) => {
    const def = catalog.of(piece);
    if (!def) return;
    for (const port of def.ports) ports.push({ id: `${i}:${piece.kind}.${port.id}`, p: toWorld(piece, port.position) });
  });
  const out: Joint[] = [];
  for (const a of ports) {
    let best: { b: typeof a; d: number } | null = null;
    for (const b of ports) {
      if (b === a || b.id.split(":")[0] === a.id.split(":")[0]) continue;
      const d = Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]);
      if (d < near && (!best || d < best.d)) best = { b, d };
    }
    if (best && best.d > tol && a.id < best.b.id) out.push({ a: a.id, b: best.b.id, distance: best.d });
  }
  return out;
}

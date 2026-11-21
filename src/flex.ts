// まがレール（Unity §5.5）。2つの弧（バイアーク）で、任意の2姿勢を接線連続に繋ぐ。形は部品の state 文字列が持つ
import type { PathDef, PortDef, RailDef, SegmentDef } from "./catalog";
import type { PieceSave } from "./course";
import type { OpenPort } from "./place";
import { samplePath } from "./track";

interface Arc {
  length: number;
  /** +1 右 / −1 左 / 0 直線（Unity の `turn` と同じ） */
  turn: number;
  radius: number;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** 向き θ の進行方向ベクトル（x, z） */
const dirOf = (h: number): [number, number] => [Math.sin(h), -Math.cos(h)];

/** 節の長さ・最小半径・最大の長さは、カタログの値（`flexNodeLength` など）。ここは既定 */
export interface FlexLimits {
  nodeLength: number;
  minRadius: number;
  maxLength: number;
}

export function limitsOf(def: RailDef): FlexLimits {
  const d = def as RailDef & { flexNodeLength?: number; flexMinRadius?: number; flexMaxLength?: number };
  return { nodeLength: d.flexNodeLength ?? 0.75, minRadius: d.flexMinRadius ?? 3, maxLength: d.flexMaxLength ?? 60 };
}

export const encodeFlex = (a: Arc, b: Arc) =>
  `flex:${[a.length, a.turn, a.radius, b.length, b.turn, b.radius].map((v) => Number(v.toFixed(5))).join(",")}`;

export function decodeFlex(state: string, max: number): [Arc, Arc] | null {
  if (!state.startsWith("flex:")) return null;
  const v = state.slice(5).split(",").map(Number);
  if (v.length !== 6 || v.some((x) => !Number.isFinite(x))) return null;
  const arc = (i: number): Arc => ({ length: v[i]!, turn: v[i + 1]!, radius: v[i + 2]! });
  const a = arc(0);
  const b = arc(3);
  for (const x of [a, b]) {
    if (x.length < 0 || x.radius < 0 || x.turn < -1 || x.turn > 1 || (x.turn !== 0 && x.radius <= 0)) return null;
  }
  const total = a.length + b.length;
  return total > 0.001 && total <= max + 0.00002 ? [a, b] : null;
}

/** 1つの弧: 点 from から forward を向いて、点 to へ */
function arcTo(from: [number, number], fwd: number, to: [number, number], minRadius: number): Arc | null {
  const dx = to[0] - from[0];
  const dz = to[1] - from[1];
  const chord = Math.hypot(dx, dz);
  if (chord < 0.001) return null;
  const half = wrap(fwd - Math.atan2(dx, -dz));
  if (Math.abs(half) < 0.0005) return { length: chord, turn: 0, radius: 0 };
  const radius = chord / (2 * Math.sin(Math.abs(half)));
  if (radius < minRadius) return null;
  return { length: radius * Math.abs(half) * 2, turn: half > 0 ? 1 : -1, radius };
}

/**
 * 2姿勢を2つの弧で繋ぐ。自由度（弧が出会う位置）は走査して、いちばんきつい弧がいちばん緩い解を採る
 * （対称解は玩具が曲がれない形になることがある）
 */
export function fitFlex(
  from: [number, number],
  fromH: number,
  to: [number, number],
  toH: number,
  lim: FlexLimits,
): [Arc, Arc] | null {
  const t0 = dirOf(fromH);
  const t1 = dirOf(toH);
  const v: [number, number] = [to[0] - from[0], to[1] - from[1]];
  const span = Math.hypot(v[0], v[1]);
  if (span < 0.001) return null;
  const c = t0[0] * t1[0] + t0[1] * t1[1];
  const vt0 = v[0] * t0[0] + v[1] * t0[1];
  const vt1 = v[0] * t1[0] + v[1] * t1[1];
  let best = 0;
  let out: [Arc, Arc] | null = null;
  const samples = 96;
  for (let i = 1; i <= samples; i++) {
    const d1 = (span * 3 * i) / samples;
    const den = 2 * (d1 * (1 - c) + vt1);
    if (Math.abs(den) < 0.0001) continue;
    const d2 = (span * span - 2 * d1 * vt0) / den;
    if (d2 <= 0.001) continue;
    const p0: [number, number] = [from[0] + d1 * t0[0], from[1] + d1 * t0[1]];
    const p1: [number, number] = [to[0] - d2 * t1[0], to[1] - d2 * t1[1]];
    const joint: [number, number] = [(d2 * p0[0] + d1 * p1[0]) / (d1 + d2), (d2 * p0[1] + d1 * p1[1]) / (d1 + d2)];
    const a = arcTo(from, fromH, joint, lim.minRadius);
    if (!a) continue;
    // 2本目は終点から逆向きに見た弧。曲がる向きは裏返る
    const b0 = arcTo(to, toH + Math.PI, joint, lim.minRadius);
    if (!b0) continue;
    const b: Arc = { ...b0, turn: -b0.turn };
    if (a.length + b.length > lim.maxLength) continue;
    const tight = Math.min(a.turn === 0 ? Infinity : a.radius, b.turn === 0 ? Infinity : b.radius);
    if (tight <= best) continue;
    best = tight;
    out = [a, b];
  }
  return best > 0 ? out : null;
}

const cache = new Map<string, RailDef>();

/** state が決める形を持った、この1本ぶんの部品定義。口は Start（原点）と End（弧を歩いた先） */
export function deriveFlex(def: RailDef, state: string): RailDef | null {
  const lim = limitsOf(def);
  const arcs = decodeFlex(state, lim.maxLength);
  if (!arcs) return null;
  const key = `${def.id}|${state}`;
  const known = cache.get(key);
  if (known) return known;
  const segments: SegmentDef[] = arcs
    .filter((a) => a.length > 0.001)
    .map((a) => (a.turn === 0 ? { length: a.length, turn: 0 } : { length: a.length, turn: a.turn, radius: a.radius }));
  const start: PortDef = { id: "Start", face: "a", position: [0, 0, 0], euler: [0, 0, 0] };
  const path: PathDef = { id: "through", from: "Start", to: "End", segments };
  const draft: RailDef = { ...def, id: key, ports: [start, { ...start, id: "End", face: "b" }], paths: [path] };
  const end = samplePath(draft, path, 0.05, 0).at(-1)!;
  const derived: RailDef = {
    ...draft,
    ports: [start, { id: "End", face: "b", position: [end.x, 0, end.z], euler: [0, (-end.heading * 180) / Math.PI, 0] }],
  };
  cache.set(key, derived);
  return derived;
}

/** 歩いた先が目標から外れていないか（外れた形を置くと、繋がって見えて繋がっていないレールになる） */
function lands(def: RailDef, state: string, from: [number, number], fromH: number, to: [number, number], toH: number) {
  const derived = deriveFlex(def, state);
  if (!derived) return false;
  const end = samplePath(derived, derived.paths[0]!, 0.05, 0).at(-1)!;
  // 局所の終点を世界へ。部品は yaw = −fromH で置くので、`toWorld` と同じ回転を掛ける
  const c = Math.cos(fromH);
  const s = Math.sin(fromH);
  const x = from[0] + end.x * c - end.z * s;
  const z = from[1] + end.x * s + end.z * c;
  const heading = fromH + end.heading;
  const miss = Math.hypot(x - to[0], z - to[1]);
  const skew = Math.abs(wrap(heading - toH));
  return miss <= 0.01 && skew <= (0.5 * Math.PI) / 180;
}

/**
 * 選んだ端 end から、いちばん近い開いた端へ届く、まがレールの姿勢。無ければ null（Unity の `FindFlexTarget`）。
 * 端が「入る側」なら、相手から端へ向けて当てはめる（レールは固めて置くので、置く向きで当てる）
 */
export function flexPlacement(def: RailDef, open: OpenPort[], end: OpenPort): PieceSave | null {
  const lim = limitsOf(def);
  let best: { d: number; piece: PieceSave } | null = null;
  for (const t of open) {
    if (t === end || t.piece === end.piece) continue;
    const d = Math.hypot(t.pos[0] - end.pos[0], t.pos[2] - end.pos[2]);
    if (d < 0.3 || d > lim.maxLength || (best && d >= best.d)) continue;
    if (Math.abs(t.pos[1] - end.pos[1]) > 0.05) continue; // 平らな所だけ
    let fromP: [number, number];
    let fromH: number;
    let toP: [number, number];
    let toH: number;
    let y: number;
    if (!end.upstream) {
      // 選んだ端から伸ばす。向かう先に着く向きは、相手が入る側ならそのまま、出る側なら逆
      fromP = [end.pos[0], end.pos[2]];
      fromH = end.heading;
      toP = [t.pos[0], t.pos[2]];
      toH = t.upstream ? t.heading : t.heading + Math.PI;
      y = end.pos[1];
    } else {
      // 選んだ端は入る側。相手から出て、選んだ端へ入る
      fromP = [t.pos[0], t.pos[2]];
      fromH = t.upstream ? t.heading + Math.PI : t.heading;
      toP = [end.pos[0], end.pos[2]];
      toH = end.heading;
      y = t.pos[1];
    }
    const arcs = fitFlex(fromP, fromH, toP, toH, lim);
    if (!arcs) continue;
    const state = encodeFlex(arcs[0], arcs[1]);
    if (!lands(def, state, fromP, fromH, toP, toH)) continue;
    // 部品の Start を fromP に、前を fromH に向ける。局所の道は 0（−z）へ出るので yaw = −fromH
    best = {
      d,
      piece: {
        kind: def.id,
        position: { x: fromP[0], y, z: fromP[1] },
        euler: { x: 0, y: ((((-fromH * 180) / Math.PI) % 360) + 360) % 360, z: 0 },
        state,
        lift: 0,
        liftFrom: "",
        branchSet: false,
        autoFlip: false,
      },
    };
  }
  return best?.piece ?? null;
}

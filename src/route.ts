// 置かれた部品から1本のルート（世界座標の点列）を組む。分岐は腕ごとの状態（points.ts）で選ぶ
import type { Catalog, PathDef, RailDef } from "./catalog";
import type { PieceSave } from "./course";
import { junctionsOf, laneCandidates, readState } from "./points";
import { portHeading, samplePath, toWorld, type Pose } from "./track";

export interface RoutePoint extends Pose {
  /** 始点からの道のり */
  s: number;
}

/** ルートの1区間 = 1つの部品の1本の道。どの口から入ったかを覚える（組み直しの継ぎ目になる） */
export interface Seg {
  piece: number;
  entry: string;
  /** points のどこから始まるか */
  index: number;
  /** 始点からの道のり（組み終えたあとに入る） */
  s: number;
  /** 選んだ道の id */
  path: string;
  /** この区間へ入るときの車線（進行方向で見た左右。"" は中央） */
  lane: string;
}

export class Route {
  constructor(
    readonly points: RoutePoint[],
    /** 終点が輪の途中（または始点）へ戻る。戻り先から先は周回する */
    readonly closed: boolean,
    /** 組めなかった理由（途中で切れた等）。空なら問題なし */
    readonly notes: string[],
    /** 周回が始まる道のり。始点へ戻る輪は 0、手前に引き込みのある輪（投げ縄）は正 */
    readonly loopStart = 0,
    readonly segs: Seg[] = [],
  ) {}

  get length() {
    return this.points.at(-1)?.s ?? 0;
  }

  /** 道のり s を含む区間の番号（s が範囲外なら端の区間） */
  segIndexAt(s: number): number {
    let k = 0;
    for (let i = 0; i < this.segs.length; i++) if (this.segs[i]!.s <= s) k = i;
    return k;
  }

  /**
   * 列車の先頭 s を、尻が最初の周回に入る形へ畳む。周回の何周目でも同じ場所を指すので、
   * ルートが組み直されて長さが変わっても、列車は同じ場所に居続ける
   */
  canonicalHead(s: number, trainLength: number): number {
    if (!this.closed) return s;
    const lap = this.length - this.loopStart;
    const tail = s - trainLength;
    if (this.loopStart === 0) return (((tail % lap) + lap) % lap) + trainLength;
    if (tail > this.loopStart) return this.loopStart + ((tail - this.loopStart) % lap) + trainLength;
    return s;
  }

  /** 道のり [from, to] にかかっている区間。to が終点を越えたら周回の頭へ続く */
  segsUnder(from: number, to: number): Seg[] {
    const out: Seg[] = [];
    const take = (a: number, b: number) => {
      for (let i = this.segIndexAt(a); i < this.segs.length && this.segs[i]!.s <= b; i++) out.push(this.segs[i]!);
    };
    take(from, Math.min(to, this.length));
    if (this.closed && to > this.length) take(this.loopStart, this.loopStart + (to - this.length));
    return out;
  }

  /** 道のり s の位置と向き。閉じていれば周回し、開いていれば端で止める */
  at(s: number): Pose {
    const pts = this.points;
    const len = this.length;
    if (this.closed && s > this.loopStart) {
      const lap = len - this.loopStart;
      s = this.loopStart + ((s - this.loopStart) % lap);
    } else if (this.closed && this.loopStart === 0) {
      s = ((s % len) + len) % len; // 純粋な輪は後ろ側も繋がる
    } else s = Math.min(Math.max(s, 0), len);
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid]!.s <= s) lo = mid;
      else hi = mid;
    }
    const a = pts[lo]!;
    const b = pts[hi]!;
    const t = b.s > a.s ? (s - a.s) / (b.s - a.s) : 0;
    // 向きは短い側へ補間する（折り返しをまたぐ）
    let dh = b.heading - a.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
      heading: a.heading + dh * t,
    };
  }
}

const TOLERANCE = 0.015;
const laid = new Map<string, Pose[]>();

/**
 * 部品の局所座標で、道を from から to へ敷く。入口の向きは to に着くほうを採る。
 * jsonLane があれば、中央の道をその車線へ寄せて敷く（アドバンスの列車が普通のレールを走るとき）
 */
export function layPath(def: RailDef, path: PathDef, jsonLane?: string | null): Pose[] {
  const key = `${def.id}/${path.id}/${jsonLane ?? ""}`;
  let poses = laid.get(key);
  if (!poses) {
    const from = def.ports.find((p) => p.id === path.from)!;
    const to = def.ports.find((p) => p.id === path.to)!;
    const lay = jsonLane ? { ...path, lane: jsonLane, laneTo: jsonLane } : path;
    let best: Pose[] = [];
    let bestD = Infinity;
    for (const start of [portHeading(from), portHeading(from) + Math.PI]) {
      // 向きの選別は寄せなしの形の終点で行う（寄せた終点は口から横へずれる）
      const q = samplePath(def, path, 0.1, start).at(-1)!;
      const d = Math.hypot(q.x - to.position[0], q.z - to.position[2]);
      if (d < bestD) {
        bestD = d;
        best = lay === path ? samplePath(def, path, 0.1, start) : samplePath(def, lay, 0.1, start);
      }
    }
    poses = best;
    laid.set(key, poses);
  }
  return poses;
}

interface Entry {
  piece: number;
  port: string;
}

/**
 * 置かれた部品から1本のルートを組む。
 * resume を渡すと、その区間より前は前のルートをそのまま使い、そこから先だけを組み直す。
 * 分岐の切り替えで、列車の後ろ（=列車が居る場所）の座標を動かさないための継ぎ目。
 */
export function buildRoute(
  catalog: Catalog,
  pieces: PieceSave[],
  start?: Entry,
  resume?: { route: Route; seg: number },
  /** 「部品:入る口」→ 固定する道の id。列車が乗っている区間 */
  locks?: Map<string, string>,
  /** 始点の車線（進行方向で見た左右。"" は中央） */
  startLane = "",
): Route {
  const notes: string[] = [];
  // 全 port の世界座標
  const ports: { piece: number; id: string; p: [number, number, number] }[] = [];
  pieces.forEach((piece, i) => {
    const def = catalog.of(piece);
    if (def) for (const port of def.ports) ports.push({ piece: i, id: port.id, p: toWorld(piece, port.position) });
  });
  const neighbour = (piece: number, id: string): Entry | null => {
    const me = ports.find((q) => q.piece === piece && q.id === id)!;
    let best: Entry | null = null;
    let bestD = TOLERANCE * 4;
    for (const q of ports) {
      if (q.piece === piece) continue;
      const d = Math.hypot(me.p[0] - q.p[0], me.p[1] - q.p[1], me.p[2] - q.p[2]);
      if (d < bestD) {
        bestD = d;
        best = { piece: q.piece, port: q.id };
      }
    }
    return best;
  };

  const first = pieces[0] && catalog.of(pieces[0]);
  if (!first) return new Route([], false, ["部品がない"]);
  const oldFirst = resume?.route.segs[0];
  const begin: Entry = oldFirst
    ? { piece: oldFirst.piece, port: oldFirst.entry }
    : (start ?? { piece: 0, port: first.paths[0]!.from });

  const points: RoutePoint[] = [];
  const segs: Seg[] = [];
  let closed = false;
  let loopIndex = 0;
  /** 入った状態（部品・port）→ そのとき points のどこにいたか */
  const seen = new Map<string, number>([[`${begin.piece}:${begin.port}`, 0]]);
  let cur: Entry = begin;
  let lane = startLane;
  if (resume) {
    // 切れ目より前は、座標ごとそのまま引き継ぐ
    const cut = resume.route.segs[resume.seg]!;
    for (const p of resume.route.points.slice(0, cut.index + 1)) points.push({ ...p });
    for (const sg of resume.route.segs.slice(0, resume.seg)) segs.push({ ...sg });
    // **手前の区間は「来た道」に数えない。**先の歩きは同じ部品をもう一度通るが、そのとき
    // 分岐は切り替え後の状態なので、手前の古い写しへ戻って閉じてはいけない
    seen.clear();
    seen.set(`${cut.piece}:${cut.entry}`, cut.index);
    cur = { piece: cut.piece, port: cut.entry };
    lane = cut.lane;
  }
  for (let guard = 0; guard < pieces.length * 4; guard++) {
    const piece = pieces[cur.piece]!;
    const def = catalog.of(piece)!;
    const cands = laneCandidates(def, cur.port, lane);
    if (!cands.length) {
      notes.push(`${cur.piece}:${piece.kind} に ${cur.port} から入る道がない`);
      break;
    }
    // 腕ごとに固定した道（自動のときは、いま向いている道）
    const arm = junctionsOf(def).findIndex((j) => j.port === cur.port);
    const byState = cands[arm < 0 ? 0 : Math.min(readState(def, piece).picks[arm]!, cands.length - 1)]!;
    // 列車が乗っている区間は、いま走っている道を覚えておく。分岐の状態を後から変えても、
    // 車体の下で線が変わらない（外れたらまた状態に従う）
    const locked = locks?.get(`${cur.piece}:${cur.port}`);
    const pick = cands.find((c) => c.path.id === locked) ?? byState;
    let poses = layPath(def, pick.path, pick.jsonLane);
    if (pick.reversed) {
      poses = [...poses].reverse().map((q) => ({ ...q, heading: q.heading + Math.PI }));
    }
    segs.push({
      piece: cur.piece,
      entry: cur.port,
      index: Math.max(0, points.length - 1),
      s: 0,
      path: pick.path.id,
      lane,
    });
    lane = pick.exitLane;
    const yaw = (piece.euler.y * Math.PI) / 180;
    poses.forEach((q, k) => {
      if (k === 0 && points.length) return; // 継ぎ目の点は前の部品の終点と同じ
      const [x, y, z] = toWorld(piece, [q.x, q.y, q.z]);
      points.push({ x, y, z, heading: q.heading - yaw, s: 0 });
    });
    const exit = pick.reversed ? pick.path.from : pick.path.to;
    const next = neighbour(cur.piece, exit);
    if (!next) {
      notes.push(`${cur.piece}:${piece.kind}.${exit} の先に部品がない（行き止まり）`);
      break;
    }
    // 来た道へ戻れば輪になる。戻り先が始点でなければ、そこから先だけが周回する
    const back = seen.get(`${next.piece}:${next.port}`);
    if (back !== undefined) {
      closed = true;
      loopIndex = back;
      break;
    }
    seen.set(`${next.piece}:${next.port}`, points.length - 1);
    cur = next;
  }
  let s = 0;
  points.forEach((p, k) => {
    if (k) {
      const q = points[k - 1]!;
      s += Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
    }
    p.s = s;
  });
  for (const sg of segs) sg.s = points[sg.index]?.s ?? 0;
  return new Route(points, closed, notes, points[loopIndex]?.s ?? 0, segs);
}

// かんたん配置モードの自動経路・自動分岐ソルバー（three に依存しない純粋な幾何モジュール）
import type { Catalog, PortDef, RailDef } from "./catalog";
import type { PieceSave } from "./course";
import { encodeFlex, fitFlex, limitsOf } from "./flex";
import { findOverlaps } from "./overlap";
import { freePlacement, isUpstream, mate, openPorts, type OpenPort } from "./place";
import { readState, writeState } from "./points";
import { buildRoute, type Route } from "./route";
import { portHeading, toWorld } from "./track";

const JOIN = 0.05;
const LEVEL_HEIGHT = 1.6667;

export interface PieceReplacement {
  /** 差し替え元の course.pieces インデックス（1個、または直列の1/2直線2個） */
  indices: number[];
  /** 新しく置く分岐部品 */
  piece: PieceSave;
}

export interface EasyPlan {
  replacements: PieceReplacement[];
  additions: PieceSave[];
  /** 追加した最後の部品の先端（閉合・合流した場合は null） */
  nextEnd: OpenPort | null;
  summary: string;
  kind: "extend" | "connect" | "branch" | "merge" | "branch-merge" | "start";
  score: number;
}

export interface BranchVariant {
  replacement: PieceReplacement | null;
  branchPort: OpenPort;
  basePieces: PieceSave[];
  baseOpen: OpenPort[];
  /** 分岐の出口が向く外向き方位 */
  outward: number;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const angleDiff = (a: number, b: number) => Math.abs(wrap(a - b));
const degrees = (rad: number) => ((((rad * 180) / Math.PI) % 360) + 360) % 360;

/** 開いた端から新しいレールが伸びていく外向き方位 θ */
export function outwardHeading(end: OpenPort): number {
  return end.upstream ? end.heading + Math.PI : end.heading;
}

/** 2つの口が位置・向きともに正しく接続できるか（overlap.ts の seam 判定と同じ基準） */
export function portsMatch(a: OpenPort, b: OpenPort): boolean {
  const dist = Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]);
  if (dist > JOIN) return false;
  const want = a.upstream !== b.upstream ? 0 : Math.PI;
  return angleDiff(a.heading, b.heading + want) <= (5 * Math.PI) / 180;
}

/** 部品の指定した口の世界座標 OpenPort を作る */
function portToOpen(piece: PieceSave, def: RailDef, port: PortDef, pieceIndex: number): OpenPort {
  const yaw = (piece.euler.y * Math.PI) / 180;
  return {
    piece: pieceIndex,
    id: port.id,
    pos: toWorld(piece, port.position),
    heading: portHeading(port) - yaw,
    upstream: isUpstream(def, port),
  };
}

/** 分岐部品を既定の「自動切替」状態にする */
function asAutoPoint(catalog: Catalog, piece: PieceSave): PieceSave {
  const def = catalog.get(piece.kind);
  if (def) {
    const st = readState(def, piece);
    if (st.auto.length > 0) {
      st.auto.fill(true);
      writeState(piece, st);
    }
  }
  return piece;
}

/**
 * 2口部品（直線・カーブ・坂）の face "a" (Start) を end に継ぎ、反対側 (End) の OpenPort を返す。
 * mate() と同じ幾何を使うため、ズレが生じない。
 */
function stepFrom(catalog: Catalog, end: OpenPort, kind: string, tempPieceIdx: number): { piece: PieceSave; nextEnd: OpenPort } | null {
  const def = catalog.get(kind);
  if (!def || def.ports.length !== 2) return null;
  const piece = mate(catalog, [end], end, kind, "a");
  if (!piece) return null;
  const exitPort = def.ports.find((p) => p.face !== "a") ?? def.ports[1]!;
  const nextEnd = portToOpen(piece, def, exitPort, tempPieceIdx);
  return { piece, nextEnd };
}

/** 部品を1つ追加したときの openPorts の差分更新（高速） */
function advanceOpen(prevOpen: OpenPort[], consumed: OpenPort, addedExit: OpenPort): { nextOpen: OpenPort[]; closedTarget: OpenPort | null } {
  const nextOpen: OpenPort[] = [];
  let closedTarget: OpenPort | null = null;
  for (const o of prevOpen) {
    if (o === consumed || (o.piece === consumed.piece && o.id === consumed.id)) continue;
    if (!closedTarget && Math.hypot(o.pos[0] - addedExit.pos[0], o.pos[1] - addedExit.pos[1], o.pos[2] - addedExit.pos[2]) <= JOIN) {
      closedTarget = o;
      continue;
    }
    nextOpen.push(o);
  }
  if (!closedTarget) nextOpen.push(addedExit);
  return { nextOpen, closedTarget };
}

/** 部品配列に差し替えと追加を適用した新しい配列を返す（元配列は変更しない） */
export function applyPlanToPieces(pieces: PieceSave[], plan: Pick<EasyPlan, "replacements" | "additions">): PieceSave[] {
  const removed = new Set<number>();
  for (const r of plan.replacements) {
    for (const idx of r.indices) removed.add(idx);
  }
  const out = pieces.filter((_, i) => !removed.has(i));
  for (const r of plan.replacements) out.push(JSON.parse(JSON.stringify(r.piece)) as PieceSave);
  for (const a of plan.additions) out.push(JSON.parse(JSON.stringify(a)) as PieceSave);
  return out;
}

/** 2点間の FlexRail を生成し、衝突がなければ返す */
function buildFlexBridge(
  catalog: Catalog,
  pieces: PieceSave[],
  open: OpenPort[],
  fromEnd: OpenPort,
  toEnd: OpenPort,
  halfWidth: number,
): PieceSave | null {
  const def = catalog.get("FlexRail");
  if (!def) return null;
  if (Math.abs(fromEnd.pos[1] - toEnd.pos[1]) > 0.05) return null;
  const dist = Math.hypot(toEnd.pos[0] - fromEnd.pos[0], toEnd.pos[2] - fromEnd.pos[2]);
  const lim = limitsOf(def);
  if (dist < 0.4 || dist > lim.maxLength) return null;

  let fromP: [number, number];
  let fromH: number;
  let toP: [number, number];
  let toH: number;
  const y = fromEnd.pos[1];
  if (!fromEnd.upstream) {
    fromP = [fromEnd.pos[0], fromEnd.pos[2]];
    fromH = fromEnd.heading;
    toP = [toEnd.pos[0], toEnd.pos[2]];
    toH = toEnd.upstream ? toEnd.heading : toEnd.heading + Math.PI;
  } else {
    fromP = [toEnd.pos[0], toEnd.pos[2]];
    fromH = toEnd.upstream ? toEnd.heading + Math.PI : toEnd.heading;
    toP = [fromEnd.pos[0], fromEnd.pos[2]];
    toH = fromEnd.heading;
  }
  const arcs = fitFlex(fromP, fromH, toP, toH, lim);
  if (!arcs) return null;
  const state = encodeFlex(arcs[0], arcs[1]);
  const piece: PieceSave = {
    kind: def.id,
    position: { x: fromP[0], y, z: fromP[1] },
    euler: { x: 0, y: degrees(-fromH), z: 0 },
    state,
    lift: 0,
    liftFrom: "",
    branchSet: false,
    autoFlip: false,
  };
  // catalog.of(piece) が派生定義を組み立てられるか、衝突がないか確認
  const derived = catalog.of(piece);
  if (!derived || derived.ports.length < 2) return null;
  const p0 = toWorld(piece, derived.ports[0]!.position);
  const p1 = toWorld(piece, derived.ports[1]!.position);
  const miss0 = Math.hypot(p0[0] - fromP[0], p0[2] - fromP[1]);
  const miss1 = Math.hypot(p1[0] - toP[0], p1[2] - toP[1]);
  if (miss0 > 0.03 || miss1 > 0.03) return null;
  const hits = findOverlaps(catalog, pieces, piece, open, halfWidth);
  return hits.length === 0 ? piece : null;
}

// --- 最小ヒープ（A* 用） ---
class MinHeap<T> {
  private data: { key: number; val: T }[] = [];
  get size() {
    return this.data.length;
  }
  push(key: number, val: T) {
    const d = this.data;
    d.push({ key, val });
    let i = d.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (d[p]!.key <= d[i]!.key) break;
      [d[p], d[i]] = [d[i]!, d[p]!];
      i = p;
    }
  }
  pop(): T | undefined {
    const d = this.data;
    if (!d.length) return undefined;
    const top = d[0]!.val;
    const last = d.pop()!;
    if (d.length) {
      d[0] = last;
      let i = 0;
      const n = d.length;
      while (true) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < n && d[l]!.key < d[m]!.key) m = l;
        if (r < n && d[r]!.key < d[m]!.key) m = r;
        if (m === i) break;
        [d[i], d[m]] = [d[m]!, d[i]!];
        i = m;
      }
    }
    return top;
  }
}

interface SearchNode {
  end: OpenPort;
  /** 確定済みの親の部品列（pop 時に pendingPiece を検証して pieces を作る） */
  prevPieces: PieceSave[];
  prevOpen: OpenPort[];
  prevEnd: OpenPort | null;
  pendingPiece: PieceSave | null;
  added: PieceSave[];
  g: number;
  lastTurn: number; // -1 left, 0 straight, +1 right
  reversals: number;
  halfCount: number;
  quarterCount: number;
  consecCurve: number;
  totalCurve: number;
}

const stateKey = (end: OpenPort) => {
  const x = Math.round(end.pos[0] * 4);
  const y = Math.round(end.pos[1] * 2);
  const z = Math.round(end.pos[2] * 4);
  const h = ((Math.round((outwardHeading(end) * 4) / Math.PI) % 8) + 8) % 8;
  return `${x},${y},${z},${h}`;
};

const PIECE_LENGTH: Record<string, number> = {
  Straight: 6.0,
  HalfStraight: 3.0,
  QuarterStraight: 1.5,
  Left: 4.7124,
  Right: 4.7124,
  SlopeUpOriginal: 12.0,
  SlopeDownOriginal: 12.0,
};

const PIECE_TURN: Record<string, number> = {
  Straight: 0,
  HalfStraight: 0,
  QuarterStraight: 0,
  Left: -1,
  Right: 1,
  SlopeUpOriginal: 0,
  SlopeDownOriginal: 0,
};

/**
 * 選んだ開いた端から、マット上の目標点 (targetX, targetZ, targetLevel) へ向かう自然なレール列を探す。
 * 左・右・直線・1/2直線・坂を自動選択し、上位の異なる候補を返す（↻ 別のつなぎ方 で切替可能）。
 */
export function planToPoint(
  catalog: Catalog,
  pieces: PieceSave[],
  open: OpenPort[],
  startEnd: OpenPort,
  targetX: number,
  targetZ: number,
  targetLevel: number,
  halfWidth: number,
  opts?: { maxDepth?: number; maxNodes?: number; allowShortClose?: boolean },
): EasyPlan[] {
  const targetY = Math.max(0, targetLevel) * LEVEL_HEIGHT;
  const startDist = Math.hypot(targetX - startEnd.pos[0], targetZ - startEnd.pos[2]);
  const startLevel = Math.round(startEnd.pos[1] / LEVEL_HEIGHT);
  if (startDist < 0.7 && startLevel === targetLevel) return [];

  // 目標点のすぐ近くに別の開いた端があれば、そこへ exact 接続する候補も混ぜる
  const extraConnect: EasyPlan[] = [];
  if (opts?.allowShortClose !== false) {
    const nearOther = open
      .filter(
        (o) =>
          !(o.piece === startEnd.piece && o.id === startEnd.id) &&
          Math.abs(o.pos[1] - targetY) < 0.2 &&
          Math.hypot(o.pos[0] - targetX, o.pos[2] - targetZ) < 2.2,
      )
      .sort((a, b) => Math.hypot(a.pos[0] - targetX, a.pos[2] - targetZ) - Math.hypot(b.pos[0] - targetX, b.pos[2] - targetZ))[0];
    if (nearOther) {
      const conn = planToPort(catalog, pieces, open, startEnd, nearOther, halfWidth, { maxDepth: 12, maxNodes: 700 });
      for (const c of conn) extraConnect.push({ ...c, score: c.score - 4.0 });
    }
  }

  const levelGap0 = Math.abs(targetLevel - startLevel);
  const maxDepth = opts?.maxDepth ?? Math.min(11, Math.max(5, Math.ceil((startDist + levelGap0 * 12) / 4.2) + 3));
  const maxNodes = opts?.maxNodes ?? 420;

  const heap = new MinHeap<SearchNode>();
  const bestG = new Map<string, number>();

  const root: SearchNode = {
    end: startEnd,
    prevPieces: pieces,
    prevOpen: open,
    prevEnd: null,
    pendingPiece: null,
    added: [],
    g: 0,
    lastTurn: 0,
    reversals: 0,
    halfCount: 0,
    quarterCount: 0,
    consecCurve: 0,
    totalCurve: 0,
  };
  heap.push(startDist, root);

  const candidates: EasyPlan[] = [];
  let expanded = 0;
  let hitBudget = maxNodes;

  while (heap.size > 0 && expanded < hitBudget) {
    const cur = heap.pop()!;
    const key = stateKey(cur.end);
    const prevBest = bestG.get(key);
    if (prevBest !== undefined && prevBest <= cur.g - 0.05) continue;

    let curPieces = cur.prevPieces;
    let curOpen = cur.prevOpen;
    let closedOn: OpenPort | null = null;
    if (cur.pendingPiece) {
      const hits = findOverlaps(catalog, cur.prevPieces, cur.pendingPiece, cur.prevOpen, halfWidth);
      if (hits.length > 0) continue;
      curPieces = [...cur.prevPieces, cur.pendingPiece];
      const adv = advanceOpen(cur.prevOpen, cur.prevEnd!, cur.end);
      curOpen = adv.nextOpen;
      closedOn = adv.closedTarget;
    }
    bestG.set(key, cur.g);
    expanded++;

    if (cur.added.length > 0) {
      const dist = Math.hypot(cur.end.pos[0] - targetX, cur.end.pos[2] - targetZ);
      const curLevel = Math.round(cur.end.pos[1] / LEVEL_HEIGHT);
      const levelDiff = Math.abs(curLevel - targetLevel);
      // 終端が目標点の方向から大きく背を向けている場合は少し減点（遠距離のとき）
      let headingPenalty = 0;
      if (dist > 2.5) {
        const toTarget = Math.atan2(targetX - cur.end.pos[0], -(targetZ - cur.end.pos[2]));
        headingPenalty = (angleDiff(outwardHeading(cur.end), toTarget) / Math.PI) * 1.1;
      }
      const score =
        dist * 2.5 +
        levelDiff * 14.0 +
        cur.added.length * 0.45 +
        cur.reversals * 1.15 +
        cur.halfCount * 0.4 +
        headingPenalty +
        (closedOn ? -1.5 : 0);

      candidates.push({
        replacements: [],
        additions: cur.added,
        nextEnd: closedOn ? null : cur.end,
        summary: closedOn ? `つなげて閉じる (${cur.added.length}本)` : `ここまでつなぐ (${cur.added.length}本)`,
        kind: closedOn ? "connect" : "extend",
        score,
      });

      if (levelDiff === 0 && (closedOn || dist < 1.6)) {
        hitBudget = Math.min(hitBudget, expanded + 55);
      }

      // 目標に十分近く、高さも一致したら、そこからさらに伸ばす必要は薄い
      if (closedOn || (dist < 1.3 && levelDiff === 0)) continue;
    }

    if (cur.added.length >= maxDepth) continue;

    const curLevel = Math.round(cur.end.pos[1] / LEVEL_HEIGHT);
    const curDist = Math.hypot(targetX - cur.end.pos[0], targetZ - cur.end.pos[2]);

    const actions: string[] = ["Straight", "Left", "Right"];
    if (cur.added.length === 0 || curDist < 10.5) actions.push("HalfStraight");
    if (curLevel < targetLevel && catalog.has("SlopeUpOriginal")) actions.push("SlopeUpOriginal");
    if (curLevel > targetLevel && curLevel > 0 && catalog.has("SlopeDownOriginal")) actions.push("SlopeDownOriginal");

    for (const kind of actions) {
      const turn = PIECE_TURN[kind] ?? 0;
      const nextConsec = turn !== 0 && turn === cur.lastTurn ? cur.consecCurve + 1 : turn !== 0 ? 1 : 0;
      const nextTotalCurve = cur.totalCurve + (turn !== 0 ? 1 : 0);
      if (nextConsec > 5 || nextTotalCurve > 8) continue;

      const stepped = stepFrom(catalog, cur.end, kind, curPieces.length);
      if (!stepped) continue;
      if (stepped.nextEnd.pos[1] < -0.05) continue;

      const reversal = turn !== 0 && cur.lastTurn !== 0 && turn !== cur.lastTurn ? 1 : 0;
      const nextG = cur.g + (PIECE_LENGTH[kind] ?? 6) + reversal * 1.8 + (kind === "HalfStraight" ? 0.6 : 0);
      const nextKey = stateKey(stepped.nextEnd);
      const prevNext = bestG.get(nextKey);
      if (prevNext !== undefined && prevNext <= nextG - 0.05) continue;

      const nextDist = Math.hypot(stepped.nextEnd.pos[0] - targetX, stepped.nextEnd.pos[2] - targetZ);
      const nextLevel = Math.round(stepped.nextEnd.pos[1] / LEVEL_HEIGHT);
      const h = Math.max(nextDist, Math.abs(nextLevel - targetLevel) * 12.0);

      heap.push(nextG * 0.45 + h, {
        end: stepped.nextEnd,
        prevPieces: curPieces,
        prevOpen: curOpen,
        prevEnd: cur.end,
        pendingPiece: stepped.piece,
        added: [...cur.added, stepped.piece],
        g: nextG,
        lastTurn: turn !== 0 ? turn : cur.lastTurn,
        reversals: cur.reversals + reversal,
        halfCount: cur.halfCount + (kind === "HalfStraight" ? 1 : 0),
        quarterCount: cur.quarterCount,
        consecCurve: nextConsec,
        totalCurve: nextTotalCurve,
      });
    }
  }

  return pickDiversePlans([...extraConnect, ...candidates], 4);
}

/**
 * 2つの開いた端 startEnd と targetEnd をぴったり繋ぐレール列を探す。
 * まず定形レール（直線・1/2・1/4・左右カーブ・坂）の A* で完全一致を探し、
 * どうしても定形で届かない同階層ペアだけ曲がるレール (FlexRail) で補完する。
 */
export function planToPort(
  catalog: Catalog,
  pieces: PieceSave[],
  open: OpenPort[],
  startEnd: OpenPort,
  targetEnd: OpenPort,
  halfWidth: number,
  opts?: { maxDepth?: number; maxNodes?: number; allowFlex?: boolean },
): EasyPlan[] {
  if (startEnd.piece === targetEnd.piece && startEnd.id === targetEnd.id) return [];

  const targetOut = outwardHeading(targetEnd);
  const wantArrivingOut = wrap(targetOut + Math.PI);
  const targetLevel = Math.round(targetEnd.pos[1] / LEVEL_HEIGHT);
  const d0 = Math.hypot(targetEnd.pos[0] - startEnd.pos[0], targetEnd.pos[2] - startEnd.pos[2]);
  const levelGap0 = Math.abs(targetLevel - Math.round(startEnd.pos[1] / LEVEL_HEIGHT));
  const maxDepth = opts?.maxDepth ?? Math.min(16, Math.max(8, Math.ceil((d0 + levelGap0 * 12) / 3.8) + 5));
  const maxNodes = opts?.maxNodes ?? 950;

  const heap = new MinHeap<SearchNode>();
  const bestG = new Map<string, number>();

  const root: SearchNode = {
    end: startEnd,
    prevPieces: pieces,
    prevOpen: open,
    prevEnd: null,
    pendingPiece: null,
    added: [],
    g: 0,
    lastTurn: 0,
    reversals: 0,
    halfCount: 0,
    quarterCount: 0,
    consecCurve: 0,
    totalCurve: 0,
  };
  heap.push(d0, root);

  const solutions: EasyPlan[] = [];
  const nearStates: { end: OpenPort; pieces: PieceSave[]; open: OpenPort[]; added: PieceSave[]; g: number; dist: number }[] = [];
  let expanded = 0;

  while (heap.size > 0 && expanded < maxNodes) {
    const cur = heap.pop()!;
    const key = stateKey(cur.end);
    const prevBest = bestG.get(key);
    if (prevBest !== undefined && prevBest <= cur.g - 0.05) continue;

    let curPieces = cur.prevPieces;
    let curOpen = cur.prevOpen;
    let closedOn: OpenPort | null = null;
    if (cur.pendingPiece) {
      const hits = findOverlaps(catalog, cur.prevPieces, cur.pendingPiece, cur.prevOpen, halfWidth);
      if (hits.length > 0) continue;
      curPieces = [...cur.prevPieces, cur.pendingPiece];
      const adv = advanceOpen(cur.prevOpen, cur.prevEnd!, cur.end);
      curOpen = adv.nextOpen;
      closedOn = adv.closedTarget;
    }
    bestG.set(key, cur.g);
    expanded++;

    if (cur.added.length > 0 && portsMatch(cur.end, targetEnd)) {
      const score = cur.g + cur.added.length * 0.5 + cur.reversals * 2.0 + cur.halfCount * 0.6 + cur.quarterCount * 1.2;
      solutions.push({
        replacements: [],
        additions: cur.added,
        nextEnd: null,
        summary: `つなげて閉じる (${cur.added.length}本)`,
        kind: "connect",
        score,
      });
      if (solutions.length >= 2) break;
      continue;
    }

    const curDist = Math.hypot(targetEnd.pos[0] - cur.end.pos[0], targetEnd.pos[2] - cur.end.pos[2]);
    if (cur.added.length <= 4 && Math.abs(cur.end.pos[1] - targetEnd.pos[1]) < 0.05) {
      nearStates.push({ end: cur.end, pieces: curPieces, open: curOpen, added: cur.added, g: cur.g, dist: curDist });
    }

    // 別の開いた端にぶつかって閉じてしまったら、目標口ではないので打ち切り
    if (closedOn) continue;
    if (cur.added.length >= maxDepth) continue;

    const curLevel = Math.round(cur.end.pos[1] / LEVEL_HEIGHT);
    const actions: string[] = ["Straight", "Left", "Right"];
    if (curDist < 18 || cur.halfCount < 2) actions.push("HalfStraight");
    if (curDist < 10.5 && cur.quarterCount < 2 && catalog.has("QuarterStraight")) actions.push("QuarterStraight");
    if (curLevel < targetLevel && catalog.has("SlopeUpOriginal")) actions.push("SlopeUpOriginal");
    if (curLevel > targetLevel && curLevel > 0 && catalog.has("SlopeDownOriginal")) actions.push("SlopeDownOriginal");

    for (const kind of actions) {
      const turn = PIECE_TURN[kind] ?? 0;
      const nextConsec = turn !== 0 && turn === cur.lastTurn ? cur.consecCurve + 1 : turn !== 0 ? 1 : 0;
      const nextTotalCurve = cur.totalCurve + (turn !== 0 ? 1 : 0);
      if (nextConsec > 6 || nextTotalCurve > 10) continue;

      const stepped = stepFrom(catalog, cur.end, kind, curPieces.length);
      if (!stepped) continue;
      if (stepped.nextEnd.pos[1] < -0.05) continue;

      const reversal = turn !== 0 && cur.lastTurn !== 0 && turn !== cur.lastTurn ? 1 : 0;
      const nextG =
        cur.g +
        (PIECE_LENGTH[kind] ?? 6) +
        reversal * 2.2 +
        (kind === "HalfStraight" ? 0.5 : 0) +
        (kind === "QuarterStraight" ? 1.0 : 0);

      const nextKey = stateKey(stepped.nextEnd);
      const prevNext = bestG.get(nextKey);
      if (prevNext !== undefined && prevNext <= nextG - 0.05) continue;

      const nextDist = Math.hypot(targetEnd.pos[0] - stepped.nextEnd.pos[0], targetEnd.pos[2] - stepped.nextEnd.pos[2]);
      const nextLevel = Math.round(stepped.nextEnd.pos[1] / LEVEL_HEIGHT);
      const da = angleDiff(outwardHeading(stepped.nextEnd), wantArrivingOut);
      const h = Math.max(nextDist, 5.4 * da, Math.abs(nextLevel - targetLevel) * 12.0);

      heap.push(nextG + h * 1.15, {
        end: stepped.nextEnd,
        prevPieces: curPieces,
        prevOpen: curOpen,
        prevEnd: cur.end,
        pendingPiece: stepped.piece,
        added: [...cur.added, stepped.piece],
        g: nextG,
        lastTurn: turn !== 0 ? turn : cur.lastTurn,
        reversals: cur.reversals + reversal,
        halfCount: cur.halfCount + (kind === "HalfStraight" ? 1 : 0),
        quarterCount: cur.quarterCount + (kind === "QuarterStraight" ? 1 : 0),
        consecCurve: nextConsec,
        totalCurve: nextTotalCurve,
      });
    }
  }

  // 定形レールで見つからなかった場合、同階層なら曲がるレール (FlexRail) で補完する
  if (solutions.length === 0 && opts?.allowFlex !== false && Math.abs(startEnd.pos[1] - targetEnd.pos[1]) < 0.05) {
    // まず直接1本の曲がるレールで繋げるか最優先で試す
    const directFlex = buildFlexBridge(catalog, pieces, open, startEnd, targetEnd, halfWidth);
    if (directFlex) {
      solutions.push({
        replacements: [],
        additions: [directFlex],
        nextEnd: null,
        summary: "曲がるレールでつなぐ (1本)",
        kind: "connect",
        score: d0 + 6.0,
      });
    }
    nearStates.sort((a, b) => a.added.length * 2.5 + a.dist - (b.added.length * 2.5 + b.dist));
    const tried = new Set<string>([stateKey(startEnd)]);
    for (const item of nearStates.slice(0, 16)) {
      const k = stateKey(item.end);
      if (tried.has(k)) continue;
      tried.add(k);
      const flex = buildFlexBridge(catalog, item.pieces, item.open, item.end, targetEnd, halfWidth);
      if (flex) {
        const added = [...item.added, flex];
        solutions.push({
          replacements: [],
          additions: added,
          nextEnd: null,
          summary: `曲がるレールでつなぐ (${added.length}本)`,
          kind: "connect",
          score: item.g + item.dist + 8.0,
        });
        if (solutions.length >= 2) break;
      }
    }
  }

  return pickDiversePlans(solutions, 3);
}

/** 直列につながった2本の 1/2直線 (HalfStraight) を 1本の直線 (6m) の姿勢として見つける */
function collinearHalfPairs(catalog: Catalog, pieces: PieceSave[], idx: number): { indices: [number, number]; startPos: [number, number, number]; yawDeg: number }[] {
  const a = pieces[idx];
  if (!a || a.kind !== "HalfStraight") return [];
  const def = catalog.get("HalfStraight");
  if (!def) return [];
  const aStart = toWorld(a, def.ports[0]!.position);
  const aEnd = toWorld(a, def.ports[1]!.position);
  const out: { indices: [number, number]; startPos: [number, number, number]; yawDeg: number }[] = [];

  for (let j = 0; j < pieces.length; j++) {
    if (j === idx || pieces[j]!.kind !== "HalfStraight") continue;
    const b = pieces[j]!;
    if (Math.abs(a.position.y - b.position.y) > 0.03) continue;
    const bStart = toWorld(b, def.ports[0]!.position);
    const bEnd = toWorld(b, def.ports[1]!.position);
    const axisGap = Math.abs((((a.euler.y - b.euler.y) % 180) + 270) % 180 - 90);
    if (axisGap > 2) continue; // 平行でない（差が 0° か 180° に近いこと）

    // 4通りの端一致を調べ、全体の始点と向きを求める
    const pairs: { sharedA: [number, number, number]; sharedB: [number, number, number]; outer1: [number, number, number]; outer2: [number, number, number] }[] = [
      { sharedA: aEnd, sharedB: bStart, outer1: aStart, outer2: bEnd },
      { sharedA: aEnd, sharedB: bEnd, outer1: aStart, outer2: bStart },
      { sharedA: aStart, sharedB: bEnd, outer1: bStart, outer2: aEnd },
      { sharedA: aStart, sharedB: bStart, outer1: bEnd, outer2: aEnd },
    ];
    for (const pair of pairs) {
      if (Math.hypot(pair.sharedA[0] - pair.sharedB[0], pair.sharedA[2] - pair.sharedB[2]) > JOIN) continue;
      const dx = pair.outer2[0] - pair.outer1[0];
      const dz = pair.outer2[2] - pair.outer1[2];
      const len = Math.hypot(dx, dz);
      if (Math.abs(len - 6.0) > 0.08) continue;
      // outer1 -> outer2 が局所 -z に一致する yaw
      const theta = Math.atan2(dx, -dz);
      out.push({ indices: [idx, j], startPos: pair.outer1, yawDeg: degrees(-theta) });
      break;
    }
  }
  return out;
}

/**
 * 既存の部品 idx から分岐を生やす全バリエーション（衝突チェック済み）を返す。
 * - Straight: 順向き左/右 + 逆向き左/右（最大4通り）
 * - HalfStraight: 隣接する同一直線の HalfStraight と合体して 6m 分岐へ（最大4〜8通り）
 * - PointLeft / PointRight: 既存の空き Branch 口、または PointThree（3分岐）への昇格
 */
export function branchVariants(catalog: Catalog, pieces: PieceSave[], open: OpenPort[], idx: number, halfWidth: number): BranchVariant[] {
  const old = pieces[idx];
  if (!old) return [];
  const out: BranchVariant[] = [];

  const tryVariant = (indices: number[], candidate: PieceSave, branchPortId: string) => {
    const def = catalog.get(candidate.kind);
    if (!def) return;
    const port = def.ports.find((p) => p.id === branchPortId);
    if (!port) return;
    const removed = new Set(indices);
    const rest = pieces.filter((_, i) => !removed.has(i));
    const restOpen = openPorts(catalog, rest);
    const hits = findOverlaps(catalog, rest, candidate, restOpen, halfWidth);
    if (hits.length > 0) return;
    const basePieces = [...rest, candidate];
    const baseOpen = openPorts(catalog, basePieces);
    const branchPort = portToOpen(candidate, def, port, basePieces.length - 1);
    // 新しく生やした分岐口が実際に開いていること
    const liveBranch = baseOpen.find((o) => o.piece === basePieces.length - 1 && o.id === branchPortId) ?? branchPort;
    out.push({
      replacement: { indices, piece: candidate },
      branchPort: liveBranch,
      basePieces,
      baseOpen,
      outward: outwardHeading(liveBranch),
    });
  };

  if (old.kind === "Straight") {
    const straightDef = catalog.get("Straight")!;
    const endPos = toWorld(old, straightDef.ports[1]!.position);
    const revYaw = (old.euler.y + 180) % 360;
    const specs: { kind: "PointLeft" | "PointRight"; pos: [number, number, number]; yaw: number }[] = [
      { kind: "PointLeft", pos: [old.position.x, old.position.y, old.position.z], yaw: old.euler.y },
      { kind: "PointRight", pos: [old.position.x, old.position.y, old.position.z], yaw: old.euler.y },
      { kind: "PointLeft", pos: endPos, yaw: revYaw },
      { kind: "PointRight", pos: endPos, yaw: revYaw },
    ];
    for (const s of specs) {
      const cand = asAutoPoint(catalog, {
        kind: s.kind,
        position: { x: s.pos[0], y: s.pos[1], z: s.pos[2] },
        euler: { x: 0, y: s.yaw, z: 0 },
        state: "",
        lift: 0,
        liftFrom: "",
        branchSet: false,
        autoFlip: false,
      });
      tryVariant([idx], cand, "Branch");
    }
  } else if (old.kind === "HalfStraight") {
    for (const pair of collinearHalfPairs(catalog, pieces, idx)) {
      const yawRad = (pair.yawDeg * Math.PI) / 180;
      const endPos: [number, number, number] = [
        pair.startPos[0] + -6 * Math.sin(yawRad),
        pair.startPos[1],
        pair.startPos[2] + -6 * Math.cos(yawRad),
      ];
      const revYaw = (pair.yawDeg + 180) % 360;
      const specs: { kind: "PointLeft" | "PointRight"; pos: [number, number, number]; yaw: number }[] = [
        { kind: "PointLeft", pos: pair.startPos, yaw: pair.yawDeg },
        { kind: "PointRight", pos: pair.startPos, yaw: pair.yawDeg },
        { kind: "PointLeft", pos: endPos, yaw: revYaw },
        { kind: "PointRight", pos: endPos, yaw: revYaw },
      ];
      for (const s of specs) {
        const cand = asAutoPoint(catalog, {
          kind: s.kind,
          position: { x: s.pos[0], y: s.pos[1], z: s.pos[2] },
          euler: { x: 0, y: s.yaw, z: 0 },
          state: "",
          lift: 0,
          liftFrom: "",
          branchSet: false,
          autoFlip: false,
        });
        tryVariant(pair.indices, cand, "Branch");
      }
    }
  } else if (old.kind === "PointLeft" || old.kind === "PointRight") {
    // すでに Branch が空いているなら差し替え不要
    const existingOpen = open.find((o) => o.piece === idx && o.id === "Branch");
    if (existingOpen) {
      out.push({
        replacement: null,
        branchPort: existingOpen,
        basePieces: pieces,
        baseOpen: open,
        outward: outwardHeading(existingOpen),
      });
    }
    // 反対側へ 3分岐 (PointThree) へ昇格
    if (catalog.has("PointThree")) {
      const cand = asAutoPoint(catalog, {
        ...old,
        kind: "PointThree",
        state: "",
        branchSet: false,
        autoFlip: false,
      });
      const newPortId = old.kind === "PointLeft" ? "Branch2" : "Branch";
      tryVariant([idx], cand, newPortId);
    }
  }
  return out;
}

/** その部品がかんたんモードで自動分岐の起点／合流先になれるか */
export function canAutoBranch(catalog: Catalog, pieces: PieceSave[], open: OpenPort[], idx: number, halfWidth: number): boolean {
  return branchVariants(catalog, pieces, open, idx, halfWidth).length > 0;
}

/** 既存レール sourceIdx から分岐してマット上の点 (targetX, targetZ, targetLevel) へ伸ばす */
export function planBranchToPoint(
  catalog: Catalog,
  pieces: PieceSave[],
  open: OpenPort[],
  sourceIdx: number,
  targetX: number,
  targetZ: number,
  targetLevel: number,
  halfWidth: number,
): EasyPlan[] {
  const variants = branchVariants(catalog, pieces, open, sourceIdx, halfWidth);
  if (!variants.length) return [];

  const plans: EasyPlan[] = [];
  for (const v of variants) {
    const distFromBranch = Math.hypot(targetX - v.branchPort.pos[0], targetZ - v.branchPort.pos[2]);
    // 分岐のすぐ出口付近をタップした場合：分岐パーツ単体でも候補にする
    if (distFromBranch < 3.6 && Math.round(v.branchPort.pos[1] / LEVEL_HEIGHT) === targetLevel) {
      plans.push({
        replacements: v.replacement ? [v.replacement] : [],
        additions: [],
        nextEnd: v.branchPort,
        summary: "ここから分岐する",
        kind: "branch",
        score: distFromBranch * 2.2 + 0.8,
      });
    }
    const sub = planToPoint(catalog, v.basePieces, v.baseOpen, v.branchPort, targetX, targetZ, targetLevel, halfWidth, {
      maxDepth: 9,
      maxNodes: 260,
    });
    for (const p of sub) {
      plans.push({
        ...p,
        replacements: v.replacement ? [v.replacement] : [],
        summary: p.kind === "connect" ? `分岐してつなぐ (${p.additions.length}本)` : `分岐して伸ばす (${p.additions.length}本)`,
        kind: "branch",
      });
    }
  }
  return pickDiversePlans(plans, 4);
}

/** 開いている端 startEnd から、既存レール targetIdx へ自動分岐（合流）でつなぐ */
export function planMergeIntoPiece(
  catalog: Catalog,
  pieces: PieceSave[],
  open: OpenPort[],
  startEnd: OpenPort,
  targetIdx: number,
  halfWidth: number,
): EasyPlan[] {
  if (startEnd.piece === targetIdx) return [];
  const variants = branchVariants(catalog, pieces, open, targetIdx, halfWidth);
  if (!variants.length) return [];

  const plans: EasyPlan[] = [];
  for (const v of variants) {
    // 置き換え後の baseOpen から startEnd に対応する口を探し直す
    const liveStart = v.baseOpen.find(
      (o) => Math.hypot(o.pos[0] - startEnd.pos[0], o.pos[1] - startEnd.pos[1], o.pos[2] - startEnd.pos[2]) <= JOIN,
    );
    if (!liveStart) continue;
    // すでに startEnd と branchPort がぴったり接している場合（追加0本で合流）
    if (portsMatch(liveStart, v.branchPort)) {
      plans.push({
        replacements: v.replacement ? [v.replacement] : [],
        additions: [],
        nextEnd: null,
        summary: "分岐を入れて合流",
        kind: "merge",
        score: 0.1,
      });
      continue;
    }
    const sub = planToPort(catalog, v.basePieces, v.baseOpen, liveStart, v.branchPort, halfWidth, {
      maxDepth: 14,
      maxNodes: 650,
    });
    for (const p of sub) {
      plans.push({
        ...p,
        replacements: v.replacement ? [v.replacement] : [],
        summary: `合流してつなぐ (${p.additions.length}本)`,
        kind: "merge",
      });
    }
  }
  return pickDiversePlans(plans, 3);
}

/** 既存レール sourceIdx から分岐し、別の既存レール targetIdx へ合流する（両端自動ターンアウト） */
export function planBranchAndMerge(
  catalog: Catalog,
  pieces: PieceSave[],
  open: OpenPort[],
  sourceIdx: number,
  targetIdx: number,
  halfWidth: number,
): EasyPlan[] {
  if (sourceIdx === targetIdx) return [];
  const srcVars = branchVariants(catalog, pieces, open, sourceIdx, halfWidth);
  const dstVars = branchVariants(catalog, pieces, open, targetIdx, halfWidth);
  if (!srcVars.length || !dstVars.length) return [];

  // 互いの出口が相手側を向いている組み合わせを優先して試す
  const pairs: { s: BranchVariant; d: BranchVariant; align: number }[] = [];
  for (const s of srcVars) {
    const sIdx = new Set(s.replacement?.indices ?? []);
    for (const d of dstVars) {
      const dIdx = d.replacement?.indices ?? [];
      if (dIdx.some((i) => sIdx.has(i))) continue; // 同じ部品を二重に差し替えない
      const dx = d.branchPort.pos[0] - s.branchPort.pos[0];
      const dz = d.branchPort.pos[2] - s.branchPort.pos[2];
      const dist = Math.hypot(dx, dz);
      const toDst = Math.atan2(dx, -dz);
      const toSrc = Math.atan2(-dx, dz);
      const align = angleDiff(s.outward, toDst) + angleDiff(d.outward, toSrc) + dist * 0.03;
      pairs.push({ s, d, align });
    }
  }
  pairs.sort((a, b) => a.align - b.align);

  const plans: EasyPlan[] = [];
  for (const { s, d } of pairs.slice(0, 6)) {
    const reps: PieceReplacement[] = [];
    if (s.replacement) reps.push(s.replacement);
    if (d.replacement) reps.push(d.replacement);
    const removed = new Set(reps.flatMap((r) => r.indices));
    const rest = pieces.filter((_, i) => !removed.has(i));
    // 両方の分岐部品が互いに衝突しないか確認
    const combinedPieces = [...rest];
    let ok = true;
    for (const r of reps) {
      const hits = findOverlaps(catalog, combinedPieces, r.piece, openPorts(catalog, combinedPieces), halfWidth);
      if (hits.length > 0) {
        ok = false;
        break;
      }
      combinedPieces.push(r.piece);
    }
    if (!ok) continue;

    const combinedOpen = openPorts(catalog, combinedPieces);
    const liveSrc = combinedOpen.find(
      (o) => Math.hypot(o.pos[0] - s.branchPort.pos[0], o.pos[1] - s.branchPort.pos[1], o.pos[2] - s.branchPort.pos[2]) <= JOIN,
    );
    const liveDst = combinedOpen.find(
      (o) => Math.hypot(o.pos[0] - d.branchPort.pos[0], o.pos[1] - d.branchPort.pos[1], o.pos[2] - d.branchPort.pos[2]) <= JOIN,
    );
    if (!liveSrc || !liveDst) continue;

    const sub = planToPort(catalog, combinedPieces, combinedOpen, liveSrc, liveDst, halfWidth, {
      maxDepth: 14,
      maxNodes: 550,
    });
    for (const p of sub) {
      plans.push({
        ...p,
        replacements: reps,
        summary: `分岐して合流 (${p.additions.length}本)`,
        kind: "branch-merge",
      });
    }
    if (plans.length >= 3) break;
  }
  return pickDiversePlans(plans, 3);
}

/** 2つ以上の開いた端があるとき、ワンタップで輪を閉じる候補を探す */
export function planAutoClose(
  catalog: Catalog,
  pieces: PieceSave[],
  open: OpenPort[],
  selectedEnd: OpenPort | null,
  halfWidth: number,
): EasyPlan[] {
  if (open.length < 2) return [];
  const pairs: [OpenPort, OpenPort][] = [];
  if (selectedEnd) {
    const others = open
      .filter((o) => !(o.piece === selectedEnd.piece && o.id === selectedEnd.id))
      .sort(
        (a, b) =>
          Math.hypot(a.pos[0] - selectedEnd.pos[0], a.pos[2] - selectedEnd.pos[2]) -
          Math.hypot(b.pos[0] - selectedEnd.pos[0], b.pos[2] - selectedEnd.pos[2]),
      );
    for (const o of others.slice(0, 4)) pairs.push([selectedEnd, o]);
  } else {
    const allPairs: { a: OpenPort; b: OpenPort; d: number }[] = [];
    for (let i = 0; i < open.length; i++) {
      for (let j = i + 1; j < open.length; j++) {
        const a = open[i]!;
        const b = open[j]!;
        const d = Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]);
        allPairs.push({ a, b, d });
      }
    }
    allPairs.sort((x, y) => x.d - y.d);
    for (const p of allPairs.slice(0, 5)) pairs.push([p.a, p.b]);
  }

  const plans: EasyPlan[] = [];
  for (const [a, b] of pairs) {
    let found = planToPort(catalog, pieces, open, a, b, halfWidth, { maxDepth: 16, maxNodes: 950 });
    if (!found.length) {
      found = planToPort(catalog, pieces, open, b, a, halfWidth, { maxDepth: 16, maxNodes: 950 });
    }
    plans.push(...found);
    if (plans.length >= 3) break;
  }
  return pickDiversePlans(plans, 3);
}

/**
 * マット上の何もない場所をタップしたときの総合判断：
 * - 開いた端が選ばれていればそこから伸ばす
 * - 端が未選択でも開いた端があれば、いちばん自然な端から自動で伸ばす
 * - 開いた端が0（閉じたコース）なら、その場に新しい直線の起点を作る
 */
export function planMatTap(
  catalog: Catalog,
  pieces: PieceSave[],
  open: OpenPort[],
  selectedEnd: OpenPort | null,
  targetX: number,
  targetZ: number,
  targetLevel: number,
  defaultTheta: number,
  halfWidth: number,
): EasyPlan[] {
  if (selectedEnd) {
    return planToPoint(catalog, pieces, open, selectedEnd, targetX, targetZ, targetLevel, halfWidth);
  }
  if (open.length > 0) {
    const ranked = open
      .map((o) => {
        const d = Math.hypot(targetX - o.pos[0], targetZ - o.pos[2]);
        const toT = Math.atan2(targetX - o.pos[0], -(targetZ - o.pos[2]));
        const ang = angleDiff(outwardHeading(o), toT);
        return { o, rank: d + ang * 4.0 + Math.abs(o.pos[1] - targetLevel * LEVEL_HEIGHT) * 6 };
      })
      .sort((a, b) => a.rank - b.rank);
    const plans: EasyPlan[] = [];
    for (const item of ranked.slice(0, 2)) {
      plans.push(...planToPoint(catalog, pieces, open, item.o, targetX, targetZ, targetLevel, halfWidth));
    }
    return pickDiversePlans(plans, 4);
  }
  // 開いた端が無いときは、その場所へ新しい直線の起点を置く
  const gx = Math.round(targetX / 1.5) * 1.5;
  const gz = Math.round(targetZ / 1.5) * 1.5;
  const gy = Math.max(0, targetLevel) * LEVEL_HEIGHT;
  const start = freePlacement(catalog, "Straight", [gx, gy, gz], defaultTheta);
  if (!start) return [];
  if (findOverlaps(catalog, pieces, start, open, halfWidth).length > 0) return [];
  const def = catalog.get("Straight")!;
  const endPort = portToOpen(start, def, def.ports[1]!, pieces.length);
  return [
    {
      replacements: [],
      additions: [start],
      nextEnd: endPort,
      summary: "新しい線路をここから始める",
      kind: "start",
      score: 0,
    },
  ];
}

/** 同じ形ばかりの候補を省いて、上位の多様な候補を残す */
function pickDiversePlans(plans: EasyPlan[], limit: number): EasyPlan[] {
  if (!plans.length) return [];
  plans.sort((a, b) => a.score - b.score);
  const out: EasyPlan[] = [];
  const seenSig = new Set<string>();
  for (const p of plans) {
    const repSig = p.replacements.map((r) => `${r.indices.join(",")}:${r.piece.kind}:${Math.round(r.piece.euler.y)}`).join("|");
    const addSig = p.additions.map((a) => a.kind).join(",");
    const fullSig = `${repSig}#${addSig}`;
    if (seenSig.has(fullSig)) continue;
    seenSig.add(fullSig);
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

// --- ランダム車種選択 & 路線（つながり）優先の自動電車配置 ---

export interface ExistingTrainInfo {
  route: Route;
  headS: number;
  length: number;
}

export interface AutoTrainSpawn {
  entry: { piece: number; port: string };
  route: Route;
  headS: number;
  /** まだ1編成もいない独立路線（島）に置かれたか */
  emptyIsland: boolean;
  /** 既存編成のルートが通っていない未走行区間に置かれたか */
  uncovered: boolean;
  /** レイアウト内の独立路線（島）の数 */
  islandCount: number;
}

/**
 * まだ走っていない車種を優先して、ランダムに1種選ぶ。
 * 車線が中央 ("") なら通常車両、L/R ならスリム車両から選ぶ。
 */
export function pickRandomTrainId(
  allIds: string[],
  usedIds: string[],
  lane: string,
  lastId?: string,
  rng: () => number = Math.random,
): string | null {
  const gaugePool = allIds.filter((id) => (lane ? id.startsWith("Advance") : !id.startsWith("Advance")));
  const pool = gaugePool.length ? gaugePool : allIds;
  if (!pool.length) return null;
  const used = new Set(usedIds);
  const unused = pool.filter((id) => !used.has(id));
  const candidates = unused.length ? unused : pool.length > 1 && lastId ? pool.filter((id) => id !== lastId) : pool;
  const idx = Math.min(candidates.length - 1, Math.floor(rng() * candidates.length));
  return candidates[idx] ?? pool[0]!;
}

/** 部品どうしのつながり（島＝独立した路線）を列挙する */
function pieceIslands(catalog: Catalog, pieces: PieceSave[]): number[][] {
  const n = pieces.length;
  const ports = pieces.map((p) => (catalog.of(p)?.ports ?? []).map((q) => toWorld(p, q.position)));
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const connected = ports[i]!.some((a) =>
        ports[j]!.some((b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= JOIN),
      );
      if (connected) {
        adj[i]!.push(j);
        adj[j]!.push(i);
      }
    }
  }
  const seen = new Uint8Array(n);
  const islands: number[][] = [];
  for (let i = 0; i < n; i++) {
    if (seen[i]) continue;
    const comp: number[] = [];
    const q = [i];
    seen[i] = 1;
    while (q.length) {
      const cur = q.shift()!;
      comp.push(cur);
      for (const nb of adj[cur]!) {
        if (!seen[nb]) {
          seen[nb] = 1;
          q.push(nb);
        }
      }
    }
    islands.push(comp);
  }
  return islands;
}

/** ルート上で既存編成から最も離れ、なるべく平坦な配置位置 (headS) を探す */
function bestSpotOnRoute(
  r: Route,
  trainLength: number,
  occupiedPts: { x: number; y: number; z: number }[],
): { headS: number; clearance: number; flat: boolean } | null {
  if (r.length + 0.01 < trainLength) return null;
  const step = Math.max(1.2, r.length / 48);
  let best: { headS: number; clearance: number; flat: boolean; rank: number } | null = null;
  const maxHead = Math.max(trainLength, r.length);
  for (let head = trainLength; head <= maxHead + 0.01; head += step) {
    const clampedHead = Math.min(r.length, head);
    let minD = Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let s = clampedHead - trainLength; s <= clampedHead + 0.01; s += 1.1) {
      const p = r.at(Math.max(0, s));
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
      for (const q of occupiedPts) {
        if (Math.abs(p.y - q.y) > 1.0) continue;
        const d = Math.hypot(p.x - q.x, p.z - q.z);
        if (d < minD) minD = d;
      }
    }
    if (minD < 2.2) continue;
    const flat = maxY - minY < 0.08;
    // 空の路線（minD=Infinity）では平坦区間を優先しつつ、既存編成がある場合は距離を最優先
    const cappedD = Number.isFinite(minD) ? Math.min(minD, 30) : 40;
    const rank = cappedD + (flat ? 1.5 : 0);
    if (!best || rank > best.rank) {
      best = { headS: clampedHead, clearance: minD, flat, rank };
    }
  }
  return best ? { headS: best.headS, clearance: best.clearance, flat: best.flat } : null;
}

/**
 * 線路のつながり（独立路線・未走行の支線）を見て、電車がいない路線を優先して最適な配置先を決める。
 * 優先順:
 * 1. まだ1編成もいない独立路線（島）
 * 2. 既存編成の走行ルートに含まれていない区間（支線・別ループ等）
 * 3. 編成数が少なく、既存編成から十分離れて置ける場所（周回ルート優先）
 */
export function planAutoTrainSpawn(
  catalog: Catalog,
  pieces: PieceSave[],
  existing: ExistingTrainInfo[],
  trainLength: number,
  lane = "",
): AutoTrainSpawn | null {
  if (!pieces.length) return null;
  const islands = pieceIslands(catalog, pieces);
  const pieceToIsland = new Map<number, number>();
  islands.forEach((comp, idx) => comp.forEach((pi) => pieceToIsland.set(pi, idx)));

  const islandTrainCount = new Array<number>(islands.length).fill(0);
  const coveredTracks = new Set<string>();
  const occupiedPts: { x: number; y: number; z: number }[] = [];

  for (const e of existing) {
    const head = e.route.canonicalHead(e.headS, e.length);
    const tail = Math.max(0, head - e.length);
    const under = e.route.segsUnder(tail, head);
    const countedIslands = new Set<number>();
    for (const sg of under) {
      const isl = pieceToIsland.get(sg.piece);
      if (isl !== undefined && !countedIslands.has(isl)) {
        countedIslands.add(isl);
        islandTrainCount[isl]!++;
      }
    }
    for (const sg of e.route.segs) coveredTracks.add(`${sg.piece}:${sg.path}`);
    for (let s = e.headS - e.length; s <= e.headS + 0.01; s += 1.0) {
      const p = e.route.at(Math.max(0, s));
      occupiedPts.push({ x: p.x, y: p.y, z: p.z });
    }
  }

  const open = openPorts(catalog, pieces);
  const openByPiece = new Map<number, OpenPort[]>();
  for (const o of open) {
    const list = openByPiece.get(o.piece) ?? [];
    list.push(o);
    openByPiece.set(o.piece, list);
  }

  const hasUncoveredTrack = (pi: number): boolean => {
    const def = catalog.of(pieces[pi]!);
    if (!def) return false;
    return def.paths.some((p) => !p.lane && !(p as { frames?: unknown }).frames && !coveredTracks.has(`${pi}:${p.id}`));
  };

  interface Candidate extends AutoTrainSpawn {
    islandTrainCount: number;
    clearance: number;
    closed: boolean;
  }
  const candidates: Candidate[] = [];

  islands.forEach((comp, islIdx) => {
    const trainsHere = islandTrainCount[islIdx]!;
    const emptyIsland = trainsHere === 0;
    const seeds: { piece: number; port: string }[] = [];
    const seenSeed = new Set<string>();
    const addSeed = (pieceIdx: number, portId: string) => {
      const key = `${pieceIdx}:${portId}`;
      if (seenSeed.has(key)) return;
      seenSeed.add(key);
      seeds.push({ piece: pieceIdx, port: portId });
    };

    // 1) この島の開いた端（行き止まり線では端から辿ることで全長を確保）
    for (const pi of comp) {
      for (const o of openByPiece.get(pi) ?? []) addSeed(pi, o.id);
    }
    // 2) 既存ルートが通っていない道（複線の空き線・未走行支線・別周回）
    const uncoveredList = comp.filter(hasUncoveredTrack);
    for (const pi of uncoveredList.slice(0, 4)) {
      const def = catalog.of(pieces[pi]!);
      if (!def) continue;
      for (const path of def.paths) {
        if (path.lane || (path as { frames?: unknown }).frames) continue;
        if (!coveredTracks.has(`${pi}:${path.id}`)) {
          addSeed(pi, path.from);
          addSeed(pi, path.to);
        }
      }
    }
    // 3) 島の代表部品（直線を優先。複線なら両方の線から試す）
    const rep = comp.find((pi) => pieces[pi]!.kind === "Straight" || pieces[pi]!.kind.startsWith("Double")) ?? comp[0]!;
    const repDef = catalog.of(pieces[rep]!);
    if (repDef) {
      for (const path of repDef.paths) {
        if (!path.lane && !(path as { frames?: unknown }).frames) addSeed(rep, path.from);
      }
      if (repDef.ports[0]) addSeed(rep, repDef.ports[0].id);
    }

    for (const seed of seeds) {
      const r = buildRoute(catalog, pieces, { piece: seed.piece, port: seed.port }, undefined, undefined, lane);
      if (!r.points.length || r.length + 0.01 < trainLength) continue;
      const spot = bestSpotOnRoute(r, trainLength, occupiedPts);
      if (!spot) continue;
      // 置く場所だけでなくルート全体が既存編成と別線（未走行線）かを判定
      const uncoveredCount = r.segs.filter((sg) => !coveredTracks.has(`${sg.piece}:${sg.path}`)).length;
      const tail = Math.max(0, spot.headS - trainLength);
      const segsAtSpot = r.segsUnder(tail, spot.headS);
      const spotUncovered =
        uncoveredCount > 0 && segsAtSpot.length > 0 && segsAtSpot.every((sg) => !coveredTracks.has(`${sg.piece}:${sg.path}`));
      candidates.push({
        entry: { piece: seed.piece, port: seed.port },
        route: r,
        headS: spot.headS,
        emptyIsland,
        uncovered: spotUncovered,
        islandCount: islands.length,
        islandTrainCount: trainsHere,
        clearance: spot.clearance,
        closed: r.closed,
      });
    }
  });

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    if (a.emptyIsland !== b.emptyIsland) return a.emptyIsland ? -1 : 1;
    if (a.uncovered !== b.uncovered) return a.uncovered ? -1 : 1;
    if (a.islandTrainCount !== b.islandTrainCount) return a.islandTrainCount - b.islandTrainCount;
    if (a.closed !== b.closed) return a.closed ? -1 : 1;
    const densA = a.islandTrainCount / Math.max(1, a.route.length);
    const densB = b.islandTrainCount / Math.max(1, b.route.length);
    if (Math.abs(densA - densB) > 0.002) return densA - densB;
    const cA = Number.isFinite(a.clearance) ? a.clearance : 999;
    const cB = Number.isFinite(b.clearance) ? b.clearance : 999;
    return cB - cA;
  });

  const best = candidates[0]!;
  return {
    entry: best.entry,
    route: best.route,
    headS: best.headS,
    emptyIsland: best.emptyIsland,
    uncovered: best.uncovered,
    islandCount: best.islandCount,
  };
}

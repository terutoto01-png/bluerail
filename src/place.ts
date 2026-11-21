// 配置の幾何。開いた端を見つけ、部品をその端へ継ぐときの姿勢を求める。three には依存しない
import type { Catalog, PortDef, RailDef } from "./catalog";
import type { PieceSave } from "./course";
import { layPath } from "./route";
import { portHeading, toWorld } from "./track";

/** この距離以内にある口どうしは繋がっているとみなす（Unity の `JoinTolerance`） */
const JOIN = 0.05;

export interface OpenPort {
  piece: number;
  id: string;
  /** 世界座標（Unity の座標） */
  pos: [number, number, number];
  /** 世界での向き θ（`track.ts` の定義。yaw とは符号が逆） */
  heading: number;
  /** 部品へ入る側の口か。継ぐ相手がこれと逆なら向きは同じ、同じなら 180° 回す */
  upstream: boolean;
}

/**
 * その口が「入る側」か。道の from にだけ現れれば入る側、to にだけなら出る側。
 * 両方に現れる口（交差の腕など）は、口の向きが部品の中心を向いているかで決める
 * ——json の行の並びで裏返ってはいけない
 */
export function isUpstream(def: RailDef, port: PortDef): boolean {
  const isFrom = def.paths.some((p) => p.from === port.id);
  const isTo = def.paths.some((p) => p.to === port.id);
  if (isFrom && !isTo) return true;
  if (isTo && !isFrom) return false;
  const n = def.ports.length;
  const cx = def.ports.reduce((a, p) => a + p.position[0], 0) / n;
  const cz = def.ports.reduce((a, p) => a + p.position[2], 0) / n;
  const h = portHeading(port);
  const inward = Math.sin(h) * (cx - port.position[0]) + -Math.cos(h) * (cz - port.position[2]);
  return inward >= 0;
}

const yawOf = (piece: PieceSave) => (piece.euler.y * Math.PI) / 180;

/** 開いている口（他の部品の口と重なっていないもの）。終端の定義 */
export function openPorts(catalog: Catalog, pieces: PieceSave[]): OpenPort[] {
  const all: OpenPort[] = [];
  pieces.forEach((piece, i) => {
    const def = catalog.of(piece);
    if (!def) return;
    for (const port of def.ports) {
      all.push({
        piece: i,
        id: port.id,
        pos: toWorld(piece, port.position),
        heading: portHeading(port) - yawOf(piece),
        upstream: isUpstream(def, port),
      });
    }
  });
  return all.filter(
    (a) => !all.some((b) => b.piece !== a.piece && Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]) < JOIN),
  );
}

/** 部品の面（一緒に嵌る口の束）。出てきた順 */
export function facesOf(def: RailDef): string[] {
  return [...new Set(def.ports.map((p) => p.face))];
}

/** 道の許す範囲で角度を [0, 360) に */
const degrees = (rad: number) => ((((rad * 180) / Math.PI) % 360) + 360) % 360;

/**
 * 部品 kind の面 face を、開いた端 end へ継いだときの姿勢。継げなければ null。
 * 面が2口以上なら、残りの口もすべて開いた端と重なること（複線の端に複線）
 */
export function mate(
  catalog: Catalog,
  open: OpenPort[],
  end: OpenPort,
  kind: string,
  face: string,
): PieceSave | null {
  const def = catalog.get(kind);
  if (!def) return null;
  const ports = def.ports.filter((p) => p.face === face);
  for (const q of ports) {
    // 入る側と出る側が向き合えば進行方向は同じ。同じ側どうしなら向き合わせるので 180° 回す
    const target = isUpstream(def, q) !== end.upstream ? end.heading : end.heading + Math.PI;
    const yaw = portHeading(q) - target;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const [qx, qy, qz] = q.position;
    const position = {
      x: end.pos[0] - (qx * c + qz * s),
      y: end.pos[1] - qy,
      z: end.pos[2] - (-qx * s + qz * c),
    };
    const piece: PieceSave = {
      kind,
      position,
      euler: { x: 0, y: degrees(yaw), z: 0 },
      state: "",
      lift: 0,
      liftFrom: "",
      branchSet: false,
      autoFlip: false,
    };
    // 残りの口が、開いた端のどれかに着くか
    const fits = ports
      .filter((p) => p !== q)
      .every((p) => {
        const w = toWorld(piece, p.position);
        return open.some(
          (o) => o !== end && Math.hypot(o.pos[0] - w[0], o.pos[1] - w[1], o.pos[2] - w[2]) < JOIN,
        );
      });
    if (fits) return piece;
  }
  return null;
}

/**
 * 自由配置の姿勢。部品の「最初の道の始まりの口」を、マットの aim へ、進む向き theta で置く（Unity §5.11）。
 * 道が無い部品（車止め）は最初の口を使う
 */
export function freePlacement(catalog: Catalog, kind: string, aim: [number, number, number], theta: number): PieceSave | null {
  const def = catalog.get(kind);
  if (!def) return null;
  const path = def.paths.find((p) => !(p as { frames?: unknown }).frames);
  const q = def.ports.find((p) => p.id === path?.from) ?? def.ports[0];
  if (!q) return null;
  // 道の始まりが向く方位（局所）。世界の方位 = 局所 − yaw なので、theta に合わせる yaw はその差
  const local = path ? layPath(def, path)[0]!.heading : portHeading(q);
  const yaw = local - theta;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const [qx, qy, qz] = q.position;
  return {
    kind,
    position: { x: aim[0] - (qx * c + qz * s), y: aim[1] - qy, z: aim[2] - (-qx * s + qz * c) },
    euler: { x: 0, y: degrees(yaw), z: 0 },
    state: "",
    lift: 0,
    liftFrom: "",
    branchSet: false,
    autoFlip: false,
  };
}

/** その端に継げる面と、置いたときの姿勢の一覧 */
export function placementsAt(
  catalog: Catalog,
  open: OpenPort[],
  end: OpenPort,
  kind: string,
): { face: string; piece: PieceSave }[] {
  const def = catalog.get(kind);
  if (!def) return [];
  const out: { face: string; piece: PieceSave }[] = [];
  for (const face of facesOf(def)) {
    const piece = mate(catalog, open, end, kind, face);
    if (piece) out.push({ face, piece });
  }
  return out;
}

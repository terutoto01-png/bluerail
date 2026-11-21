// 分岐の状態（Unity §6.1.1 と同じ形式）。腕（道が2本以上ある入口）ごとに、自動か、固定した道の番号を持つ
import type { PathDef, RailDef } from "./catalog";
import type { PieceSave } from "./course";

export interface Candidate {
  path: PathDef;
  reversed: boolean;
}

/** その port から入れる道（中央の車線のみ）。並びは json の道の順 */
export function candidates(def: RailDef, entry: string): Candidate[] {
  const out: Candidate[] = [];
  for (const path of def.paths) {
    if (path.lane || (path as { frames?: unknown }).frames) continue;
    if (path.from === entry) out.push({ path, reversed: false });
    else if (path.to === entry) out.push({ path, reversed: true });
  }
  return out;
}

const flip = (lane: string) => (lane === "L" ? "R" : lane === "R" ? "L" : "");

/** 車線つきの候補。`jsonLane` は、中央の道を車線へ寄せて走るときに道へ掛ける車線（json の向きで見た左右） */
export interface LaneCandidate extends Candidate {
  jsonLane: string | null;
  /** この道を出たあとの、進行方向で見た車線 */
  exitLane: string;
}

/**
 * その口から、車線 lane の列車が入れる道（Unity の `PathsAt` が `activeLane` で絞るのと同じ）。
 * 車線の名前を持つ道（アドバンスの専用レール）があればそれ、無ければ中央の道を車線へ寄せて使う。
 * 車線は進行方向で見た左右なので、json の向きと逆に走るときは左右が入れ替わる
 */
export function laneCandidates(def: RailDef, entry: string, lane: string): LaneCandidate[] {
  const all: Candidate[] = [];
  for (const path of def.paths) {
    if ((path as { frames?: unknown }).frames) continue;
    if (path.from === entry) all.push({ path, reversed: false });
    else if (path.to === entry) all.push({ path, reversed: true });
  }
  const enterLane = (c: Candidate) => {
    const a = c.path.lane ?? "";
    const b = c.path.laneTo ?? a;
    const json = c.reversed ? b : a;
    return c.reversed ? flip(json) : json;
  };
  const exitLane = (c: Candidate) => {
    const a = c.path.lane ?? "";
    const b = c.path.laneTo ?? a;
    return c.reversed ? flip(a) : b;
  };
  if (lane) {
    const own = all.filter((c) => c.path.lane && enterLane(c) === lane);
    if (own.length) return own.map((c) => ({ ...c, jsonLane: null, exitLane: exitLane(c) }));
  }
  // 中央の道（車線の名前を持たない道）を使う。車線へ寄せる
  return all
    .filter((c) => !c.path.lane)
    .map((c) => ({ ...c, jsonLane: lane ? (c.reversed ? flip(lane) : lane) : null, exitLane: lane }));
}

/** 分岐の腕。道が2本以上ある入口。並び順が picks の添字（Unity の `JunctionsOf`） */
export interface Junction {
  port: string;
  count: number;
}

const cache = new WeakMap<RailDef, Junction[]>();

export function junctionsOf(def: RailDef): Junction[] {
  let out = cache.get(def);
  if (!out) {
    out = [];
    if (def.action === "point") {
      for (const port of def.ports) {
        // 中央で1本でも、車線に選択肢があれば分岐（アドバンスのクロスポイント）。刃は車線で共有する
        const count = Math.max(...["", "L", "R"].map((lane) => laneCandidates(def, port.id, lane).length));
        if (count > 1) out.push({ port: port.id, count });
      }
    }
    cache.set(def, out);
  }
  return out;
}

export interface PointState {
  auto: boolean[];
  picks: number[];
}

/** 保存の文字列から腕ごとの状態へ。空は昔のファイルで、branchSet / autoFlip を読む */
export function readState(def: RailDef, piece: PieceSave): PointState {
  const n = junctionsOf(def).length;
  const auto = new Array<boolean>(n).fill(false);
  const picks = new Array<number>(n).fill(0);
  const counts = junctionsOf(def).map((j) => j.count);
  const s = piece.state;
  if (!s) {
    auto.fill(!!piece.autoFlip);
    if (n) picks[0] = piece.branchSet ? 1 : 0;
  } else if (s === "auto") auto.fill(true);
  else if (s.includes("|")) {
    s.split("|").forEach((part, j) => {
      if (j >= n) return;
      auto[j] = part === "a";
      const v = Number.parseInt(part, 10);
      picks[j] = !auto[j] && Number.isFinite(v) ? Math.min(Math.max(v, 0), counts[j]! - 1) : 0;
    });
  } else if (n) {
    const v = s === "branch" ? 1 : s === "through" ? 0 : Number.parseInt(s, 10);
    picks[0] = Number.isFinite(v) ? Math.min(Math.max(v, 0), counts[0]! - 1) : 0;
  }
  return { auto, picks };
}

/** 状態を保存の文字列へ。全部自動なら "auto"、腕が複数なら "a|1|0"、1つなら through / branch / 番号 */
export function writeState(piece: PieceSave, st: PointState) {
  const n = st.picks.length;
  if (!n) return; // 分岐の無い部品の state は、flex や stop のものなので触らない
  if (st.auto.every(Boolean)) piece.state = "auto";
  else if (n > 1) piece.state = st.picks.map((p, j) => (st.auto[j] ? "a" : String(p))).join("|");
  else piece.state = st.picks[0] === 0 ? "through" : st.picks[0] === 1 ? "branch" : String(st.picks[0] ?? 0);
  // 旧形式の欄も合わせておく（読み手が古くても同じ向きになる）
  piece.autoFlip = n > 0 && st.auto.every(Boolean);
  piece.branchSet = (st.picks[0] ?? 0) > 0;
}

/** レバーを1回押したときの次の状態: 自動 → 道0 → 道1 … → 自動 */
export function cycle(st: PointState, j: number, count: number): void {
  if (st.auto[j]) {
    st.auto[j] = false;
    st.picks[j] = 0;
  } else if (st.picks[j]! + 1 < count) st.picks[j]!++;
  else {
    st.auto[j] = true;
    st.picks[j] = 0;
  }
}

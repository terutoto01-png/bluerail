// 走行のマスコン（ノッチ式の運転レバー）。非常・ブレーキ・切・力行の段で、加速と減速の強さを決める。
// 画面のレバーと、ノッチから「目標の速さ」と「加減速の強さ」を求める計算をここにまとめる

export interface Notch {
  id: string;
  label: string;
  kind: "eb" | "brake" | "neutral" | "power";
  /** 力行: 最高速度に対する上限の割合。ブレーキ: 使わない */
  cap?: number;
  /** 加減速の強さ（車両の加速度に掛ける倍率） */
  rate: number;
}

export const NOTCHES: Notch[] = [
  { id: "EB", label: "非常", kind: "eb", rate: 4 },
  { id: "B2", label: "B2", kind: "brake", rate: 2 },
  { id: "B1", label: "B1", kind: "brake", rate: 1 },
  { id: "N", label: "切", kind: "neutral", rate: 0.05 },
  { id: "P1", label: "P1", kind: "power", cap: 0.3, rate: 0.6 },
  { id: "P2", label: "P2", kind: "power", cap: 0.55, rate: 0.8 },
  { id: "P3", label: "P3", kind: "power", cap: 0.8, rate: 1 },
  { id: "P4", label: "P4", kind: "power", cap: 1, rate: 1.2 },
];
export const NEUTRAL = NOTCHES.findIndex((n) => n.kind === "neutral");

/**
 * ノッチと今の速さから、目標の速さ（符号付き）と加減速の倍率を求める。
 * 力行はノッチの上限まで加速し、上限より速ければ惰行する。切は少しずつ遅くなる
 */
export function driveBy(notch: Notch, v: number, dir: 1 | -1, max: number): { target: number; rate: number } {
  if (notch.kind !== "power") return { target: 0, rate: notch.rate };
  const cap = (notch.cap ?? 1) * max;
  if (Math.abs(v) > cap + 0.05 && Math.sign(v) === dir) return { target: v, rate: 0 };
  return { target: dir * cap, rate: notch.rate };
}

/** 一定の速さで走りたいときに使うノッチ（速さ以上の上限を持つ一番低い力行） */
export function notchFor(speed: number, max: number): number {
  const r = Math.abs(speed) / Math.max(max, 0.01);
  if (r < 0.01) return NEUTRAL;
  const i = NOTCHES.findIndex((n) => n.kind === "power" && (n.cap ?? 1) >= r - 0.02);
  return i < 0 ? NOTCHES.length - 1 : i;
}

/** ノッチごとの、いまの状態の言葉 */
const STATE: Record<string, string> = {
  EB: "🛑 ひじょうブレーキ！",
  B2: "つよいブレーキ",
  B1: "ブレーキ",
  N: "そのまま（ゆっくり止まる）",
  P1: "すすむ ▶",
  P2: "すすむ ▶▶",
  P3: "すすむ ▶▶▶",
  P4: "いちばん速く ▶▶▶▶",
};

/**
 * 画面のレバー。溝の上の取っ手を左右に動かす。左が「とまる」、真ん中が「そのまま」、右が「すすむ」。
 * 段（ノッチ）は目盛りで見せ、取っ手は一番近い段へ吸い付く
 */
export class MasconLever {
  private index = NEUTRAL;
  private knob: HTMLElement;
  private stateText: HTMLElement;
  private track: HTMLElement;
  constructor(
    private host: HTMLElement,
    private onChange: (index: number) => void,
  ) {
    host.replaceChildren();
    const n = NOTCHES.length;
    const at = (i: number) => ((i + 0.5) / n) * 100;
    this.stateText = document.createElement("div");
    this.stateText.className = "state";
    this.track = document.createElement("div");
    this.track.className = "track";
    // 色の帯: ブレーキ（赤）・そのまま（灰）・すすむ（緑）
    const firstPower = NOTCHES.findIndex((x) => x.kind === "power");
    this.track.style.setProperty("--brake-end", `${(NEUTRAL / n) * 100}%`);
    this.track.style.setProperty("--power-start", `${(firstPower / n) * 100}%`);
    NOTCHES.forEach((_, i) => {
      const tick = document.createElement("i");
      tick.className = "tick";
      tick.style.left = `${at(i)}%`;
      this.track.append(tick);
    });
    this.knob = document.createElement("div");
    this.knob.className = "knob";
    this.knob.setAttribute("role", "slider");
    this.knob.setAttribute("aria-label", "マスコン");
    this.knob.setAttribute("aria-valuemin", "0");
    this.knob.setAttribute("aria-valuemax", String(n - 1));
    this.track.append(this.knob);
    const ends = document.createElement("div");
    ends.className = "ends";
    for (const [cls, text] of [
      ["stop", "◀ とまる"],
      ["keep", "そのまま"],
      ["go", "すすむ ▶"],
    ]) {
      const span = document.createElement("span");
      span.className = cls!;
      span.textContent = text!;
      ends.append(span);
    }
    ends.style.setProperty("--keep-at", `${at(NEUTRAL)}%`);
    host.append(this.stateText, this.track, ends);

    // 押した場所・なぞった場所の一番近い段へ
    let dragging = false;
    const pick = (e: PointerEvent) => {
      const r = this.track.getBoundingClientRect();
      const t = (e.clientX - r.left) / Math.max(r.width, 1);
      this.set(Math.round(t * n - 0.5), true);
    };
    this.track.addEventListener("pointerdown", (e) => {
      dragging = true;
      try {
        this.track.setPointerCapture(e.pointerId);
      } catch {
        // 指が離れた直後などは掴めない。掴めなくても段は選べる
      }
      this.track.classList.add("grab");
      pick(e);
    });
    this.track.addEventListener("pointermove", (e) => dragging && pick(e));
    const end = () => {
      dragging = false;
      this.track.classList.remove("grab");
    };
    this.track.addEventListener("pointerup", end);
    this.track.addEventListener("pointercancel", end);
    this.paint();
  }

  get value() {
    return this.index;
  }

  get notch() {
    return NOTCHES[this.index]!;
  }

  set(i: number, fromUser = false) {
    const next = Math.min(Math.max(i, 0), NOTCHES.length - 1);
    if (next === this.index) return;
    this.index = next;
    this.paint();
    if (fromUser) this.onChange(next);
  }

  private paint() {
    const n = NOTCHES.length;
    const notch = this.notch;
    this.knob.style.left = `${((this.index + 0.5) / n) * 100}%`;
    this.knob.dataset.kind = notch.kind;
    this.knob.setAttribute("aria-valuenow", String(this.index));
    this.knob.setAttribute("aria-valuetext", STATE[notch.id] ?? notch.label);
    this.stateText.textContent = STATE[notch.id] ?? notch.label;
    this.stateText.dataset.kind = notch.kind;
  }
}

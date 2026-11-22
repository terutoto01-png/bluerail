// 左下のミニマップ「コース全体」。真上から見た線路の中心線と、電車・開いた端を描く
import type { Catalog } from "./catalog";
import type { PieceSave } from "./course";
import type { Route } from "./route";
import { samplePath, toWorld } from "./track";
import type { OpenPort } from "./place";

const SIZE = 150;
const PAD = 16;
const LINE = "#2f7fe0";

export interface Line {
  /** 中心線を刻んだ点（Unity の座標 x, z） */
  pts: [number, number][];
}

export class Minimap {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private lines: Line[] = [];
  private bounds = { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };
  private signature = "";

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const dpr = Math.min(devicePixelRatio, 2);
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    canvas.style.width = `${SIZE}px`;
    canvas.style.height = `${SIZE}px`;
    this.ctx = canvas.getContext("2d")!;
    this.ctx.scale(dpr, dpr);
  }

  /** 部品が変わったときだけ中心線を刻み直す */
  private rebuild(catalog: Catalog, pieces: PieceSave[]) {
    ({ lines: this.lines, bounds: this.bounds } = traceCourse(catalog, pieces));
  }

  /** 毎フレーム呼んでよい。部品が変わっていなければ線は刻み直さない */
  draw(
    catalog: Catalog,
    pieces: PieceSave[],
    route: Route | null,
    trainS: number | null,
    open: OpenPort[],
    selected: OpenPort | null,
  ) {
    const sig = pieces.map((p) => `${p.kind}${p.position.x.toFixed(2)}${p.position.z.toFixed(2)}${p.euler.y.toFixed(0)}`).join("|");
    if (sig !== this.signature) {
      this.signature = sig;
      this.rebuild(catalog, pieces);
    }
    const { minX, maxX, minZ, maxZ } = this.bounds;
    const w = Math.max(maxX - minX, 6);
    const d = Math.max(maxZ - minZ, 6);
    const s = (SIZE - PAD * 2) / Math.max(w, d);
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    // 右が +x、上が +z（既定のカメラから見た向きと同じ）
    const sx = (x: number) => SIZE / 2 + (x - cx) * s;
    const sy = (z: number) => SIZE / 2 - (z - cz) * s;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 3;
    for (const line of this.lines) {
      ctx.beginPath();
      line.pts.forEach(([x, z], i) => (i ? ctx.lineTo(sx(x), sy(z)) : ctx.moveTo(sx(x), sy(z))));
      ctx.stroke();
    }
    // 開いた端。選んでいる端は黄色
    for (const o of open) {
      ctx.beginPath();
      ctx.arc(sx(o.pos[0]), sy(o.pos[2]), o === selected ? 4 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = o === selected ? "#ffd23f" : "#ffffff";
      ctx.fill();
      ctx.strokeStyle = "#8a8a80";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // 電車（先頭の位置と向き）
    if (route && trainS !== null && route.points.length) {
      const p = route.at(trainS);
      const x = sx(p.x);
      const y = sy(p.z);
      // 進む向き θ は (x, z) で (sinθ, -cosθ)。画面では z が上向きなので、画面上の向きは (sinθ, cosθ)。
      // 先が上（0, -1）の三角形をその向きへ回す角度は π - θ（canvas の回転は時計回りが正）
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.PI - p.heading);
      ctx.beginPath();
      ctx.moveTo(0, -6);
      ctx.lineTo(4.5, 5);
      ctx.lineTo(-4.5, 5);
      ctx.closePath();
      ctx.fillStyle = "#ffd23f";
      ctx.fill();
      ctx.strokeStyle = "#273a35";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();
    }
  }
}

/** 真上から見た線路の中心線（車線は除く）と、その範囲 */
export function traceCourse(catalog: Catalog, pieces: PieceSave[]) {
  const lines: Line[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const piece of pieces) {
    const def = catalog.of(piece);
    if (!def) continue;
    for (const path of def.paths) {
      if (path.lane || (path as { frames?: unknown }).frames) continue; // 車線は中央の道と重なる
      const pts: [number, number][] = [];
      for (const q of samplePath(def, path, 0.6)) {
        const [x, , z] = toWorld(piece, [q.x, q.y, q.z]);
        pts.push([x, z]);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
      lines.push({ pts });
    }
  }
  const bounds = minX === Infinity ? { minX: -10, maxX: 10, minZ: -10, maxZ: 10 } : { minX, maxX, minZ, maxZ };
  return { lines, bounds };
}

/** コースの小さな見取り図を canvas へ描く（コース選びのカード用）。向きはミニマップと同じ */
export function drawCourseThumb(canvas: HTMLCanvasElement, catalog: Catalog, pieces: PieceSave[], w: number, h: number) {
  const dpr = Math.min(devicePixelRatio, 2);
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const { lines, bounds } = traceCourse(catalog, pieces);
  const pad = 10;
  const bw = Math.max(bounds.maxX - bounds.minX, 6);
  const bd = Math.max(bounds.maxZ - bounds.minZ, 6);
  const s = Math.min((w - pad * 2) / bw, (h - pad * 2) / bd);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 2.5;
  for (const line of lines) {
    ctx.beginPath();
    line.pts.forEach(([x, z], i) => {
      const px = w / 2 + (x - cx) * s;
      const py = h / 2 - (z - cz) * s;
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    });
    ctx.stroke();
  }
}

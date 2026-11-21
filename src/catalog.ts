// 部品カタログ。部品はデータ（json）で、ここに種類の一覧は持たない
import { deriveFlex } from "./flex";

export type Vec3 = [number, number, number];

export interface PortDef {
  id: string;
  face: string;
  position: Vec3;
  euler: Vec3;
}

export interface SegmentDef {
  length: number;
  turn: number;
  radius?: number;
  run?: number;
}

export interface PathDef {
  id: string;
  from: string;
  to: string;
  lane?: string;
  laneTo?: string;
  segments: SegmentDef[];
}

export interface RailDef {
  id: string;
  label: string;
  categories: string[];
  order: number;
  model: string;
  mirror?: string;
  flip?: string;
  action?: string;
  /** 成形された坂。高さが S字（両端の継ぎ目で水平）で変わる */
  climbs?: boolean;
  /** 屋根の上面の高さ（地下直線）。その上に座る継ぎ目は函が支えるので、橋脚を立てない */
  deck?: number;
  /** この部品が名乗る装飾（架線柱など）。継ぎ目に立つ */
  decorations?: string[];
  ports: PortDef[];
  paths: PathDef[];
}

/** 部品の一覧。まがレールは1本ごとに形が違うので、置いた部品の定義は `of` で引く */
export class Catalog extends Map<string, RailDef> {
  of(piece: { kind: string; state: string }): RailDef | undefined {
    const def = this.get(piece.kind);
    if (def?.action === "flex" && piece.state) return deriveFlex(def, piece.state) ?? def;
    return def;
  }
}

export async function loadCatalog(base: string): Promise<Catalog> {
  const ids: string[] = await (await fetch(`${base}data/rails.json`)).json();
  const defs = await Promise.all(
    ids.map(async (id) => (await (await fetch(`${base}data/Rails/${id}/${id}.json`)).json()) as RailDef),
  );
  return new Catalog(defs.map((d) => [d.id, d]));
}

/** json の model（"Rails/Left/Track_Curve_Left_45"）が指す FBX の URL */
export function modelUrl(base: string, def: RailDef): string {
  return `${base}data/${def.model}.fbx`;
}

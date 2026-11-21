// コースの保存形式（Unity の CourseExports と同じ）
import type { Vec3 } from "./catalog";
import type { PropSave } from "./props";

export interface PieceSave {
  kind: string;
  position: { x: number; y: number; z: number };
  euler: { x: number; y: number; z: number };
  state: string;
  lift: number;
  liftFrom: string;
  branchSet: boolean;
  autoFlip: boolean;
  /** 人がかぶせた装飾（トンネル・鉄橋）。無ければ付けていない */
  decorations?: string[];
}

export interface CourseSave {
  version: number;
  closedLoop?: boolean;
  pieces: PieceSave[];
  trains?: unknown[];
  /** マットに置いた町なみ（ビル・木など） */
  props?: PropSave[];
}

export async function loadCourse(base: string, name: string): Promise<CourseSave> {
  return (await fetch(`${base}data/Courses/${encodeURIComponent(name)}.json`)).json();
}

export const vec = (v: { x: number; y: number; z: number }): Vec3 => [v.x, v.y, v.z];

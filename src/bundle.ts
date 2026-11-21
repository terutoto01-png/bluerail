// 起動時に1回の HTTP 通信で読み込むメタデータ束（scripts/build-bundle.mjs が生成）
import type { RailDef } from "./catalog";
import type { CourseSave } from "./course";
import type { WornDef } from "./decorWorn";
import type { PropDef } from "./props";
import type { TrainDef } from "./train";

export interface DataBundle {
  rails: RailDef[];
  trains: TrainDef[];
  scenery: (PropDef & Partial<WornDef>)[];
  courses: string[];
  initialCourseName: string | null;
  initialCourse: CourseSave | null;
}

export async function loadBundle(base: string): Promise<DataBundle> {
  return (await fetch(`${base}data/bundle.json`)).json() as Promise<DataBundle>;
}

// 作ったコースの保存。ブラウザの localStorage と、.json ファイルの書き出し・読み込み
import type { Catalog } from "./catalog";
import type { CourseSave } from "./course";

const KEY = "bluerail.courses";

function readAll(): Record<string, CourseSave> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, CourseSave>;
  } catch {
    return {};
  }
}

export const savedNames = (): string[] => Object.keys(readAll());

export const loadSaved = (name: string): CourseSave | null => readAll()[name] ?? null;

/** 保存できなければ false（容量超過・保存の禁止）。呼び手が知らせる */
export function saveCourse(name: string, course: CourseSave): boolean {
  try {
    const all = readAll();
    all[name] = course;
    localStorage.setItem(KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

/** 読み込んだ文字列を検めてコースにする。壊れていれば理由を返す */
export function parseCourse(text: string, catalog: Catalog): CourseSave | string {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return "json として読めません";
  }
  const pieces = (data as CourseSave | null)?.pieces;
  if (!Array.isArray(pieces) || !pieces.length) return "部品が入っていません";
  const unknown = pieces.find((p) => !catalog.has(p?.kind));
  if (unknown) return `知らない部品があります（${String(unknown.kind)}）`;
  return data as CourseSave;
}

/** ブラウザのダウンロードへ書き出す */
export function downloadCourse(name: string, course: CourseSave) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(course, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

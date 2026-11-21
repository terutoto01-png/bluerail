// public/data/ の JSON 群（Rails / Trains / Scenery / Courses 一覧 + 初期コース）を
// 起動時の1通信で読める public/data/bundle.json へまとめる
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "public", "data");

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

const railIds = readJson(path.join(dataDir, "rails.json"));
const rails = railIds.map((id) => readJson(path.join(dataDir, "Rails", id, `${id}.json`)));

const trainIds = readJson(path.join(dataDir, "trains.json"));
const trains = trainIds.map((id) => readJson(path.join(dataDir, "Trains", id, `${id}.json`)));

const sceneryIds = readJson(path.join(dataDir, "scenery.json"));
const scenery = sceneryIds.map((id) => readJson(path.join(dataDir, "Scenery", id, `${id}.json`)));

const courses = readJson(path.join(dataDir, "courses.json"));
const initialCourseName = courses.includes("定番レイアウト1") ? "定番レイアウト1" : courses[0];
const initialCourse = initialCourseName
  ? readJson(path.join(dataDir, "Courses", `${initialCourseName}.json`))
  : null;

const bundle = { rails, trains, scenery, courses, initialCourseName, initialCourse };
const outPath = path.join(dataDir, "bundle.json");
const json = JSON.stringify(bundle);
fs.writeFileSync(outPath, json, "utf8");
console.log(
  `bundle.json: rails=${rails.length}, trains=${trains.length}, scenery=${scenery.length}, courses=${courses.length} (${(
    Buffer.byteLength(json) / 1024
  ).toFixed(1)} KB)`,
);

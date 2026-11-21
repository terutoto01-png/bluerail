import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Catalog, modelUrl } from "./catalog";
import { loadBundle } from "./bundle";
import { loadCourse, type CourseSave, type PieceSave } from "./course";
import { checkCatalog, looseJoints, portHeading, samplePath, toWorld } from "./track";
import { flexPlacement, limitsOf } from "./flex";
import { buildRoute, type Route } from "./route";
import { cycle, junctionsOf, readState, writeState } from "./points";
import { loadTrainDef, seedTrainDefs, Train } from "./train";
import { CameraRig, type CameraMode } from "./cameras";
import { freePlacement, isUpstream, openPorts, placementsAt, type OpenPort } from "./place";
import {
  applyPlanToPieces,
  branchVariants,
  pickRandomTrainId,
  planAutoClose,
  planAutoTrainSpawn,
  planBranchAndMerge,
  planBranchToPoint,
  planMatTap,
  planMergeIntoPiece,
  planToPort,
  type BranchVariant,
  type EasyPlan,
} from "./easy";
import { findOverlaps, type Hit } from "./overlap";
import { downloadCourse, loadSaved, parseCourse, saveCourse, savedNames } from "./storage";
import { Shelf } from "./shelf";
import { createThumbnailer } from "./thumbs";
import { buildScenery, setSharedEnvironment, toStandard, type Scenery } from "./scenery";
import { buildSupports, loadPierModels } from "./supports";
import { Minimap } from "./minimap";
import { PropsLayer } from "./propsLayer";
import { buildDecorations } from "./decor";
import { buildWorn, centrePath, loadWorn, seedWornDefs, wearable } from "./decorWorn";
import { buildProp, type PropSave } from "./props";

const base = import.meta.env.BASE_URL;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const renderer = new THREE.WebGLRenderer({ antialias: true });
// 指で触る端末（スマホ・タブレット）は、描く画素と影を軽くする
const coarse = matchMedia("(pointer: coarse)").matches;
renderer.setPixelRatio(Math.min(devicePixelRatio, coarse ? 1.5 : 2));
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xd6bd98);
// near が小さいほど奥行きの精度が落ち、近い面どうし（床とマットなど）がちらつく。運転席でも車体の中までは寄らない値
const camera = new THREE.PerspectiveCamera(48, 1, 0.25, 2000);
camera.position.set(0, 18, -18);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
// PC: 左ドラッグで移動 / 右ドラッグで回転 / ホイールでズーム
// スマホ・iPad（案 A）: 1本指で回転 / 2本指でズーム＆平行移動
controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.rotateSpeed = coarse ? 0.75 : 1.0;
controls.screenSpacePanning = false;
// Unity 版の制限: 距離 10〜42（広い板を出すときは 60）、俯角 10〜83°。極端に引いて家の外を見せない
controls.minDistance = 10;
controls.maxDistance = 60;
controls.minPolarAngle = THREE.MathUtils.degToRad(90 - 83);
controls.maxPolarAngle = THREE.MathUtils.degToRad(90 - 10);
const rig = new CameraRig(camera, controls);

renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
let scenery: Scenery;

// Unity は左手系。データは Unity の座標のまま持ち、描くときだけ x を反転する
const world = new THREE.Group();
world.scale.x = -1;
scene.add(world);

const fbx = new FBXLoader();
const models = new Map<string, Promise<THREE.Group>>();
const modelBounds = new Map<string, THREE.Box3>();
function loadModel(kind: string): Promise<THREE.Group> {
  let p = models.get(kind);
  if (!p) {
    const def = catalog.get(kind);
    if (!def) throw new Error(`未知の部品: ${kind}`);
    // レールは塗装プラスチック。艶は Unity 版と同じ（smoothness 0.34 → roughness 0.66）。影を落とし、受ける
    p = fbx.loadAsync(modelUrl(base, def)).then((g) => {
      g.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.material = Array.isArray(o.material) ? o.material.map((m) => toStandard(m, 0.66)) : toStandard(o.material, 0.66);
        o.castShadow = o.receiveShadow = true;
      });
      // 外形を Unity の局所座標（FBX は cm・右手系なので x を反転）で覚える。函の屋根の判定に使う
      const b = new THREE.Box3().setFromObject(g);
      modelBounds.set(
        kind,
        new THREE.Box3(new THREE.Vector3(-b.max.x * 0.01, b.min.y * 0.01, b.min.z * 0.01), new THREE.Vector3(-b.min.x * 0.01, b.max.y * 0.01, b.max.z * 0.01)),
      );
      return g;
    });
    models.set(kind, p);
  }
  return p;
}

// --- 状態 ---
let catalog: Catalog;
let shelf: Shelf;
let course: CourseSave | null = null;
let route: Route | null = null;
let train: Train | null = null;
let mode: "build" | "drive" = "build";
let running = true;
let speed = 0;
/** 部品の描画グループ。userData.index が course.pieces の番号 */
let pieceGroups: THREE.Group[] = [];
/** 分岐レールの状態表示（直進＝緑 / 分岐＝橙） */
/** 分岐のレバーの印。キーは「部品の番号:腕の番号」 */
const markers = new Map<string, THREE.Mesh>();

// 配置
let buildStyle: "easy" | "parts" = "easy";
let easyLevel = 0;
let easyPlans: EasyPlan[] = [];
let easyPlanIdx = 0;
let easyStartAim: [number, number] | null = null;
let easyBranchSource: number | null = null;
let easyBranchHints: BranchVariant[] = [];
let easyGhostGroup: THREE.Group | null = null;
let easyGhostGeneration = 0;
let hiddenByEasyGhost: number[] = [];

let selectedKind: string | null = null;
let placementIdx = 0;
// 自由配置（端を選ばずにマットへ置く）。狙いの点・進む向き（45°刻み）・階層
let freeAim: [number, number] | null = null;
let freeTheta = 0;
let freeLevel = 0;
const LEVEL_HEIGHT = 1.6667;
/** 磁石が働く距離。格子（1.5）と複線の間隔（1.6667）のどちらより小さい */
const MAGNET = 1.2;
let open: OpenPort[] = [];
let selectedEnd: OpenPort | null = null;
const propsLayer = new PropsLayer();
world.add(propsLayer.group);
const endGroup = new THREE.Group();
world.add(endGroup);
const branchHintGroup = new THREE.Group();
world.add(branchHintGroup);
let ghost: THREE.Group | null = null;
let ghostPiece: PieceSave | null = null;
let ghostHits: Hit[] = [];
/** 戻す。編集の前の部品を丸ごと覚える */
let undoStack: string[] = [];

// 検証用。開発中の操作をコンソールから行う
(window as unknown as { __app: unknown }).__app = {
  camera,
  controls,
  get train() {
    return train;
  },
  get route() {
    return route;
  },
  get course() {
    return course;
  },
  get open() {
    return open;
  },
  get selectedEnd() {
    return selectedEnd;
  },
  /** 既存コースの全部品を1つずつ外して置き直し、誤って断らないかを数える */
  audit: () => {
    const pieces = course!.pieces;
    return pieces.flatMap((p, i) => {
      const rest = pieces.filter((_, j) => j !== i);
      return findOverlaps(catalog, rest, p, openPorts(catalog, rest), railHalfWidth()).map((h) => ({ i, part: p.kind, ...h }));
    });
  },
  /** 列車の位置に縛られずに、いまの状態でルートを組み直した結果 */
  freshRoute: (lane = runLane) => buildRoute(catalog, course!.pieces, undefined, undefined, undefined, lane),
  /** 任意の姿勢の部品が置けるかを調べる */
  probe: (kind: string, x: number, y: number, z: number, yaw: number) =>
    findOverlaps(
      catalog,
      course!.pieces,
      { kind, position: { x, y, z }, euler: { x: 0, y: yaw, z: 0 }, state: "", lift: 0, liftFrom: "", branchSet: false, autoFlip: false },
      open,
      railHalfWidth(),
    ),
  selectPiece: (i: number | null) => selectPiece(i),
  deletePiece: () => deletePiece(),
  replacePiece: (kind: string) => replacePiece(kind),
  get selectedPiece() {
    return selectedPiece;
  },
  aim: (x: number, z: number) => aimFree(new THREE.Vector3(x, 0, z)),
  turn: (n: number) => turnFree(n),
  get freeAim() {
    return freeAim;
  },
  scene,
  renderer,
  props: propsLayer,
  holdProp: (id: string | null) => holdProp(id),
  confirmProp: () => confirmProp(),
  get extras() {
    return extras;
  },
  get ghostHits() {
    return ghostHits;
  },
  get supports() {
    return supportsGroup;
  },
  get scenery() {
    return scenery;
  },
  markers,
  toggle: (i: number, arm = 0) => toggleSwitch(i, arm),
  tick,
  selectKind: (k: string | null) => selectKind(k),
  selectEnd: (i: number | null) => selectEnd(i === null ? null : open[i]!),
  place: () => confirmPlace(),
  undo: () => undo(),
  setMode: (m: "build" | "drive") => setMode(m),
  get buildStyle() {
    return buildStyle;
  },
  setBuildStyle: (s: "easy" | "parts") => setBuildStyle(s),
  get easyLevel() {
    return easyLevel;
  },
  get easyPlans() {
    return easyPlans;
  },
  get easyBranchSource() {
    return easyBranchSource;
  },
  confirmEasyPlan: () => confirmEasyPlan(),
  easyAutoClose: () => triggerEasyAutoClose(),
  autoAddRandomTrain: () => autoAddRandomTrain(),
};

function resize() {
  const w = window.visualViewport?.width ?? innerWidth;
  const h = window.visualViewport?.height ?? innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
window.visualViewport?.addEventListener("resize", resize);
resize();

const clock = new THREE.Clock();
/** 1コマぶんの更新。描画から切り離してあるので、固定の刻みで回して検証できる */
function tick(dt: number) {
  if (!route || !train) return;
  // 前に別の編成が居るなら止まる。目標の速さは全編成で同じ
  // 目標の速さは編成ごと。見ている編成だけ、画面の操作が効く
  const all = [
    { train, route, lane: runLane, want: mode === "drive" && running ? speed : 0 },
    ...extras.map((r) => ({ train: r.train, route: r.route, lane: r.lane, want: mode === "drive" && r.running ? r.speed : 0 })),
  ];
  const blocked = blockedRuns(all);
  all.forEach((r, i) => (r.train.target = blocked[i] ? 0 : r.want));
  stepRun(dt);
  for (const run of extras) withRun(run, () => stepRun(dt));
  if (needAll) {
    needAll = false;
    rebuildAll();
  }
}

function stepRun(dt: number) {
  if (!route || !train) return;
  // 電車より短い線には乗らない。重なって見えるより、出さないほうがよい
  train.root.visible = route.length + 0.01 >= train.length;
  train.update(route, dt);
  flipAutoPoints(route, train);
  // 列車の尻が次の区間へ移るたびに組み直す。列車の先は、いつも「いまの分岐の状態」で組まれている
  if (tailSegOf(route) !== lastTailSeg) rebuildRoute();
}

renderer.setAnimationLoop(() => {
  tick(Math.min(clock.getDelta(), 0.1));
  scene.updateMatrixWorld();
  if (rig.mode === "free") {
    controls.update();
    clampFocus();
  } else {
    rig.update(route, train);
  }
  updateHud(performance.now());
  renderer.render(scene, camera);
});

let minimap: Minimap | null = null;
let minimapAt = 0;

/** ミニマップと案内（部品を選ぶ促し）を更新する。ミニマップは 10 回/秒で足りる */
function updateHud(now: number) {
  if (minimap && course && now - minimapAt > 100) {
    minimapAt = now;
    minimap.draw(catalog, course.pieces, route, train ? train.s : null, open, selectedEnd);
  }
  const prompt = $("prompt");
  const isEasy = mode === "build" && buildStyle === "easy";
  const hasEasyPlan = isEasy && easyPlans.length > 0 && !!easyGhostGroup;
  const hasGhostRail = mode === "build" && !isEasy && !!ghost && !!ghostPiece;
  const hasGhostProp = mode === "build" && !isEasy && !!propsLayer.kind && !!propsLayer.aimAt;
  const hasGhostTrain = mode === "build" && !!trainGhost;
  const isFreeHand = mode === "build" && !isEasy && !!selectedKind && !selectedEnd;
  const hasAction =
    mode === "build" &&
    (hasEasyPlan || hasGhostRail || hasGhostProp || hasGhostTrain || !!trainHand || isFreeHand || (!isEasy && (!!propsLayer.kind || propsLayer.picked !== null)));
  document.body.classList.toggle("has-action", hasAction);
  document.body.classList.toggle("free-hand", isFreeHand);

  const confirmBtn = $("placeConfirm") as HTMLButtonElement;
  const rotateBtn = $("placeRotate") as HTMLButtonElement;
  if (hasEasyPlan) {
    const plan = easyPlans[easyPlanIdx]!;
    confirmBtn.style.display = "inline-flex";
    confirmBtn.disabled = false;
    confirmBtn.classList.remove("blocked");
    confirmBtn.textContent = `✓ ${plan.summary}`;
    const canCycle = easyPlans.length > 1 || plan.kind === "start";
    rotateBtn.style.display = canCycle ? "inline-flex" : "none";
    rotateBtn.textContent = plan.kind === "start" ? "↻ 向き" : `↻ 別の案 (${easyPlanIdx + 1}/${easyPlans.length})`;
  } else if (hasGhostRail) {
    confirmBtn.style.display = "inline-flex";
    confirmBtn.disabled = false;
    confirmBtn.classList.toggle("blocked", ghostHits.length > 0);
    confirmBtn.textContent = ghostHits.length ? "⚠ ここには置けません" : "✓ ここに置く";
    rotateBtn.style.display = "inline-flex";
    rotateBtn.textContent = "↻ 向き";
  } else if (hasGhostProp) {
    confirmBtn.style.display = "inline-flex";
    confirmBtn.disabled = false;
    confirmBtn.classList.remove("blocked");
    confirmBtn.textContent = "✓ ここに置く";
    rotateBtn.style.display = "inline-flex";
    rotateBtn.textContent = "↻ 向き";
  } else if (hasGhostTrain) {
    confirmBtn.style.display = "inline-flex";
    confirmBtn.disabled = false;
    confirmBtn.classList.toggle("blocked", !!trainGhost!.reason);
    confirmBtn.textContent = trainGhost!.reason ? "⚠ ここには置けません" : "✓ ここに置く";
    rotateBtn.style.display = "inline-flex";
    rotateBtn.textContent = "↻ 向き";
  } else {
    confirmBtn.style.display = "none";
    rotateBtn.style.display = "inline-flex";
    rotateBtn.textContent = "↻ 向き";
  }

  const verb = coarse ? "タップ" : "クリック";
  const free = isFreeHand && !freeAim;
  const prop = mode === "build" && !isEasy && !!propsLayer.kind;
  const holdingTrain = mode === "build" && !!trainHand;
  if (holdingTrain) {
    prompt.textContent = hasGhostTrain
      ? trainGhost!.reason
        ? trainGhost!.reason
        : "「ここに置く」で確定 / 「↻ 向き」で反転"
      : "電車を置きたいレールを" + verb + "してください";
    prompt.style.display = "block";
  } else if (isEasy) {
    if (hasEasyPlan) {
      prompt.textContent = "「✓」か半透明の線路を" + verb + "して確定（別の場所を" + verb + "するとやり直し）";
    } else if (easyBranchSource !== null) {
      prompt.textContent = "分岐を伸ばしたい場所（または合流したい直線）を" + verb;
    } else if (selectedPiece !== null) {
      prompt.textContent = "このレールを削除したり、電車を置けます";
    } else if (selectedEnd) {
      prompt.textContent = "伸ばしたい場所・つなぐ玉・合流したい直線を" + verb;
    } else if (open.length > 0) {
      prompt.textContent = "行きたい場所を" + verb + "すると自動でレールがつながります";
    } else {
      prompt.textContent = "直線を" + verb + "して自動分岐、またはマットを" + verb + "して新しい線路";
    }
    prompt.style.display = "block";
  } else {
    prompt.textContent = prop
      ? propsLayer.aimAt
        ? "「ここに置く」か半透明の物を" + verb + "して確定"
        : "マットを" + verb + "して置く場所を決める"
      : free
        ? "白い玉かマットを" + verb + "して置く場所を決める"
        : selectedEnd && !selectedKind
          ? "下のバーからつなぐ部品を選ぶ"
          : open.length === 0 && selectedPiece === null && !selectedKind
            ? "線路を" + verb + "して編集・分岐できます"
            : "白い玉を" + verb + "して線路をつなげる";
    prompt.style.display =
      mode === "build" &&
      ((selectedEnd && !selectedKind) || free || prop || (open.length === 0 && selectedPiece === null && !selectedKind))
        ? "block"
        : "none";
  }
}

/** 注視点を部屋の中に留める。カメラも同じだけ動かして、見ている絵を保つ。自由視点のときだけ */
function clampFocus() {
  if (!scenery || rig.mode !== "free") return;
  const t = controls.target;
  // 部屋は x を反転して置いてあるが、範囲は左右対称なのでそのまま使える
  const x = THREE.MathUtils.clamp(t.x, -scenery.limit.x, scenery.limit.x);
  const z = THREE.MathUtils.clamp(t.z, -scenery.limit.z, scenery.limit.z);
  if (x === t.x && z === t.z) return;
  camera.position.x += x - t.x;
  camera.position.z += z - t.z;
  t.x = x;
  t.z = z;
}

// --- 速度 ---
function applySpeed() {
  if (train) train.target = mode === "drive" && running ? speed : 0;
  $<HTMLButtonElement>("go").textContent = running ? "⏸" : "▶";
  $<HTMLInputElement>("speed").value = String(speed);
  $("speedText").textContent = `${speed < 0 ? "後退 " : ""}${Math.abs(speed).toFixed(1)} m/s`;
}

/** 速度は符号付き。正が前進、負が後退 */
function setSpeed(v: number) {
  const max = train?.def.maxSpeed ?? 8;
  speed = Math.min(Math.max(v, -max), max);
  if (speed !== 0) running = true;
  applySpeed();
}

// --- 列車 ---
async function showTrain(keepPosition = false) {
  const r = route;
  if (!r || !r.points.length) return;
  const prevS = keepPosition && train ? train.s : null;
  const t = await Train.create(base, await loadTrainDef(base, $<HTMLSelectElement>("train").value));
  if (route !== r) return; // 作っている間にコースが替わった
  if (train) world.remove(train.root);
  train = t;
  world.add(t.root);
  const at = (course?.trains as { at: number }[] | undefined)?.[0]?.at ?? 0;
  t.place(r, prevS !== null ? Math.min(r.length, Math.max(t.length, prevS)) : headStart(r, t, at));
  lastTailSeg = tailSegOf(r);
  $<HTMLInputElement>("speed").max = String(t.def.maxSpeed);
  $<HTMLInputElement>("speed").min = String(-t.def.maxSpeed);
  speed = t.def.presetSpeed;
  running = true;
  applySpeed();
  t.speed = 0;
  if (keepPosition) syncCourseTrains();
  updateTrainUi();
}

// --- 分岐 ---
/** 腕の色。自動は水色、固定は 道0=緑・道1=だいだい・道2=紫 */
const PICK_COLORS = [0x2ecc71, 0xff8a00, 0xb06cff, 0xff5a8a];

function paintMarker(i: number) {
  const piece = course!.pieces[i]!;
  const def = catalog.get(piece.kind);
  if (!def) return;
  const st = readState(def, piece);
  st.picks.forEach((pick, j) => {
    const m = markers.get(`${i}:${j}`);
    if (m) (m.material as THREE.MeshBasicMaterial).color.set(st.auto[j] ? 0x35c8ff : PICK_COLORS[pick % PICK_COLORS.length]!);
  });
}

/**
 * 経路を組み直す。列車は動かさない。
 * 列車の尻がある部品を起点に歩き直し、輪になれば起点を付け替える（座標が変わるので s も引く）。
 * 輪にならない（行き止まり・投げ縄）ときは、その手前を前のルートのまま残す。後退で戻れるように
 */
function rebuildRoute() {
  if (!course) return;
  const old = route;
  if (!old || !train || !old.segs.length) {
    route = buildRoute(catalog, course.pieces, runEntry, undefined, undefined, runLane);
  } else {
    train.s = old.canonicalHead(train.s, train.length);
    const tail = Math.max(0, train.s - train.length);
    const cut = old.segIndexAt(tail);
    const seg = old.segs[cut]!;
    // 列車が乗っている区間は、いま走っている道のまま組む
    const locks = new Map<string, string>();
    for (const sg of old.segsUnder(tail, train.s)) locks.set(`${sg.piece}:${sg.entry}`, sg.path);
    const fresh = buildRoute(catalog, course.pieces, { piece: seg.piece, port: seg.entry }, undefined, locks, seg.lane);
    if (fresh.closed && fresh.loopStart === 0) {
      route = fresh;
      train.place(route, train.s - seg.s);
    } else {
      route = buildRoute(catalog, course.pieces, undefined, { route: old, seg: cut }, locks);
      train.place(route, train.s);
    }
  }
  if (route.notes.length) console.warn("ルート", route.notes);
  lastTailSeg = tailSegOf(route);
  showInfo();
}

let lastTailSeg = -1;
function tailSegOf(r: Route): number {
  if (!train) return -1;
  return r.segIndexAt(Math.max(0, r.canonicalHead(train.s, train.length) - train.length));
}

function showInfo() {
  if (!course || !route) return;
  const loose = looseJoints(catalog, course.pieces);
  if (loose.length) console.warn(`継ぎ目のずれ ${loose.length} 件`, loose);
  const kind = route.closed ? (route.loopStart > 0 ? `${route.loopStart.toFixed(0)}m から周回` : "周回") : "開";
  $("info").textContent =
    `${course.pieces.length} 個 / ルート ${route.length.toFixed(1)}m（${kind}）` + (loose.length ? ` / ⚠継ぎ目のずれ ${loose.length}` : "");
}

/** 分岐のレバー（腕 arm）。自動 → 道0（固定）→ 道1 … → 自動（Unity §6.1.1） */
function toggleSwitch(i: number, arm = 0) {
  const piece = course?.pieces[i];
  const def = piece && catalog.get(piece.kind);
  const junction = def && junctionsOf(def)[arm];
  if (!piece || !def || !junction) return;
  const st = readState(def, piece);
  cycle(st, arm, junction.count);
  writeState(piece, st);
  paintMarker(i);
  rebuildAll();
}

/** 置いたばかりの分岐は自動（Unity の既定） */
function withDefaultState(piece: PieceSave): PieceSave {
  const def = catalog.get(piece.kind);
  if (def) {
    const st = readState(def, piece);
    st.auto.fill(true);
    writeState(piece, st);
  }
  return piece;
}

// --- 複数の編成 ---
// 1本目は大域の train / route / lastTailSeg / occupied / runEntry が持つ。2本目以降は Run に入れ、
// withRun で大域へ差し込んで同じ関数（rebuildRoute など）を使う。差し込みは入れ子にしないこと
interface Run {
  train: Train;
  route: Route;
  lastTailSeg: number;
  occupied: Set<string>;
  /** この編成のルートの始点（部品の番号と口）。1本目は既定の始点 */
  entry: { piece: number; port: string } | undefined;
  /** この編成が走る車線（進行方向で見た左右。"" は中央） */
  lane: string;
  /** 画面の操作（速さ・走る止まる）が、この編成を見ていないあいだ持っておく値 */
  speed: number;
  running: boolean;
}
let extras: Run[] = [];
let runEntry: Run["entry"];
let runLane = "";
/** 自動転換が起きた。ほかの編成の先も組み直す */
let needAll = false;

function withRun(run: Run, fn: () => void) {
  const saved = { train, route, lastTailSeg, occupied, runEntry, runLane, speed, running };
  speed = run.speed;
  running = run.running;
  train = run.train;
  route = run.route;
  lastTailSeg = run.lastTailSeg;
  occupied = run.occupied;
  runEntry = run.entry;
  runLane = run.lane;
  try {
    fn();
  } finally {
    run.train = train!;
    run.route = route!;
    run.lastTailSeg = lastTailSeg;
    run.occupied = occupied;
    run.entry = runEntry;
    run.lane = runLane;
    run.speed = speed;
    run.running = running;
    ({ train, route, lastTailSeg, occupied, runEntry, runLane, speed, running } = saved);
  }
}

/** 編成数とボタン表示を現在の状態に合わせる */
function updateTrainUi() {
  const total = (train ? 1 : 0) + extras.length;
  const hasMulti = total > 1;
  const trainLabel = document.getElementById("trainLabel");
  if (trainLabel) trainLabel.textContent = hasMulti ? `見ている電車（全 ${total} 編成）` : "電車（1編成）";
  const nextBtn = $("nextTrain");
  nextBtn.style.display = hasMulti ? "" : "none";
  nextBtn.innerHTML = `次の編成 (${total})<span class="key"> [N]</span>`;
  ($("menuNextTrain") as HTMLButtonElement).disabled = !hasMulti;
  ($("removeTrain") as HTMLButtonElement).disabled = !hasMulti;
}

/** コース保存データの trains 配列を、現在の全編成（実際の路線・位置）と同期する */
function syncCourseTrains() {
  if (!course || !train || !route) return;
  const entryOf = (t: Train, r: Route, e: Run["entry"], lane: string) => {
    const seg0 = r.segs[0];
    return {
      train: t.def.id,
      at: Math.max(0, Math.round((r.canonicalHead(t.s, t.length) - t.length) * 10) / 10),
      port: seg0?.entry ?? e?.port ?? "Start",
      piece: seg0?.piece ?? e?.piece,
      lane,
    };
  };
  course.trains = [
    entryOf(train, route, runEntry, runLane),
    ...extras.map((x) => entryOf(x.train, x.route, x.entry, x.lane)),
  ];
}

// --- 好きなレール位置へ電車を置く（追加・移動） ---
let trainHand: { kind: string; mode: "add" | "move" } | null = null;
let trainAim: { piece: number; candIdx: number } | null = null;
let trainGhost: {
  train: Train;
  route: Route;
  headS: number;
  entry: { piece: number; port: string };
  reason: string | null;
} | null = null;
let trainGhostGeneration = 0;

function clearTrainGhost() {
  trainGhostGeneration++;
  if (trainGhost) world.remove(trainGhost.train.root);
  trainGhost = null;
}

/** 電車を持った状態に入る（null で解除）。好きなレールをタップして配置・移動できる */
function holdTrain(kind: string | null, handMode: "add" | "move" = "add") {
  clearTrainGhost();
  trainAim = null;
  if (!kind) {
    trainHand = null;
    updateHud(performance.now());
    return;
  }
  if (mode !== "build") setMode("build");
  closePopups();
  setShelfOpen(false);
  selectedKind = null;
  shelf?.select(null);
  freeAim = null;
  clearEasyPlan();
  easyBranchSource = null;
  refreshBranchHints();
  selectEnd(null);
  if (selectedPiece !== null) selectPiece(selectedPiece);
  if (propsLayer.kind || propsLayer.picked !== null) {
    propsLayer.clearHand();
    shelf?.redraw();
  }
  void updateGhost();
  refreshQuickBar();
  trainHand = { kind, mode: handMode };
  updateEasyUi();
  updateHud(performance.now());
}

/** 仮置き電車が既存の他の編成と重なるか */
function overlapsOtherTrains(r: Route, headS: number, trainLength: number, ignoreActive: boolean): boolean {
  const others = [
    ...(!ignoreActive && train && route ? [{ t: train, r: route }] : []),
    ...extras.map((x) => ({ t: x.train, r: x.route })),
  ];
  if (!others.length) return false;
  const pts: { x: number; y: number; z: number }[] = [];
  for (let s = headS - trainLength; s <= headS + 0.01; s += 1.0) pts.push(r.at(s));
  for (const o of others) {
    for (let s = o.t.s - o.t.length; s <= o.t.s + 0.01; s += 1.0) {
      const q = o.r.at(s);
      for (const p of pts) {
        if (Math.abs(p.y - q.y) < 1.0 && Math.hypot(p.x - q.x, p.z - q.z) < 1.8) return true;
      }
    }
  }
  return false;
}

/** タップしたレール pieceIdx を始点にした配置候補（順方向・逆方向）のゴーストを描く */
async function updateTrainGhost() {
  const gen = ++trainGhostGeneration;
  if (mode !== "build" || !course || !trainHand || !trainAim) {
    if (trainGhost) world.remove(trainGhost.train.root);
    trainGhost = null;
    return;
  }
  const piece = course.pieces[trainAim.piece];
  const def = piece && catalog.of(piece);
  if (!piece || !def) return;

  const t = await Train.create(base, await loadTrainDef(base, trainHand.kind));
  if (gen !== trainGhostGeneration) return;

  // その部品の口ごとにルートを組み、向き（先頭の進行方向）の違う候補を並べる
  const allCands: { entry: { piece: number; port: string }; route: Route }[] = [];
  const seenDir: number[] = [];
  for (const port of def.ports) {
    const r = buildRoute(catalog, course.pieces, { piece: trainAim.piece, port: port.id }, undefined, undefined, runLane);
    if (!r.points.length) continue;
    const h0 = r.at(0).heading;
    if (seenDir.some((h) => Math.abs(Math.atan2(Math.sin(h - h0), Math.cos(h - h0))) < 0.25)) continue;
    seenDir.push(h0);
    allCands.push({ entry: { piece: trainAim.piece, port: port.id }, route: r });
  }
  const usable = allCands.filter((c) => c.route.length + 0.01 >= t.length);
  const pool = usable.length ? usable : allCands;
  if (!pool.length) {
    toast("このレールには電車を置けません");
    return;
  }
  const picked = pool[((trainAim.candIdx % pool.length) + pool.length) % pool.length]!;
  const headS = Math.min(picked.route.length, t.length);
  let reason: string | null = null;
  if (picked.route.length + 0.01 < t.length) reason = "この線路は電車より短いので置けません";
  else if (overlapsOtherTrains(picked.route, headS, t.length, trainHand.mode === "move")) reason = "ほかの電車と重なるので置けません";

  t.place(picked.route, headS);
  const gMat = reason ? ghostBadMaterial : ghostMaterial;
  t.root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.material = gMat;
      o.castShadow = false;
    }
  });
  if (trainGhost) world.remove(trainGhost.train.root);
  trainGhost = { train: t, route: picked.route, headS, entry: picked.entry, reason };
  world.add(t.root);
  updateHud(performance.now());
}

/** 仮置き中の電車を正式に配置・移動する */
async function confirmTrainPlace() {
  if (!course || !trainHand || !trainGhost) return;
  if (trainGhost.reason) {
    toast(trainGhost.reason);
    return;
  }
  const { entry, route: r, headS } = trainGhost;
  const hand = trainHand;
  const t = await Train.create(base, await loadTrainDef(base, hand.kind));
  t.place(r, headS);
  t.speed = 0;

  if (hand.mode === "move") {
    if (train) world.remove(train.root);
  } else if (train && route) {
    extras.push({ train, route, lastTailSeg, occupied, entry: runEntry, lane: runLane, speed, running });
  }

  world.add(t.root);
  train = t;
  route = r;
  runEntry = entry;
  lastTailSeg = tailSegOf(r);
  occupied = new Set();
  $<HTMLSelectElement>("train").value = t.def.id;
  $<HTMLInputElement>("speed").max = String(t.def.maxSpeed);
  $<HTMLInputElement>("speed").min = String(-t.def.maxSpeed);
  speed = t.def.presetSpeed;
  running = true;
  applySpeed();
  holdTrain(null);
  syncCourseTrains();
  updateTrainUi();
  showInfo();
  fitShadow();
  toast(
    hand.mode === "move"
      ? `${t.def.label || t.def.id} を移動しました`
      : `${t.def.label || t.def.id} を置きました（全 ${1 + extras.length} 編成）`,
  );
}

/** 既存編成から最も離れた安全な配置位置（headS）をルート上で探す。空きが無ければ null */
function findFreeSpawnS(r: Route, trainLength: number): number | null {
  if (r.length < trainLength + 0.5) return null;
  const existing = [
    ...(train && route ? [{ t: train, r: route }] : []),
    ...extras.map((x) => ({ t: x.train, r: x.route })),
  ];
  const ptsOf = (t: Train, rt: Route) => {
    const out: { x: number; y: number; z: number }[] = [];
    for (let s = t.s - t.length; s <= t.s + 0.01; s += 1.0) out.push(rt.at(s));
    return out;
  };
  const occupiedPts = existing.flatMap((e) => ptsOf(e.t, e.r));
  const step = Math.max(1.5, r.length / 40);
  let bestS: number | null = null;
  let bestClearance = -1;
  for (let head = trainLength; head <= r.length; head += step) {
    let minD = Infinity;
    for (let s = head - trainLength; s <= head + 0.01; s += 1.2) {
      const p = r.at(s);
      for (const q of occupiedPts) {
        if (Math.abs(p.y - q.y) > 1.0) continue;
        const d = Math.hypot(p.x - q.x, p.z - q.z);
        if (d < minD) minD = d;
      }
    }
    if (minD > bestClearance) {
      bestClearance = minD;
      bestS = head;
    }
  }
  return bestClearance >= 2.2 ? bestS : null;
}

/** 新しい編成を空き位置へ1本追加し、操作対象を切り替える */
async function addTrain(trainId?: string) {
  if (!course) return;
  const id = trainId ?? $<HTMLSelectElement>("train").value;
  const lane = runLane;
  const r = buildRoute(catalog, course.pieces, undefined, undefined, undefined, lane);
  if (!r.points.length) {
    toast("線路がつながっていないため電車を置けません");
    return;
  }
  const t = await Train.create(base, await loadTrainDef(base, id));
  const spawnS = findFreeSpawnS(r, t.length);
  if (spawnS === null) {
    toast("この線路にはもう編成を置く空きがありません");
    return;
  }
  t.place(r, spawnS);
  t.speed = 0;
  world.add(t.root);
  if (train && route) {
    extras.push({ train, route, lastTailSeg, occupied, entry: runEntry, lane: runLane, speed, running });
  }
  train = t;
  route = r;
  runEntry = undefined;
  runLane = lane;
  lastTailSeg = tailSegOf(r);
  occupied = new Set();
  $<HTMLSelectElement>("train").value = t.def.id;
  $<HTMLInputElement>("speed").max = String(t.def.maxSpeed);
  $<HTMLInputElement>("speed").min = String(-t.def.maxSpeed);
  speed = t.def.presetSpeed;
  running = true;
  applySpeed();
  syncCourseTrains();
  updateTrainUi();
  showInfo();
  fitShadow();
  toast(`${t.def.label || t.def.id} を追加しました（全 ${1 + extras.length} 編成）`);
}

/** いま見ている編成を外す（最低1編成は残す） */
function removeCurrentTrain() {
  const next = extras.shift();
  if (!next || !train) {
    toast("最後の1編成は外せません");
    return;
  }
  world.remove(train.root);
  train = next.train;
  route = next.route;
  lastTailSeg = next.lastTailSeg;
  occupied = next.occupied;
  runEntry = next.entry;
  runLane = next.lane;
  speed = next.speed;
  running = next.running;
  $<HTMLSelectElement>("train").value = train.def.id;
  $<HTMLInputElement>("speed").max = String(train.def.maxSpeed);
  $<HTMLInputElement>("speed").min = String(-train.def.maxSpeed);
  applySpeed();
  syncCourseTrains();
  updateTrainUi();
  showInfo();
  fitShadow();
  toast(`編成を外しました（残り ${1 + extras.length} 編成）`);
}

/** カメラとミニマップが見る編成を、次の編成へ替える（2本目以降を1本目と入れ替える） */
function nextTrain() {
  const next = extras.shift();
  if (!next || !train || !route) return;
  extras.push({ train, route, lastTailSeg, occupied, entry: runEntry, lane: runLane, speed, running });
  train = next.train;
  route = next.route;
  lastTailSeg = next.lastTailSeg;
  occupied = next.occupied;
  runEntry = next.entry;
  runLane = next.lane;
  speed = next.speed;
  running = next.running;
  $<HTMLSelectElement>("train").value = train.def.id;
  $<HTMLInputElement>("speed").max = String(train.def.maxSpeed);
  $<HTMLInputElement>("speed").min = String(-train.def.maxSpeed);
  applySpeed();
  updateTrainUi();
  showInfo();
  toast(`${train.def.label || train.def.id} に切り替えました`);
}

/** 全編成のルートを、いまの部品の状態で組み直す */
function rebuildAll() {
  rebuildRoute();
  for (const run of extras) withRun(run, rebuildRoute);
  showInfo();
}

/** 先頭の前ガイドの置き場所。コースが決めた「ここから何m」に、編成の長さを足す */
const headStart = (r: Route, t: Train, at: number) => Math.min(r.length, at + t.length);

/** 口の名前（または保存された部品番号）から、その口を持つ部品を探す */
function entryFor(port: string, preferredPiece?: number): Run["entry"] {
  if (
    preferredPiece !== undefined &&
    preferredPiece >= 0 &&
    preferredPiece < course!.pieces.length &&
    catalog.get(course!.pieces[preferredPiece]!.kind)?.ports.some((q) => q.id === port)
  ) {
    return { piece: preferredPiece, port };
  }
  const piece = course!.pieces.findIndex((p) => catalog.get(p.kind)?.ports.some((q) => q.id === port));
  return piece < 0 ? undefined : { piece, port };
}

/** 2本目以降の編成を、コースの指定どおりに並列で置く */
async function spawnExtras() {
  const specs = (course?.trains ?? []) as { train: string; at: number; port: string; piece?: number; lane?: string }[];
  const gen = renderGeneration;
  extras = [];
  const loaded = await Promise.all(
    specs.slice(1).map(async (spec) => ({
      spec,
      train: await Train.create(base, await loadTrainDef(base, spec.train)),
    })),
  );
  if (gen !== renderGeneration) return;
  for (const { spec, train: t } of loaded) {
    const lane = "";
    let entry = spec.piece !== undefined ? entryFor(spec.port, spec.piece) : undefined;
    let r: Route;
    let spawnS: number;
    if (entry) {
      r = buildRoute(catalog, course!.pieces, entry, undefined, undefined, lane);
      spawnS = headStart(r, t, spec.at);
    } else {
      // piece 未指定の旧保存データ: 空いている別路線（2段目など）があればそこへ優先配置する
      const existing = [
        ...(train && route ? [{ route, headS: train.s, length: train.length }] : []),
        ...extras.map((x) => ({ route: x.route, headS: x.train.s, length: x.train.length })),
      ];
      const auto = planAutoTrainSpawn(catalog, course!.pieces, existing, t.length, lane);
      const fallbackEntry = entryFor(spec.port);
      if (auto && (auto.emptyIsland || !fallbackEntry)) {
        entry = auto.entry;
        r = auto.route;
        spawnS = auto.headS;
      } else {
        entry = fallbackEntry;
        r = buildRoute(catalog, course!.pieces, entry, undefined, undefined, lane);
        spawnS = headStart(r, t, spec.at);
      }
    }
    if (!r.points.length) continue;
    t.place(r, spawnS);
    t.speed = 0;
    world.add(t.root);
    extras.push({ train: t, route: r, lastTailSeg: r.segIndexAt(Math.max(0, r.canonicalHead(t.s, t.length) - t.length)), occupied: new Set(), entry, lane, speed: t.def.presetSpeed, running: true });
  }
}

/** 前に別の編成が居て、このまま進むとぶつかる編成。先頭の前 3m 以内、横 0.9m 以内、高さが近い車体があれば止まる */
function blockedRuns(runs: { train: Train; route: Route; lane: string; want: number }[]): boolean[] {
  return runs.map((a, ia) => {
    const dir = Math.sign(a.want);
    if (dir === 0) return false;
    const lead = a.route.at(a.train.leadS);
    const hx = Math.sin(lead.heading) * dir;
    const hz = -Math.cos(lead.heading) * dir;
    return runs.some((b, ib) => {
      if (ia === ib) return false;
      for (let s = b.train.s - b.train.length; s <= b.train.s + 0.01; s += 0.7) {
        const p = b.route.at(s);
        const dx = p.x - lead.x;
        const dz = p.z - lead.z;
        const ahead = dx * hx + dz * hz;
        // 別の車線なら横に半車線ぶん離れているので、横の許容を狭める
        const reach = a.lane === b.lane ? 0.9 : 0.25;
        if (ahead > -0.2 && ahead < 3 && Math.abs(dx * hz - dz * hx) < reach && Math.abs(p.y - lead.y) < 1) return true;
      }
      return false;
    });
  });
}

/** 前のコマで電車が乗っていた「部品:入口」 */
let occupied = new Set<string>();

/** 電車が抜けた自動の腕を、次の道へ切り替える。乗っている間は動かさない（下で線が変わると瞬間移動する） */
function flipAutoPoints(r: Route, t: Train) {
  const head = r.canonicalHead(t.s, t.length);
  const now = new Set(r.segsUnder(Math.max(0, head - t.length), head).map((sg) => `${sg.piece}:${sg.entry}`));
  let flipped = false;
  for (const key of occupied) {
    if (now.has(key)) continue;
    const [pi, entry] = [Number(key.split(":")[0]), key.slice(key.indexOf(":") + 1)];
    const piece = course?.pieces[pi];
    const def = piece && catalog.get(piece.kind);
    if (!piece || !def) continue;
    const arm = junctionsOf(def).findIndex((j) => j.port === entry);
    if (arm < 0) continue;
    const st = readState(def, piece);
    if (!st.auto[arm]) continue;
    st.picks[arm] = (st.picks[arm]! + 1) % junctionsOf(def)[arm]!.count;
    writeState(piece, st);
    paintMarker(pi);
    flipped = true;
  }
  occupied = now;
  if (flipped) needAll = true;
}

// --- 部品の描画 ---
const ghostMaterial = new THREE.MeshBasicMaterial({
  color: 0x6fb7ff,
  transparent: true,
  opacity: 0.55,
  depthWrite: false,
});

const ghostBadMaterial = new THREE.MeshBasicMaterial({
  color: 0xff5a4d,
  transparent: true,
  opacity: 0.6,
  depthWrite: false,
});

const ghostBranchMaterial = new THREE.MeshBasicMaterial({
  color: 0x2dd4bf,
  transparent: true,
  opacity: 0.72,
  depthWrite: false,
});

/** 部品1つぶんのグループ。ghost なら半透明の1色で描く（置けないなら赤） */
async function makePieceGroup(piece: PieceSave, ghosted = false, bad = false): Promise<THREE.Group> {
  const model = (await loadModel(piece.kind)).clone();
  // FBX は cm・右手系。Unity の取り込みと同じく 0.01 倍して x を反転し、Unity の局所座標に合わせる
  model.scale.set(-0.01, 0.01, 0.01);
  model.children.filter((c) => c.name.startsWith("Connection_")).forEach((c) => model.remove(c));
  if (ghosted) {
    model.traverse((o) => {
      if (o instanceof THREE.Mesh) o.material = bad ? ghostBadMaterial : ghostMaterial;
    });
  }
  const g = new THREE.Group();
  g.position.set(piece.position.x, piece.position.y, piece.position.z);
  g.rotation.order = "YXZ";
  g.rotation.set(
    THREE.MathUtils.degToRad(piece.euler.x),
    THREE.MathUtils.degToRad(piece.euler.y),
    THREE.MathUtils.degToRad(piece.euler.z),
  );
  const derived = catalog.of(piece);
  if (derived && derived.action === "flex" && derived.id !== piece.kind) {
    // まがレール: 節を数珠のように、弧に沿って並べる（Unity の `BuildFlexPiece`）
    const lim = limitsOf(derived);
    const poses = samplePath(derived, derived.paths[0]!, 0.05, 0);
    const total = poses.length * 0.05;
    const count = Math.max(1, Math.round(total / lim.nodeLength));
    const at = (k: number) => poses[Math.min(poses.length - 1, Math.round((poses.length - 1) * (k / count)))]!;
    for (let k = 0; k < count; k++) {
      const a = at(k);
      const b = at(k + 1);
      const bead = new THREE.Group();
      bead.position.set(a.x, a.y, a.z);
      bead.rotation.y = Math.atan2(-(b.x - a.x), -(b.z - a.z));
      bead.add(model.clone());
      g.add(bead);
    }
    return g;
  }
  g.add(model);
  return g;
}

/** 分岐の腕ごとにレバーの印を立てる。腕の口から部品の中心へ少し入った所 */
function addMarker(g: THREE.Group, i: number, piece: PieceSave) {
  const def = catalog.get(piece.kind);
  if (!def) return;
  const junctions = junctionsOf(def);
  if (!junctions.length) return;
  const cx = def.ports.reduce((a, p) => a + p.position[0], 0) / def.ports.length;
  const cz = def.ports.reduce((a, p) => a + p.position[2], 0) / def.ports.length;
  junctions.forEach((junction, j) => {
    const port = def.ports.find((p) => p.id === junction.port)!;
    const dx = cx - port.position[0];
    const dz = cz - port.position[2];
    const len = Math.hypot(dx, dz) || 1;
    const marker = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.6, 12), new THREE.MeshBasicMaterial());
    marker.position.set(port.position[0] + (dx / len) * 1.5, 1.4, port.position[2] + (dz / len) * 1.5);
    marker.rotation.x = Math.PI; // 先を下へ向ける
    marker.userData.arm = j;
    g.add(marker);
    markers.set(`${i}:${j}`, marker);
  });
  paintMarker(i);
}

let renderGeneration = 0;
/** 部品を全部描き直す。読み込み・Undo・新しいコースで使う */
async function renderPieces() {
  const gen = ++renderGeneration;
  for (const g of pieceGroups) world.remove(g);
  pieceGroups = [];
  markers.clear();
  const pieces = course!.pieces;
  const groups = await Promise.all(pieces.map((piece) => makePieceGroup(piece)));
  if (gen !== renderGeneration) return; // 描いている間に次の描き直しが始まった
  groups.forEach((g, i) => {
    g.userData.index = i;
    addMarker(g, i, pieces[i]!);
  });
  pieceGroups = groups;
  for (const g of groups) world.add(g);
  await refreshSupports();
}

let supportsGroup: THREE.Group | null = null;
let supportsGeneration = 0;
/** 高架の橋脚を、いまの部品から作り直す。手で置く橋脚は無く、配置が変わるたびに積み直す */
async function refreshSupports() {
  if (!course) return;
  const gen = ++supportsGeneration;
  const needsPier = course.pieces.some((p) => p.position.y > 0.1 || p.lift > 0 || catalog.get(p.kind)?.climbs);
  const needsDecor = course.pieces.some((p) => (catalog.get(p.kind)?.decorations?.length ?? 0) > 0);
  const needsWorn = course.pieces.some((p) => (p.decorations?.length ?? 0) > 0);
  const [pier, decor, worn] = await Promise.all([
    needsPier ? loadPierModels(base) : Promise.resolve(null),
    needsDecor ? buildDecorations(base, catalog, course.pieces) : Promise.resolve(new THREE.Group()),
    needsWorn ? buildWorn(base, catalog, course.pieces) : Promise.resolve(new THREE.Group()),
  ]);
  if (gen !== supportsGeneration) return;
  if (supportsGroup) world.remove(supportsGroup);
  if (decorGroup) world.remove(decorGroup);
  supportsGroup = pier ? buildSupports(catalog, course.pieces, pier, (kind) => modelBounds.get(kind) ?? null) : new THREE.Group();
  decorGroup = decor;
  decorGroup.add(worn);
  world.add(supportsGroup, decorGroup);
}
let decorGroup: THREE.Group | null = null;

/** 選んだ部品に装飾をかぶせる・外す。トンネルと鉄橋は同時に着ない */
async function toggleWorn(id: string) {
  if (!course || selectedPiece === null) return;
  const piece = course.pieces[selectedPiece]!;
  const worn = await loadWorn(base, id);
  if (!wearable(catalog.get(piece.kind), worn)) {
    toast("この部品には掛けられません（分岐・S字・複線は不可）");
    return;
  }
  snapshot();
  const had = (piece.decorations ?? []).includes(id);
  piece.decorations = had ? [] : [id];
  await refreshSupports();
  paintSelection();
}

// --- 配置 ---
function toast(text: string) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("show"), 2200);
}
let toastTimer = 0;

const endBall = new THREE.SphereGeometry(coarse ? 0.44 : 0.38, 20, 14);
const endHit = new THREE.SphereGeometry(0.95, 8, 6);
const endWhite = new THREE.MeshBasicMaterial({ color: 0xffffff });
const endYellow = new THREE.MeshBasicMaterial({ color: 0xffd23f });
const hitMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });

/** 開いた端を描き直す。端の定義は「他の口と重なっていない口」 */
function refreshEnds() {
  endGroup.clear();
  open = course ? openPorts(catalog, course.pieces) : [];
  // 前に選んでいた端が残っていれば選び直す。無くなっていれば外す
  if (selectedEnd) {
    selectedEnd = open.find((o) => o.piece === selectedEnd!.piece && o.id === selectedEnd!.id) ?? null;
  }
  if (mode !== "build") return;
  open.forEach((o, i) => {
    const ball = new THREE.Mesh(endBall, o === selectedEnd ? endYellow : endWhite);
    ball.scale.setScalar(o === selectedEnd ? 1.5 : 1);
    ball.position.set(o.pos[0], o.pos[1] + 0.3, o.pos[2]);
    const hit = new THREE.Mesh(endHit, hitMaterial);
    hit.userData.end = i;
    hit.position.copy(ball.position);
    endGroup.add(ball, hit);
  });
}

// --- 部品の選択・削除・差し替え ---
let selectedPiece: number | null = null;
let selectionBox: THREE.Mesh | null = null;

/** 選んだ部品の枠を描き直し、削除ボタンと棚の灰色を合わせる */
/** 区間を選んでいるときの、ほかの部品の枠 */
let spanBoxes: THREE.Mesh[] = [];
/** 選んだ区間（部品の番号）。無ければ、つながった全体が対象 */
let spanSet: number[] | null = null;
/** 「区間を選ぶ」を押して、終わりの部品を待っている */
let spanPicking = false;

function paintSelection() {
  if (selectionBox) selectionBox.removeFromParent();
  selectionBox = null;
  spanBoxes.forEach((m) => m.removeFromParent());
  spanBoxes = [];
  for (const i of spanSet ?? []) {
    const gi = pieceGroups[i];
    const bi = course ? modelBounds.get(course.pieces[i]!.kind) : null;
    if (!gi || !bi || i === selectedPiece) continue;
    const size = bi.getSize(new THREE.Vector3()).addScalar(0.12);
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(size.x, size.y, size.z),
      new THREE.MeshBasicMaterial({ color: 0xf5df91, transparent: true, opacity: 0.3, depthWrite: false }),
    );
    box.position.copy(bi.getCenter(new THREE.Vector3()));
    gi.add(box);
    spanBoxes.push(box);
  }
  const g = selectedPiece === null ? null : pieceGroups[selectedPiece];
  const b = selectedPiece === null || !course ? null : modelBounds.get(course.pieces[selectedPiece]!.kind);
  if (g && b) {
    const size = b.getSize(new THREE.Vector3()).addScalar(0.12);
    selectionBox = new THREE.Mesh(
      new THREE.BoxGeometry(size.x, size.y, size.z),
      new THREE.MeshBasicMaterial({ color: 0xf5df91, transparent: true, opacity: 0.45, depthWrite: false }),
    );
    selectionBox.position.copy(b.getCenter(new THREE.Vector3()));
    g.add(selectionBox);
  }
  ($("remove") as HTMLButtonElement).disabled = selectedPiece === null;
  document.body.classList.toggle("picked", selectedPiece !== null);
  const kind = selectedPiece === null || !course ? null : catalog.get(course.pieces[selectedPiece]!.kind);
  const hand = !!kind && !!centrePath(kind);
  ($("tunnel") as HTMLButtonElement).disabled = !hand;
  ($("bridge") as HTMLButtonElement).disabled = !hand;
  document.body.classList.toggle("can-branch", !!kind && canBranch(kind.id));
  if (selectedPiece === null) $("moreMenu").classList.remove("open");
  shelf?.refreshAvailability();
  refreshQuickBar();
}

function selectPiece(i: number | null) {
  if (spanPicking && selectedPiece !== null && i !== null && i !== selectedPiece) {
    const path = pathBetween(selectedPiece, i);
    spanPicking = false;
    if (!path) {
      toast("その部品へは、つながっていません");
      return;
    }
    spanSet = path;
    paintSelection();
    toast(`${path.length} 個の区間を選びました。上下・複製の対象になります`);
    return;
  }
  spanSet = null;
  spanPicking = false;
  selectedPiece = i === selectedPiece ? null : i;
  if (selectedPiece !== null) {
    selectedEnd = null;
    selectedKind = null;
    shelf.select(null);
    refreshEnds();
    void updateGhost();
    toast("差し替えるには、棚から同じ形の部品を選びます");
  }
  paintSelection();
}

/** 部品が増減・入れ替わったあとの描き直し。経路・端・橋脚・ゴーストを合わせる */
async function afterEdit() {
  clearEasyPlan();
  easyBranchSource = null;
  selectedPiece = null;
  spanSet = null;
  spanPicking = false;
  await renderPieces();
  selectedEnd = null;
  refreshEnds();
  refreshBranchHints();
  await resetRoute();
  await updateGhost();
  paintSelection();
  updateEasyUi();
  fitShadow();
}

async function deletePiece() {
  if (!course || selectedPiece === null) return;
  snapshot();
  course.pieces.splice(selectedPiece, 1);
  await afterEdit();
}

/** 継ぎ目の口が重なる部品どうし（部品ごとの隣の一覧） */
function adjacency(): number[][] {
  const pieces = course!.pieces;
  const ports = pieces.map((p) => (catalog.of(p)?.ports ?? []).map((q) => toWorld(p, q.position)));
  return pieces.map((_, i) =>
    pieces.flatMap((__, j) =>
      j !== i && ports[i]!.some((a) => ports[j]!.some((b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 0.05)) ? [j] : [],
    ),
  );
}

/** 選んだ部品とつながった全体（島）。継ぎ目の口が重なる部品を幅優先で辿る */
function islandOf(start: number): number[] {
  const next = adjacency();
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) for (const j of next[queue.shift()!]!) if (!seen.has(j)) (seen.add(j), queue.push(j));
  return [...seen];
}

/** 2つの部品のあいだの、いちばん短い並び（両端を含む）。つながっていなければ null */
function pathBetween(a: number, b: number): number[] | null {
  const next = adjacency();
  const from = new Map<number, number>([[a, a]]);
  const queue = [a];
  while (queue.length && !from.has(b)) {
    const i = queue.shift()!;
    for (const j of next[i]!) if (!from.has(j)) (from.set(j, i), queue.push(j));
  }
  if (!from.has(b)) return null;
  const out = [b];
  while (out[0] !== a) out.unshift(from.get(out[0]!)!);
  return out;
}

/** 操作の対象。区間を選んでいればその区間、そうでなければつながった全体 */
function selectionSet(): number[] {
  return spanSet ?? islandOf(selectedPiece!);
}

/** つながった全体を1階層ぶん上下する（Unity §10.5）。地面の下・他の線との重なりは断って、元へ戻す */
async function liftIsland(dir: 1 | -1) {
  if (!course || selectedPiece === null) return;
  const island = selectionSet();
  const dy = dir * LEVEL_HEIGHT;
  const inIsland = new Set(island);
  const moved = island.map((i) => ({ ...course!.pieces[i]!, position: { ...course!.pieces[i]!.position, y: course!.pieces[i]!.position.y + dy } }));
  const rest = course.pieces.filter((_, i) => !inIsland.has(i));
  for (const p of moved) {
    const hit = findOverlaps(catalog, rest, p, openPorts(catalog, rest), railHalfWidth()).find((h) => h.kind === "ground" || h.kind === "overlap");
    if (hit) {
      toast(hit.kind === "ground" ? "地面より下へは下げられません" : "ほかの線路と重なるので動かせません");
      return;
    }
  }
  snapshot();
  island.forEach((i, k) => (course!.pieces[i] = moved[k]!));
  await afterEdit();
  toast(dir > 0 ? "つながった全体を1階層上げました" : "つながった全体を1階層下げました");
}

/** つながった全体を、姿勢を変えずに1階層上へ複製する（Unity §10.5「1段上にコピー」）。螺旋やタワーを積むのに使う */
async function copyIslandUp() {
  if (!course || selectedPiece === null) return;
  const island = selectionSet();
  const copies: PieceSave[] = island.map((i) => {
    const p = JSON.parse(JSON.stringify(course!.pieces[i])) as PieceSave;
    p.position.y += LEVEL_HEIGHT;
    return p;
  });
  // 複製どうしは繋がっているので、既にある部品だけに対して調べる。1階層の差があれば重ならない
  for (const p of copies) {
    const hit = findOverlaps(catalog, course.pieces, p, openPorts(catalog, course.pieces), railHalfWidth()).find(
      (h) => h.kind === "overlap" || h.kind === "ground" || h.kind === "seam",
    );
    if (hit) {
      toast("1階層上は、ほかの線路と重なるので複製できません");
      return;
    }
  }
  snapshot();
  course.pieces.push(...copies);
  await afterEdit();
  toast(`${copies.length} 個を1階層上へ複製しました`);
}

/**
 * つながった全体を、出口の先へもう1組つなぐ（Unity の「続きにコピー」）。
 * 開いた端がちょうど入口と出口の2つのときだけ。入口を出口へ合わせる剛体変換を全体に掛ける
 */
async function copyContinue() {
  if (!course || selectedPiece === null) return;
  const island = selectionSet();
  const members = new Set(island);
  // 選んだ並びの端。並びの外の部品と繋がっていても、並びの端として数える
  const ends: OpenPort[] = [];
  for (const i of island) {
    const piece = course.pieces[i]!;
    const def = catalog.of(piece)!;
    for (const port of def.ports) {
      const w = toWorld(piece, port.position);
      const shared = island.some(
        (j) =>
          j !== i &&
          catalog.of(course!.pieces[j]!)!.ports.some((q) => {
            const v = toWorld(course!.pieces[j]!, q.position);
            return Math.hypot(w[0] - v[0], w[1] - v[1], w[2] - v[2]) < 0.05;
          }),
      );
      if (!shared) ends.push({ piece: i, id: port.id, pos: w, heading: portHeading(port) - (piece.euler.y * Math.PI) / 180, upstream: isUpstream(def, port) });
    }
  }
  const entry = ends.find((o) => o.upstream);
  const exit = ends.find((o) => !o.upstream);
  if (ends.length !== 2 || !entry || !exit) {
    toast("続きにコピーできるのは、開いた端が入口と出口の2つだけのときです");
    return;
  }
  const delta = exit.heading - entry.heading;
  const c = Math.cos(delta);
  const s = Math.sin(delta);
  const copies: PieceSave[] = island.map((i) => {
    const p = JSON.parse(JSON.stringify(course!.pieces[i])) as PieceSave;
    const dx = p.position.x - entry.pos[0];
    const dz = p.position.z - entry.pos[2];
    p.position = {
      x: exit.pos[0] + dx * c - dz * s,
      y: p.position.y + (exit.pos[1] - entry.pos[1]),
      z: exit.pos[2] + dx * s + dz * c,
    };
    p.euler.y = ((((p.euler.y - (delta * 180) / Math.PI) % 360) + 360) % 360);
    return p;
  });
  const all = [...course.pieces, ...copies];
  for (const p of copies) {
    const others = all.filter((o) => o !== p);
    const hit = findOverlaps(catalog, others, p, openPorts(catalog, others), railHalfWidth()).find(
      (h) => h.kind === "overlap" || h.kind === "ground" || h.kind === "seam" || h.kind === "taken",
    );
    if (hit) {
      toast(`続きに置けません。${hit.kind === "ground" ? "地面の下へ出ます" : hit.kind === "taken" ? "出口の先がもう繋がっています" : "ほかの線路と重なります"}`);
      return;
    }
  }
  snapshot();
  course.pieces.push(...copies);
  await afterEdit();
  toast(`${copies.length} 個を出口の先へ複製しました`);
}

/** 差し替えられる相手か。口が同じ位置・同じ向き・同じ数で並べば、同じ場所へそのまま入れ替えられる（Unity §5.7） */
function replaceable(oldKind: string, newKind: string): boolean {
  const a = catalog.get(oldKind);
  const b = catalog.get(newKind);
  if (!a || !b || a === b || a.ports.length !== b.ports.length) return false;
  const gap = (x: number, y: number) => Math.abs((((x - y) % 360) + 540) % 360 - 180);
  return b.ports.every((q) =>
    a.ports.some(
      (p) =>
        Math.hypot(p.position[0] - q.position[0], p.position[1] - q.position[1], p.position[2] - q.position[2]) < 0.02 &&
        gap(p.euler[1], q.euler[1]) < 1,
    ),
  );
}

async function replacePiece(kind: string) {
  if (!course || selectedPiece === null) return;
  const old = course.pieces[selectedPiece]!;
  if (!replaceable(old.kind, kind)) {
    toast("その部品には差し替えられません（口の位置が違います）");
    return;
  }
  const next: PieceSave = { ...old, kind, state: "", branchSet: false, autoFlip: false };
  withDefaultState(next);
  const rest = course.pieces.filter((_, j) => j !== selectedPiece);
  const hits = findOverlaps(catalog, rest, next, openPorts(catalog, rest), railHalfWidth());
  if (hits.length) {
    toast(refusal(hits));
    return;
  }
  snapshot();
  course.pieces[selectedPiece] = next;
  shelf.pushHistory(kind);
  await afterEdit();
  setShelfOpen(false);
}

/** 選んだ直線系部品の口をすべて含む分岐へ差し替えられるか */
function canBranch(oldKind: string): boolean {
  const a = catalog.get(oldKind);
  const b = catalog.get("PointLeft");
  if (!a || !b || a.ports.length >= b.ports.length) return false;
  const gap = (x: number, y: number) => Math.abs((((x - y) % 360) + 540) % 360 - 180);
  return a.ports.every((p) =>
    b.ports.some(
      (q) =>
        Math.hypot(p.position[0] - q.position[0], p.position[1] - q.position[1], p.position[2] - q.position[2]) < 0.02 &&
        gap(p.euler[1], q.euler[1]) < 1,
    ),
  );
}

/** 選んだ直線を左／右の分岐に差し替え、生えた分岐口をそのまま選択する */
async function branchPiece(targetKind: "PointLeft" | "PointRight") {
  if (!course || selectedPiece === null) return;
  const idx = selectedPiece;
  const old = course.pieces[idx]!;
  if (!canBranch(old.kind)) {
    toast("この部品からは分岐を生やせません");
    return;
  }
  const next: PieceSave = { ...old, kind: targetKind, state: "", branchSet: false, autoFlip: false };
  withDefaultState(next);
  const rest = course.pieces.filter((_, j) => j !== idx);
  const hits = findOverlaps(catalog, rest, next, openPorts(catalog, rest), railHalfWidth());
  if (hits.length) {
    toast(refusal(hits));
    return;
  }
  snapshot();
  course.pieces[idx] = next;
  shelf.pushHistory(targetKind);
  await afterEdit();
  const branchEnd = open.find((o) => o.piece === idx && o.id === "Branch") ?? open.find((o) => o.piece === idx) ?? null;
  if (branchEnd) {
    selectEnd(branchEnd);
    toast("分岐を作りました。下のバーからつなげられます");
  }
}

/** マットの点 p（Unity の座標）を狙う。既にある継ぎ目の近くならそこへ吸い、開いた端の近くなら端から伸ばす流れへ渡す */
function aimFree(p: THREE.Vector3) {
  if (!course || !selectedKind) return;
  if (catalog.get(selectedKind)?.action === "flex") {
    toast("まがレールは、つなぎたい端を選んでから置きます");
    return;
  }
  const y = freeLevel * LEVEL_HEIGHT;
  let x = p.x;
  let z = p.z;
  // 格子（1.5）。既存の継ぎ目が半格子以内にあれば、格子より先にその真上／真下へ
  x = Math.round(x / 1.5) * 1.5;
  z = Math.round(z / 1.5) * 1.5;
  let seam: { d: number; x: number; z: number } | null = null;
  for (const piece of course.pieces) {
    const def = catalog.of(piece);
    for (const port of def?.ports ?? []) {
      const w = toWorld(piece, port.position);
      const d = Math.hypot(w[0] - p.x, w[2] - p.z);
      if (d < 0.75 && (!seam || d < seam.d)) seam = { d, x: w[0], z: w[2] };
    }
  }
  if (seam) {
    x = seam.x;
    z = seam.z;
  }
  // 開いた端に磁石。向きが 22.5° 以内なら、いつもの「端から伸ばす」へ受け渡す
  const near = open
    .map((o) => ({ o, d: Math.hypot(o.pos[0] - x, o.pos[1] - y, o.pos[2] - z) }))
    .filter(({ o, d }) => {
      if (d > MAGNET) return false;
      const gap = Math.abs(Math.atan2(Math.sin(freeTheta - o.heading), Math.cos(freeTheta - o.heading)));
      return Math.min(gap, Math.PI - gap) < Math.PI / 8;
    })
    .sort((a, b) => a.d - b.d)[0];
  if (near) {
    freeAim = null;
    selectEnd(near.o);
    return;
  }
  freeAim = [x, z];
  placementIdx = 0;
  void updateGhost();
}

/** 自由配置の向き（45°刻み）。ghost を回す */
function turnFree(steps: number) {
  freeTheta += (steps * Math.PI) / 4;
  // 向きが合えば磁石が働くので、狙いを出し直す
  if (freeAim) aimFree(new THREE.Vector3(freeAim[0], 0, freeAim[1]));
  else void updateGhost();
}

/** 見ている向きに合わせた最初の進行方向。視点を回したあとでも、1本目は画面の奥へ伸びる */
function facingTheta(): number {
  const d = controls.target.clone().sub(camera.position);
  // シーンの x は Unity の x を反転している
  const theta = Math.atan2(-d.x, -d.z);
  return Math.round(theta / (Math.PI / 4)) * (Math.PI / 4);
}

function selectEnd(end: OpenPort | null) {
  if (end) freeAim = null;
  if (end && selectedPiece !== null) {
    selectedPiece = null;
    paintSelection();
  }
  selectedEnd = end && selectedEnd && end.piece === selectedEnd.piece && end.id === selectedEnd.id ? null : end;
  placementIdx = 0;
  refreshEnds();
  void updateGhost();
  shelf.refreshAvailability();
  refreshQuickBar();
}

function selectKind(kind: string | null) {
  if (kind && trainHand) holdTrain(null);
  if (kind && propsLayer.kind) holdProp(null);
  if (selectedPiece !== null && kind) {
    void replacePiece(kind);
    return;
  }
  selectedKind = kind;
  placementIdx = 0;
  shelf.select(kind);
  if (kind) setShelfOpen(false);
  void updateGhost();
  refreshQuickBar();
}

/** 選んだ端に選んだ部品を置いたときの姿勢（置き方が複数なら placementIdx 番目） */
function currentPlacement() {
  if (selectedKind && !selectedEnd && freeAim) {
    const piece = freePlacement(catalog, selectedKind, [freeAim[0], freeLevel * LEVEL_HEIGHT, freeAim[1]], freeTheta);
    return piece ? { face: "free", piece } : null;
  }
  if (!selectedKind || !selectedEnd) return null;
  const flex = catalog.get(selectedKind);
  if (flex?.action === "flex") {
    const piece = flexPlacement(flex, open, selectedEnd);
    return piece ? { face: "flex", piece } : null;
  }
  const all = placementsAt(catalog, open, selectedEnd, selectedKind);
  if (!all.length) return null;
  return all[placementIdx % all.length]!;
}

let ghostGeneration = 0;
async function updateGhost() {
  const gen = ++ghostGeneration;
  const placement = mode === "build" ? currentPlacement() : null;
  if (!placement) {
    if (ghost) world.remove(ghost);
    ghost = null;
    ghostPiece = null;
    ghostHits = [];
    return;
  }
  const hits = course ? findOverlaps(catalog, course.pieces, placement.piece, open, railHalfWidth()) : [];
  const g = await makePieceGroup(placement.piece, true, hits.length > 0);
  if (gen !== ghostGeneration) return;
  if (ghost) world.remove(ghost);
  ghost = g;
  ghostPiece = placement.piece;
  ghostHits = hits;
  world.add(g);
}

/** レールの半幅。直線の外形の幅から測る（数値は書かない） */
function railHalfWidth(): number {
  const b = modelBounds.get("Straight");
  return b ? Math.max(Math.abs(b.min.x), Math.abs(b.max.x)) : 0.53;
}

/** 置けない理由を一言で。重なっている部品の名前を添える */
function refusal(hits: Hit[]): string {
  const h = hits[0]!;
  if (h.kind === "ground") return "地面の下へもぐるので置けません";
  const name = (i?: number) => (i === undefined || !course ? "" : (catalog.get(course.pieces[i]!.kind)?.label ?? "").replace(/\s*→$/, ""));
  if (h.kind === "seam") return `${name(h.piece)}の継ぎ目と向きが合わないので置けません`;
  if (h.kind === "taken") return `${name(h.piece)}の継ぎ目には、もう別の部品が付いています`;
  return `${name(h.piece)}と重なるので置けません`;
}

/** 戻す前の状態を覚える。部品と町なみをまとめて */
function snapshot() {
  undoStack.push(JSON.stringify({ pieces: course!.pieces, props: course!.props ?? [] }));
  if (undoStack.length > 100) undoStack.shift();
}

// --- 町なみ（情景） ---
/** 棚で町なみを持つ・手放す。持つとレールの選択は外れる */
function holdProp(id: string | null) {
  if (id) {
    holdTrain(null);
    selectedKind = null;
    shelf.select(null);
    freeAim = null;
    selectEnd(null);
    if (selectedPiece !== null) selectPiece(selectedPiece);
    void updateGhost();
  }
  propsLayer.hold(id);
  if (id) setShelfOpen(false);
  shelf.redraw();
}

function confirmProp() {
  if (!course || !propsLayer.kind || !propsLayer.aimAt) return;
  snapshot();
  propsLayer.confirm();
  fitShadow();
}

function deleteProp() {
  if (!course || propsLayer.picked === null) return;
  snapshot();
  propsLayer.remove();
}

async function confirmPlace() {
  if (!course || !ghostPiece || !selectedKind) return;
  if (ghostHits.length) {
    toast(refusal(ghostHits));
    return;
  }
  const piece = withDefaultState({ ...ghostPiece });
  freeAim = null;
  snapshot();
  course.pieces.push(piece);
  const i = course.pieces.length - 1;
  const g = await makePieceGroup(piece);
  g.userData.index = i;
  addMarker(g, i, piece);
  pieceGroups.push(g);
  world.add(g);
  void refreshSupports();
  shelf.pushHistory(selectedKind);

  // 新しい部品の口で開いているものが1つなら、そのまま次の端へ進む（同じ部品を続けて置ける）
  const was = selectedEnd;
  selectedEnd = null;
  open = openPorts(catalog, course.pieces);
  const next = open.filter((o) => o.piece === i);
  selectedEnd = next.length === 1 ? next[0]! : null;
  if (!selectedEnd && was) toast("出口が複数あります。続ける端を選んでください");
  placementIdx = 0;
  refreshEnds();
  if (train) rebuildAll();
  else {
    route = buildRoute(catalog, course.pieces, undefined, undefined, undefined, runLane);
    await showTrain();
    showInfo();
  }
  await updateGhost();
  shelf.refreshAvailability();
  refreshQuickBar();
  fitShadow();
}

async function undo() {
  if (!course || mode !== "build") return;
  const prev = undoStack.pop();
  if (!prev) {
    toast("これ以上戻せません");
    return;
  }
  const state = JSON.parse(prev) as { pieces: PieceSave[]; props: PropSave[] };
  course.pieces = state.pieces;
  course.props = state.props;
  propsLayer.setItems(course.props);
  await afterEdit();
}

/** 部品が減った・入れ替わったときの組み直し。列車は安全な位置へ戻す */
async function resetRoute() {
  if (!course) return;
  runEntry = runEntry && entryFor(runEntry.port, runEntry.piece);
  route = buildRoute(catalog, course.pieces, runEntry, undefined, undefined, runLane);
  if (train && route.points.length) train.place(route, Math.min(route.length, train.length));
  else if (!train) await showTrain();
  lastTailSeg = tailSegOf(route);
  // 2本目以降も、元の路線をなるべく保ちつつ他編成と重ならない空き位置へ置く
  for (const run of extras) {
    withRun(run, () => {
      runEntry = runEntry && entryFor(runEntry.port, runEntry.piece);
      route = buildRoute(catalog, course!.pieces, runEntry, undefined, undefined, runLane);
      if (route.points.length) {
        const freeS = findFreeSpawnS(route, train!.length);
        train!.place(route, freeS ?? headStart(route, train!, 0));
      }
      lastTailSeg = tailSegOf(route);
    });
  }
  showInfo();
}

let lastAutoTrainId = "";
let autoAddingTrain = false;
/**
 * まだ走っていない車種を優先してランダムに選び、
 * 電車のいない路線（独立ループ・未走行支線）を最優先で自動配置する
 */
async function autoAddRandomTrain() {
  if (!course || autoAddingTrain) return;
  autoAddingTrain = true;
  try {
    const trainSelect = $<HTMLSelectElement>("train");
    const allIds = [...trainSelect.options].map((o) => o.value);
    const usedIds = [
      ...(train ? [train.def.id] : []),
      ...extras.map((x) => x.train.def.id),
    ];
    const pickedId = pickRandomTrainId(allIds, usedIds, runLane, lastAutoTrainId);
    if (!pickedId) {
      toast("追加できる電車がありません");
      return;
    }
    const def = await loadTrainDef(base, pickedId);
    const t = await Train.create(base, def);
    const existing = [
      ...(train && route ? [{ route, headS: train.s, length: train.length }] : []),
      ...extras.map((x) => ({ route: x.route, headS: x.train.s, length: x.train.length })),
    ];
    const spawn = planAutoTrainSpawn(catalog, course.pieces, existing, t.length, runLane);
    if (!spawn) {
      toast("電車を置ける空きスペースがありません（線路を伸ばすか別の路線を作ってください）");
      return;
    }

    lastAutoTrainId = pickedId;
    t.place(spawn.route, spawn.headS);
    t.speed = 0;
    world.add(t.root);
    if (train && route) {
      extras.push({ train, route, lastTailSeg, occupied, entry: runEntry, lane: runLane, speed, running });
    }
    train = t;
    route = spawn.route;
    runEntry = spawn.entry;
    lastTailSeg = tailSegOf(route);
    occupied = new Set();
    trainSelect.value = t.def.id;
    $<HTMLInputElement>("speed").max = String(t.def.maxSpeed);
    $<HTMLInputElement>("speed").min = String(-t.def.maxSpeed);
    speed = t.def.presetSpeed;
    running = true;
    applySpeed();
    syncCourseTrains();
    updateTrainUi();
    showInfo();
    fitShadow();

    const label = t.def.label || t.def.id;
    const total = 1 + extras.length;
    if (spawn.emptyIsland && spawn.islandCount > 1) {
      toast(`${label} を空いている路線に置きました（全 ${total} 編成）`);
    } else if (spawn.uncovered) {
      toast(`${label} を別の路線へ置きました（全 ${total} 編成）`);
    } else {
      toast(`${label} を置きました（全 ${total} 編成）`);
    }
  } finally {
    autoAddingTrain = false;
  }
}

// --- かんたん配置モード ---
const branchHintGeo = new THREE.SphereGeometry(coarse ? 0.48 : 0.42, 20, 14);
const branchHintMat = new THREE.MeshBasicMaterial({ color: 0x28c7ff });

function clearEasyGhost() {
  easyGhostGeneration++;
  if (easyGhostGroup) world.remove(easyGhostGroup);
  easyGhostGroup = null;
  for (const idx of hiddenByEasyGhost) {
    const g = pieceGroups[idx];
    if (g) g.visible = true;
  }
  hiddenByEasyGhost = [];
}

function clearEasyPlan() {
  easyPlans = [];
  easyPlanIdx = 0;
  easyStartAim = null;
  clearEasyGhost();
  updateEasyUi();
  updateHud(performance.now());
}

function refreshBranchHints() {
  branchHintGroup.clear();
  easyBranchHints = [];
  if (mode !== "build" || buildStyle !== "easy" || easyBranchSource === null || easyPlans.length > 0 || !course) return;
  const variants = branchVariants(catalog, course.pieces, open, easyBranchSource, railHalfWidth());
  const seen = new Set<string>();
  for (const v of variants) {
    const key = `${Math.round(v.branchPort.pos[0] * 2)},${Math.round(v.branchPort.pos[2] * 2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const k = easyBranchHints.length;
    easyBranchHints.push(v);
    const ball = new THREE.Mesh(branchHintGeo, branchHintMat);
    ball.position.set(v.branchPort.pos[0], v.branchPort.pos[1] + 0.36, v.branchPort.pos[2]);
    const hit = new THREE.Mesh(endHit, hitMaterial);
    hit.userData.branchHint = k;
    hit.position.copy(ball.position);
    branchHintGroup.add(ball, hit);
  }
}

function updateEasyUi() {
  const isEasy = mode === "build" && buildStyle === "easy";
  document.body.classList.toggle("easy-mode", isEasy);
  document.body.classList.toggle("easy-picked", isEasy && selectedPiece !== null && easyPlans.length === 0);
  const styleEasyBtn = document.getElementById("styleEasy");
  const stylePartsBtn = document.getElementById("styleParts");
  if (styleEasyBtn) styleEasyBtn.classList.toggle("on", buildStyle === "easy");
  if (stylePartsBtn) stylePartsBtn.classList.toggle("on", buildStyle === "parts");
  const levLabel = document.getElementById("easyLevLabel");
  if (levLabel) levLabel.textContent = easyLevel === 0 ? "地上" : `${easyLevel + 1}階`;
  const downBtn = document.getElementById("easyLevDown") as HTMLButtonElement | null;
  const upBtn = document.getElementById("easyLevUp") as HTMLButtonElement | null;
  if (downBtn) downBtn.disabled = easyLevel <= 0;
  if (upBtn) upBtn.disabled = easyLevel >= 4;
  const closeBtn = document.getElementById("easyCloseLoop") as HTMLButtonElement | null;
  if (closeBtn) closeBtn.disabled = open.length < 2;
  const hintEl = document.getElementById("easyPieceHint");
  if (hintEl && selectedPiece !== null && isEasy) {
    const verb = coarse ? "タップ" : "クリック";
    hintEl.textContent = easyBranchSource !== null ? `分岐元（伸ばす先を${verb}）` : "レール選択中";
  }
}

function setBuildStyle(next: "easy" | "parts") {
  if (buildStyle === next) return;
  buildStyle = next;
  clearEasyPlan();
  easyBranchSource = null;
  selectedKind = null;
  freeAim = null;
  shelf?.select(null);
  setShelfOpen(false);
  if (propsLayer.kind || propsLayer.picked !== null) {
    propsLayer.clearHand();
    shelf?.redraw();
  }
  void updateGhost();
  if (buildStyle === "easy") {
    if (selectedEnd) easyLevel = Math.max(0, Math.round(selectedEnd.pos[1] / LEVEL_HEIGHT));
    if (selectedPiece !== null && course) {
      easyBranchSource = branchVariants(catalog, course.pieces, open, selectedPiece, railHalfWidth()).length > 0 ? selectedPiece : null;
    }
  }
  refreshBranchHints();
  paintSelection();
  refreshQuickBar();
  updateEasyUi();
  updateHud(performance.now());
}

function easySelectPiece(idx: number | null) {
  clearEasyPlan();
  if (idx !== null) selectedEnd = null;
  selectedPiece = idx === selectedPiece ? null : idx;
  if (selectedPiece !== null && course) {
    const vars = branchVariants(catalog, course.pieces, open, selectedPiece, railHalfWidth());
    easyBranchSource = vars.length > 0 ? selectedPiece : null;
    easyLevel = Math.max(0, Math.round(course.pieces[selectedPiece]!.position.y / LEVEL_HEIGHT));
  } else {
    easyBranchSource = null;
  }
  refreshEnds();
  paintSelection();
  refreshBranchHints();
  updateEasyUi();
  updateHud(performance.now());
}

function showEasyPlans(plans: EasyPlan[], startAim: [number, number] | null = null) {
  easyPlans = plans;
  easyPlanIdx = 0;
  easyStartAim = startAim;
  refreshBranchHints();
  updateEasyUi();
  void renderEasyGhost();
}

async function renderEasyGhost() {
  const gen = ++easyGhostGeneration;
  clearEasyGhost();
  easyGhostGeneration = gen;
  const plan = easyPlans[easyPlanIdx];
  if (!plan || mode !== "build" || buildStyle !== "easy") {
    updateHud(performance.now());
    return;
  }
  const repMeshes = await Promise.all(
    plan.replacements.map(async (r) => {
      const g = await makePieceGroup(r.piece, true, false);
      g.traverse((o) => {
        if (o instanceof THREE.Mesh) o.material = ghostBranchMaterial;
      });
      return g;
    }),
  );
  const addMeshes = await Promise.all(plan.additions.map((p) => makePieceGroup(p, true, false)));
  if (gen !== easyGhostGeneration) return;

  const group = new THREE.Group();
  for (const g of repMeshes) group.add(g);
  for (const g of addMeshes) group.add(g);

  // 差し替え対象の既存レールを一時的に隠して分岐ゴーストを見やすくする
  hiddenByEasyGhost = [];
  for (const r of plan.replacements) {
    for (const idx of r.indices) {
      const pg = pieceGroups[idx];
      if (pg && pg.visible) {
        pg.visible = false;
        hiddenByEasyGhost.push(idx);
      }
    }
  }
  easyGhostGroup = group;
  world.add(group);
  updateHud(performance.now());
}

async function confirmEasyPlan() {
  const plan = easyPlans[easyPlanIdx];
  if (!course || !plan) return;
  snapshot();
  const targetTip = plan.nextEnd;
  const hadReplacements = plan.replacements.length > 0;
  const planKind = plan.kind;
  clearEasyPlan();
  easyBranchSource = null;
  selectedPiece = null;
  refreshBranchHints();

  course.pieces = applyPlanToPieces(course.pieces, plan);
  await renderPieces();
  open = openPorts(catalog, course.pieces);
  selectedEnd = targetTip
    ? open.find((o) => Math.hypot(o.pos[0] - targetTip.pos[0], o.pos[1] - targetTip.pos[1], o.pos[2] - targetTip.pos[2]) <= 0.06) ?? null
    : null;
  if (selectedEnd) easyLevel = Math.max(0, Math.round(selectedEnd.pos[1] / LEVEL_HEIGHT));
  refreshEnds();
  paintSelection();

  if (!hadReplacements && train) {
    rebuildAll();
  } else {
    await resetRoute();
  }
  fitShadow();
  updateEasyUi();
  updateHud(performance.now());

  if (planKind === "connect") toast(open.length === 0 ? "ループがつながりました！" : "線路をつなぎました！");
  else if (planKind === "merge" || planKind === "branch-merge") toast("分岐して合流しました！");
  else if (planKind === "branch") toast("分岐をつくりました！そのまま続けて伸ばせます");
  else if (planKind === "start") toast("新しい線路を置きました！行きたい場所をタップして伸ばせます");
}

function triggerEasyAutoClose() {
  if (!course || open.length < 2) {
    toast("つなげられる開いた端が2つ以上ありません");
    return;
  }
  const plans = planAutoClose(catalog, course.pieces, open, selectedEnd, railHalfWidth());
  if (!plans.length) {
    toast("この位置どうしは自動で閉じられませんでした。近くまで伸ばしてからお試しください");
    return;
  }
  showEasyPlans(plans);
}

function pickBranchHintAt(clientX: number, clientY: number, radiusPx: number): BranchVariant | null {
  let best: BranchVariant | null = null;
  let bestDist = radiusPx;
  for (const v of easyBranchHints) {
    const wp = world.localToWorld(new THREE.Vector3(v.branchPort.pos[0], v.branchPort.pos[1] + 0.36, v.branchPort.pos[2]));
    const sp = screenPosOf(wp);
    if (!sp.visible) continue;
    const d = Math.hypot(sp.x - clientX, sp.y - clientY);
    if (d < bestDist) {
      bestDist = d;
      best = v;
    }
  }
  return best;
}

// --- 入力（マルチタッチ誤爆防止 + タッチ選択補助） ---
const raycaster = new THREE.Raycaster();
const activePointers = new Set<number>();
let multiTouchGesture = false;
let downAt: [number, number] | null = null;
let downPointerId: number | null = null;

function screenPosOf(worldPos: THREE.Vector3): { x: number; y: number; visible: boolean } {
  const p = worldPos.clone().project(camera);
  const w = renderer.domElement.clientWidth || innerWidth;
  const h = renderer.domElement.clientHeight || innerHeight;
  return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h, visible: p.z >= -1 && p.z <= 1 };
}

/** 画面座標から radiusPx 以内のいちばん近い開いた端を拾う（タッチ選択補助） */
function pickEndAt(clientX: number, clientY: number, radiusPx: number): OpenPort | null {
  let best: OpenPort | null = null;
  let bestDist = radiusPx;
  for (const o of open) {
    const wp = world.localToWorld(new THREE.Vector3(o.pos[0], o.pos[1] + 0.3, o.pos[2]));
    const sp = screenPosOf(wp);
    if (!sp.visible) continue;
    const d = Math.hypot(sp.x - clientX, sp.y - clientY);
    if (d < bestDist) {
      bestDist = d;
      best = o;
    }
  }
  return best;
}

/** 画面座標から radiusPx 以内のいちばん近い分岐レバーを拾う（走行モード用） */
function pickMarkerAt(clientX: number, clientY: number, radiusPx: number): { idx: number; arm: number } | null {
  let best: { idx: number; arm: number } | null = null;
  let bestDist = radiusPx;
  for (const [key, m] of markers) {
    const sp = screenPosOf(m.getWorldPosition(new THREE.Vector3()));
    if (!sp.visible) continue;
    const d = Math.hypot(sp.x - clientX, sp.y - clientY);
    if (d < bestDist) {
      bestDist = d;
      const [idxStr] = key.split(":");
      best = { idx: Number(idxStr), arm: m.userData.arm as number };
    }
  }
  return best;
}

/** 部品のヒット判定。タッチ時は中心で外れても周囲の補助点で拾う */
function pickPieceObject(clientX: number, clientY: number, isTouch: boolean): { obj: THREE.Object3D; hit: THREE.Intersection } | null {
  const w = renderer.domElement.clientWidth || innerWidth;
  const h = renderer.domElement.clientHeight || innerHeight;
  const offsets: [number, number][] = isTouch ? [[0, 0], [16, 0], [-16, 0], [0, 16], [0, -16]] : [[0, 0]];
  for (const [dx, dy] of offsets) {
    const ndc = new THREE.Vector2(((clientX + dx) / w) * 2 - 1, -((clientY + dy) / h) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(pieceGroups, true)[0];
    if (!hit) continue;
    let o: THREE.Object3D | null = hit.object;
    while (o && o.userData.index === undefined) o = o.parent;
    if (o) return { obj: o, hit };
  }
  return null;
}

function closePopups() {
  $("menuPanel").classList.remove("open");
  $("guidePanel").classList.remove("open");
  $("moreMenu").classList.remove("open");
}

renderer.domElement.addEventListener("pointerdown", (e) => {
  activePointers.add(e.pointerId);
  if (activePointers.size >= 2) {
    multiTouchGesture = true;
    downAt = null;
    downPointerId = null;
    return;
  }
  downAt = [e.clientX, e.clientY];
  downPointerId = e.pointerId;
});

renderer.domElement.addEventListener("pointercancel", (e) => {
  activePointers.delete(e.pointerId);
  if (activePointers.size === 0) multiTouchGesture = false;
  if (downPointerId === e.pointerId) {
    downAt = null;
    downPointerId = null;
  }
});

renderer.domElement.addEventListener("pointerup", (e) => {
  activePointers.delete(e.pointerId);
  const wasMulti = multiTouchGesture;
  if (activePointers.size === 0) multiTouchGesture = false;
  if (wasMulti || downPointerId !== e.pointerId) return;
  downPointerId = null;

  const isTouch = e.pointerType === "touch";
  // ドラッグ（カメラ操作）はタップとみなさない
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > (isTouch ? 16 : 5) || !course) return;
  if (!isTouch && e.button !== 0) return;

  // 盤面タップで開いているポップアップを閉じる
  closePopups();
  if (document.body.classList.contains("shelf-open")) {
    setShelfOpen(false);
    return;
  }

  const w = renderer.domElement.clientWidth || innerWidth;
  const h = renderer.domElement.clientHeight || innerHeight;
  const ndc = new THREE.Vector2((e.clientX / w) * 2 - 1, -(e.clientY / h) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);

  if (mode === "build") {
    // 電車を持っていれば、好きなレールをタップして仮置き・確定する
    if (trainHand) {
      if (trainGhost && raycaster.intersectObject(trainGhost.train.root, true).length) {
        void confirmTrainPlace();
        return;
      }
      const pickedPart = pickPieceObject(e.clientX, e.clientY, isTouch);
      if (pickedPart) {
        const idx = pickedPart.obj.userData.index as number;
        if (trainAim && trainAim.piece === idx) trainAim.candIdx++;
        else trainAim = { piece: idx, candIdx: 0 };
        void updateTrainGhost();
      } else {
        toast("電車を置きたいレールをタップしてください");
      }
      return;
    }
    // かんたんモードの盤面タップ処理（左右レールを意識せずに行き先・分岐先をタップ）
    if (buildStyle === "easy") {
      // 1. 仮置きゴーストをタップしたら確定
      if (easyGhostGroup && raycaster.intersectObject(easyGhostGroup, true).length) {
        void confirmEasyPlan();
        return;
      }
      // 2. 分岐ヒントの水色玉をタップしたら、その方向へ分岐プレビュー
      const nearHint = pickBranchHintAt(e.clientX, e.clientY, isTouch ? 36 : 18);
      if (nearHint) {
        showEasyPlans([
          {
            replacements: nearHint.replacement ? [nearHint.replacement] : [],
            additions: [],
            nextEnd: nearHint.branchPort,
            summary: "ここから分岐する",
            kind: "branch",
            score: 0,
          },
        ]);
        return;
      }
      // 3. 開いた端（白・黄色の玉）をタップ
      const nearEnd = pickEndAt(e.clientX, e.clientY, isTouch ? 34 : 16);
      const hitEnd = nearEnd
        ? null
        : raycaster.intersectObjects(endGroup.children, false).find((h) => h.object.userData.end !== undefined);
      const tappedEnd = nearEnd ?? (hitEnd ? open[hitEnd.object.userData.end as number]! : null);
      if (tappedEnd) {
        if (selectedEnd && !(tappedEnd.piece === selectedEnd.piece && tappedEnd.id === selectedEnd.id)) {
          const plans = planToPort(catalog, course.pieces, open, selectedEnd, tappedEnd, railHalfWidth());
          if (plans.length) {
            showEasyPlans(plans);
            return;
          }
          toast("そこへは直接つなげませんでした。選択する端を切り替えます");
        } else if (easyBranchSource !== null) {
          const plans = planBranchToPoint(
            catalog,
            course.pieces,
            open,
            easyBranchSource,
            tappedEnd.pos[0],
            tappedEnd.pos[2],
            Math.round(tappedEnd.pos[1] / LEVEL_HEIGHT),
            railHalfWidth(),
          );
          if (plans.length) {
            showEasyPlans(plans);
            return;
          }
        }
        clearEasyPlan();
        easyBranchSource = null;
        selectedPiece = null;
        refreshBranchHints();
        selectEnd(tappedEnd);
        if (selectedEnd) easyLevel = Math.max(0, Math.round(selectedEnd.pos[1] / LEVEL_HEIGHT));
        updateEasyUi();
        updateHud(performance.now());
        return;
      }
      // 4. 既存レールをタップ（合流 / 分岐元選択 / 削除・電車配置）
      const pickedPart = pickPieceObject(e.clientX, e.clientY, isTouch);
      if (pickedPart) {
        const idx = pickedPart.obj.userData.index as number;
        if (selectedEnd && selectedEnd.piece !== idx) {
          const plans = planMergeIntoPiece(catalog, course.pieces, open, selectedEnd, idx, railHalfWidth());
          if (plans.length) {
            showEasyPlans(plans);
            return;
          }
        }
        if (easyBranchSource !== null && easyBranchSource !== idx) {
          const plans = planBranchAndMerge(catalog, course.pieces, open, easyBranchSource, idx, railHalfWidth());
          if (plans.length) {
            showEasyPlans(plans);
            return;
          }
        }
        easySelectPiece(idx);
        return;
      }
      // 5. マットをタップ（自動ルート生成、または選択中の分岐元から自動で分岐＆延長）
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -easyLevel * LEVEL_HEIGHT);
      const hit3 = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
      if (hit3) {
        const local = world.worldToLocal(hit3);
        if (easyBranchSource !== null) {
          const plans = planBranchToPoint(catalog, course.pieces, open, easyBranchSource, local.x, local.z, easyLevel, railHalfWidth());
          if (plans.length) {
            showEasyPlans(plans);
          } else {
            toast("その方向へは分岐をつなげませんでした。別の場所をタップしてみてください");
          }
          return;
        }
        const plans = planMatTap(catalog, course.pieces, open, selectedEnd, local.x, local.z, easyLevel, facingTheta(), railHalfWidth());
        if (plans.length) {
          showEasyPlans(plans, plans[0]!.kind === "start" ? [local.x, local.z] : null);
        } else {
          toast("そこへは線路が重なるため繋げませんでした。別の場所をタップしてみてください");
        }
      }
      return;
    }
    // 優先順は ゴースト（確定） > 端（選択、画面距離で吸着）
    if (ghost && raycaster.intersectObject(ghost, true).length) {
      void confirmPlace();
      return;
    }
    if (propsLayer.hitsGhost(raycaster)) {
      confirmProp();
      return;
    }
    const nearEnd = pickEndAt(e.clientX, e.clientY, isTouch ? 34 : 16);
    if (nearEnd) {
      selectEnd(nearEnd);
      return;
    }
    const hitEnd = raycaster.intersectObjects(endGroup.children, false).find((h) => h.object.userData.end !== undefined);
    if (hitEnd) {
      selectEnd(open[hitEnd.object.userData.end as number]!);
      return;
    }
    // 端でなければ部品を選ぶ。何もない所なら自由配置または選択解除
    const pickedPart = pickPieceObject(e.clientX, e.clientY, isTouch);
    raycaster.setFromCamera(ndc, camera);
    const placed = propsLayer.kind ? null : propsLayer.pickAt(raycaster);
    if (pickedPart) {
      propsLayer.pick(null);
      selectPiece(pickedPart.obj.userData.index as number);
    } else if (placed !== null) {
      if (selectedPiece !== null) selectPiece(selectedPiece);
      propsLayer.pick(placed);
    } else if (propsLayer.kind) {
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const hit3 = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
      if (hit3) propsLayer.aim(world.worldToLocal(hit3));
    } else if (selectedKind && !selectedEnd) {
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -freeLevel * LEVEL_HEIGHT);
      const hit3 = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
      if (hit3) aimFree(world.worldToLocal(hit3));
    } else if (selectedPiece !== null) selectPiece(selectedPiece);
    return;
  }

  // 走行モードでは分岐を切り替える（レバー付近の吸着を優先）
  const nearMarker = pickMarkerAt(e.clientX, e.clientY, isTouch ? 38 : 18);
  if (nearMarker) {
    toggleSwitch(nearMarker.idx, nearMarker.arm);
    return;
  }
  const pickedPart = pickPieceObject(e.clientX, e.clientY, isTouch);
  if (!pickedPart) return;
  const idx = pickedPart.obj.userData.index as number;
  let arm = 0;
  let best = Infinity;
  for (const [key, m] of markers) {
    if (!key.startsWith(`${idx}:`)) continue;
    const d = m.getWorldPosition(new THREE.Vector3()).distanceTo(pickedPart.hit.point);
    if (d < best) {
      best = d;
      arm = m.userData.arm as number;
    }
  }
  toggleSwitch(idx, arm);
});

// --- モードと視点 ---
const BUILD_VIEWS = [
  { id: "oblique", label: "斜め", polar: 0.9 },
  { id: "top", label: "真上", polar: 0.02 },
  { id: "low", label: "低く", polar: 1.3 },
];
const DRIVE_VIEWS: { id: CameraMode; label: string }[] = [
  { id: "free", label: "全体" },
  { id: "tps", label: "追従" },
  { id: "cab", label: "前面展望" },
];

/** 見ている点と距離と向きはそのまま、俯角だけを変える */
function setBuildView(polar: number) {
  const off = camera.position.clone().sub(controls.target);
  const r = off.length();
  const az = Math.atan2(off.x, off.z);
  camera.position.set(
    controls.target.x + r * Math.sin(polar) * Math.sin(az),
    controls.target.y + r * Math.cos(polar),
    controls.target.z + r * Math.sin(polar) * Math.cos(az),
  );
  camera.lookAt(controls.target);
}

function renderViewButtons() {
  const bar = $("topCenter");
  bar.replaceChildren();
  const items = mode === "build" ? BUILD_VIEWS : DRIVE_VIEWS;
  items.forEach((v, i) => {
    const b = document.createElement("button");
    b.textContent = v.label;
    b.className = i === 0 ? "on" : "";
    b.onclick = () => {
      for (const x of bar.children) x.classList.remove("on");
      b.classList.add("on");
      if (mode === "build") setBuildView((v as (typeof BUILD_VIEWS)[number]).polar);
      else rig.set((v as (typeof DRIVE_VIEWS)[number]).id);
    };
    bar.append(b);
  });
}

// --- クイック配置バーと引き出し棚 ---
const QUICK_PARTS: { id: string; label: string }[] = [
  { id: "Straight", label: "直線" },
  { id: "Left", label: "左カーブ" },
  { id: "Right", label: "右カーブ" },
  { id: "HalfStraight", label: "1/2直線" },
  { id: "SlopeUpOriginal", label: "坂のぼり" },
  { id: "SlopeDownOriginal", label: "坂くだり" },
  { id: "PointLeft", label: "分岐左" },
  { id: "PointRight", label: "分岐右" },
  { id: "FlexRail", label: "曲がる" },
];
const quickButtons = new Map<string, HTMLButtonElement>();

function setShelfOpen(openShelf: boolean) {
  const show = openShelf && mode === "build";
  document.body.classList.toggle("shelf-open", show);
  if (show) {
    closePopups();
    shelf?.ensureRendered();
  }
}

function isPartAvailable(kind: string): boolean {
  if (!course) return true;
  if (selectedPiece !== null) return replaceable(course.pieces[selectedPiece]!.kind, kind);
  if (!selectedEnd) return true;
  const def = catalog.get(kind);
  if (!def) return false;
  return def.action === "flex" ? !!flexPlacement(def, open, selectedEnd) : placementsAt(catalog, open, selectedEnd, kind).length > 0;
}

function buildQuickBar() {
  const list = $("quickList");
  list.replaceChildren();
  quickButtons.clear();
  for (const item of QUICK_PARTS) {
    if (!catalog.has(item.id)) continue;
    const b = document.createElement("button");
    b.className = "qbtn";
    b.title = catalog.get(item.id)?.label ?? item.label;
    const span = document.createElement("span");
    span.textContent = item.label;
    b.append(span);
    b.onclick = () => {
      if (selectedKind === item.id) {
        placementIdx++;
        void updateGhost();
      } else {
        selectKind(item.id);
      }
    };
    list.append(b);
    quickButtons.set(item.id, b);
  }
  refreshQuickBar();
}

/** 初回表示のあとに、クイックバーのアイコン画像を裏で生成して差し込む */
function loadQuickBarThumbs(thumb: ReturnType<typeof createThumbnailer>) {
  for (const [id, b] of quickButtons) {
    const img = document.createElement("img");
    img.alt = "";
    img.width = img.height = 34;
    thumb(id).then(
      (url) => {
        img.src = url;
        b.prepend(img);
      },
      () => img.remove(),
    );
  }
}

function refreshQuickBar() {
  for (const [id, b] of quickButtons) {
    b.classList.toggle("on", selectedKind === id);
    b.classList.toggle("off", !isPartAvailable(id));
  }
}

function setMode(next: "build" | "drive") {
  mode = next;
  clearEasyPlan();
  easyBranchSource = null;
  selectedPiece = null;
  paintSelection();
  propsLayer.clearHand();
  holdTrain(null);
  setShelfOpen(false);
  closePopups();
  document.body.classList.toggle("drive", mode === "drive");
  $("modeLabel").textContent = mode === "build" ? "配置" : "走行";
  $("modeSwitch").innerHTML = `${mode === "build" ? "走る" : "つくる"}<span class="key"> [Tab]</span>`;
  ($("undo") as HTMLButtonElement).disabled = mode === "drive";
  rig.set("free");
  renderViewButtons();
  refreshEnds();
  refreshBranchHints();
  updateEasyUi();
  void updateGhost();
  applySpeed();
}

const GUIDE: [string, string][] = [
  ["かんたんモード（標準）", "行きたい場所をタップするだけで直線・左右カーブ・坂を自動選択。もう一度タップか「✓」で確定"],
  ["自動分岐・合流", "直線をタップ → 伸ばしたい場所（または別の直線）をタップで分岐や合流を自動作成"],
  ["輪にする / 高さ / 電車＋", "「🔄 輪にする」で自動接続。「地上 / 2階」で自動坂。「🚃 電車＋」は空いている路線へランダムな電車を自動配置"],
  ["くわしくモード", "さまざまな線路・駅・踏切・複線・町なみを自由に選べます（いつでも切替可能）"],
  ["カメラ操作", "1本指ドラッグで回転、2本指ピンチ／ドラッグで拡大移動（PC: 右ドラッグ / ホイール / 左ドラッグ）"],
  ["走行モード", "スライダーで速度調整、分岐タップで自動→固定切替（PC: Tab / Space / R / N）"],
];

// --- コース ---
async function openCourse(name: string) {
  course = await loadCourse(base, name);
  await startCourse();
}

/** 空のマットに、起点の直線を1本置く */
async function newCourse() {
  const start = [...catalog.values()].find((d) => (d as { start?: boolean }).start);
  if (!start) return;
  course = {
    version: 1,
    pieces: [
      {
        kind: start.id,
        position: { x: 0, y: 0, z: 0 },
        euler: { x: 0, y: 0, z: 0 },
        state: "",
        lift: 0,
        liftFrom: "",
        branchSet: false,
        autoFlip: false,
      },
    ],
  };
  await startCourse();
}

async function startCourse() {
  route = null;
  train = null;
  extras = [];
  runEntry = undefined;
  occupied = new Set();
  clearEasyPlan();
  easyBranchSource = null;
  easyLevel = 0;
  world.remove(...world.children.filter((c) => c !== endGroup && c !== branchHintGroup && c !== propsLayer.group));
  course!.props ??= [];
  propsLayer.clearHand();
  propsLayer.setItems(course!.props);
  ghost = null;
  ghostPiece = null;
  undoStack = [];
  selectedEnd = null;
  selectedPiece = null;
  open = openPorts(catalog, course!.pieces);
  freeAim = null;
  freeLevel = 0;
  freeTheta = facingTheta();
  const firstSpec = (course!.trains as { train?: string; port?: string; piece?: number; lane?: string }[] | undefined)?.[0];
  runLane = "";
  runEntry = firstSpec?.piece !== undefined && firstSpec.port ? entryFor(firstSpec.port, firstSpec.piece) : undefined;
  route = buildRoute(catalog, course!.pieces, runEntry, undefined, undefined, runLane);
  if (route.notes.length) console.warn("ルート", route.notes);
  // 1本目の電車の種類はコースが決める（棚の選択はそのあとで変えられる）
  const first = firstSpec?.train;
  const trainSelect = $<HTMLSelectElement>("train");
  if (first && [...trainSelect.options].some((o) => o.value === first)) trainSelect.value = first;
  await Promise.all([renderPieces(), showTrain().then(() => spawnExtras())]);
  paintSelection();
  showInfo();
  refreshEnds();
  refreshBranchHints();
  updateEasyUi();
  updateTrainUi();
  void updateGhost();
  shelf.refreshAvailability();
  refreshQuickBar();
  fitShadow();
  // コース全体が入る位置へカメラを寄せる（縦画面では横幅に合わせて少し引く）
  const box = new THREE.Box3().setFromObject(world);
  const center = box.getCenter(new THREE.Vector3());
  const aspectFix = camera.aspect < 1 ? 1 / Math.max(0.55, camera.aspect * 1.12) : 1;
  const radius = Math.max(8, (box.getSize(new THREE.Vector3()).length() / 2) * aspectFix);
  controls.target.copy(center);
  camera.position.set(center.x, center.y + radius * 1.1, center.z - radius * 1.1);
}

// --- 起動 ---
/** 影を落とす範囲を、いまの部品と電車が入る大きさへ合わせる */
function fitShadow() {
  const box = new THREE.Box3();
  for (const g of pieceGroups) box.expandByObject(g);
  if (propsLayer.group.children.length) box.expandByObject(propsLayer.group);
  if (train) box.expandByObject(train.root);
  if (!box.isEmpty()) scenery.lights.fitShadow(box);
}

/** 空と床だけを撮って、レールの艶に映り込ませる環境にする（強さ 0.6） */
function bakeEnvironment() {
  const pmrem = new THREE.PMREMGenerator(renderer);
  world.visible = false;
  const target = pmrem.fromScene(scene, 0, 1, 1500, { size: 128, position: new THREE.Vector3(0, 7, 0) });
  world.visible = true;
  setSharedEnvironment(target.texture);
  pmrem.dispose();
}

async function main() {
  const t0 = performance.now();
  // 背景（床・マット・空・光）は外部ファイルなしで即座に組み、bundle.json 到着後すぐコースを読む
  const bundlePromise = loadBundle(base);
  scenery = buildScenery(scene);
  bakeEnvironment();
  const tScenery = performance.now();

  const bundle = await bundlePromise;
  const tBundle = performance.now();

  propsLayer.setDefs(bundle.scenery);
  seedWornDefs(bundle.scenery);
  seedTrainDefs(bundle.trains);
  catalog = new Catalog(bundle.rails.map((d) => [d.id, d]));

  if (import.meta.env.DEV) {
    const { errors: routeErrors, skipped } = checkCatalog(catalog);
    if (routeErrors.length) console.error(`経路の検算に失敗 ${routeErrors.length} 件\n` + routeErrors.join("\n"));
    else console.log(`経路の検算 OK（${catalog.size} 種）`);
    if (skipped.length) console.log(`対象外の道（焼き込み）${skipped.length} 本: ${skipped.join(", ")}`);
  }

  const thumb = createThumbnailer(renderer, loadModel);
  shelf = new Shelf({
    catalog,
    thumb,
    onSelect: (kind) => selectKind(kind),
    onCycle: () => {
      placementIdx++;
      void updateGhost();
    },
    // 選んだ端に継げないものは灰色にする。端が無ければ全部使える
    iconOfProp: (id) => thumb.object(`prop:${id}`, async () => buildProp(propsLayer.defOf(id)!)),
    iconOfTrain: (id) =>
      thumb.object(`train:${id}`, async () => {
        const t = await Train.create(base, await loadTrainDef(base, id));
        t.layOutStraight();
        return t.root;
      }),
    props: () => propsLayer.defs.map((d) => ({ id: d.id, label: d.label })),
    heldProp: () => propsLayer.kind,
    onProp: (id) => holdProp(id),
    trains: () => [...$<HTMLSelectElement>("train").options].map((o) => ({ id: o.value, label: o.textContent || o.value })),
    currentTrain: () => $<HTMLSelectElement>("train").value,
    onTrain: (id) => {
      $<HTMLSelectElement>("train").value = id;
      setShelfOpen(false);
      void showTrain(true);
    },
    onAddTrain: (id) => {
      holdTrain(id, "add");
    },
    available: (kind) => isPartAvailable(kind),
  });
  buildQuickBar();

  minimap = new Minimap($<HTMLCanvasElement>("minimapCanvas"));

  const courseSelect = $<HTMLSelectElement>("course");
  const sampleNames = bundle.courses;
  /** 「新しいコース」・手本・保存したコースの順に選択肢を並べ直す */
  const fillCourses = (select?: string) => {
    courseSelect.length = 0;
    courseSelect.add(new Option("新しいコース", ""));
    for (const n of sampleNames) courseSelect.add(new Option(n, n));
    for (const n of savedNames()) courseSelect.add(new Option(`★ ${n}`, `saved:${n}`));
    if (select !== undefined) courseSelect.value = select;
  };
  fillCourses();
  courseSelect.addEventListener("change", async () => {
    const v = courseSelect.value;
    if (v.startsWith("saved:")) {
      const saved = loadSaved(v.slice(6));
      if (!saved) return toast("保存したコースが読めません");
      course = JSON.parse(JSON.stringify(saved)) as CourseSave;
      $<HTMLInputElement>("saveName").value = v.slice(6);
      await startCourse();
    } else if (v) await openCourse(v);
    else await newCourse();
  });

  const saveNameInput = $<HTMLInputElement>("saveName");
  $("save").onclick = () => {
    const name = saveNameInput.value.trim();
    if (!name || !course) return toast("保存する名前を入れてください");
    syncCourseTrains();
    if (!saveCourse(name, JSON.parse(JSON.stringify(course)) as CourseSave)) return toast("保存できませんでした");
    fillCourses(`saved:${name}`);
    toast(`「${name}」を保存しました`);
  };
  $("export").onclick = () => {
    if (!course) return;
    syncCourseTrains();
    downloadCourse(saveNameInput.value.trim() || "コース", course);
  };
  const importFile = $<HTMLInputElement>("importFile");
  $("import").onclick = () => importFile.click();
  importFile.addEventListener("change", async () => {
    const file = importFile.files?.[0];
    importFile.value = "";
    if (!file) return;
    const parsed = parseCourse(await file.text(), catalog);
    if (typeof parsed === "string") return toast(`開けません: ${parsed}`);
    course = parsed;
    saveNameInput.value = file.name.replace(/\.json$/i, "");
    courseSelect.value = "";
    await startCourse();
  });

  const trainSelect = $<HTMLSelectElement>("train");
  for (const def of bundle.trains) {
    if (def.id.startsWith("Advance")) continue;
    trainSelect.add(new Option(def.label || def.id, def.id));
  }
  trainSelect.value = "CommuterCream";
  trainSelect.addEventListener("change", () => void showTrain(true));
  $("addTrain").onclick = () => holdTrain(trainSelect.value, "add");
  $("moveTrain").onclick = () => {
    if (train) holdTrain(train.def.id, "move");
  };
  $("menuNextTrain").onclick = () => nextTrain();
  $("removeTrain").onclick = () => removeCurrentTrain();
  $("placeTrainHere").onclick = () => {
    if (selectedPiece === null) return;
    const idx = selectedPiece;
    const id = trainSelect.value || "CommuterCream";
    holdTrain(id, "add");
    trainAim = { piece: idx, candIdx: 0 };
    void updateTrainGhost();
  };

  const guideList = $("guideList");
  for (const [k, v] of GUIDE) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    guideList.append(dt, dd);
  }
  const togglePanel = (id: string) => {
    const el = $(id);
    const willOpen = !el.classList.contains("open");
    closePopups();
    if (willOpen) el.classList.add("open");
  };
  $("menu").onclick = () => togglePanel("menuPanel");
  $("guide").onclick = () => togglePanel("guidePanel");
  $("undo").onclick = () => void undo();
  $("remove").onclick = () => void deletePiece();
  $("branchLeft").onclick = () => void branchPiece("PointLeft");
  $("branchRight").onclick = () => void branchPiece("PointRight");
  $("openReplace").onclick = () => setShelfOpen(true);
  $("moreBtn").onclick = () => $("moreMenu").classList.toggle("open");
  $("pieceClose").onclick = () => {
    if (selectedPiece !== null) selectPiece(selectedPiece);
  };
  $("toggleShelf").onclick = () => setShelfOpen(true);
  $("closeShelf").onclick = () => setShelfOpen(false);

  // かんたんモードの操作ボタン
  $("styleEasy").onclick = () => setBuildStyle("easy");
  $("styleParts").onclick = () => setBuildStyle("parts");
  $("toEasyBtn").onclick = () => setBuildStyle("easy");
  $("easyLevUp").onclick = () => {
    easyLevel = Math.min(4, easyLevel + 1);
    updateEasyUi();
  };
  $("easyLevDown").onclick = () => {
    easyLevel = Math.max(0, easyLevel - 1);
    updateEasyUi();
  };
  $("easyCloseLoop").onclick = () => triggerEasyAutoClose();
  $("easyAddTrain").onclick = () => void autoAddRandomTrain();
  $("easyTrainHere").onclick = () => {
    if (selectedPiece === null) return;
    const idx = selectedPiece;
    const id = trainSelect.value || "CommuterCream";
    holdTrain(id, "add");
    trainAim = { piece: idx, candIdx: 0 };
    void updateTrainGhost();
  };
  $("easyDelete").onclick = () => void deletePiece();
  $("easyPieceCancel").onclick = () => easySelectPiece(null);

  const rotateEasyStart = (steps: number) => {
    if (!course || !easyStartAim) return;
    freeTheta += (steps * Math.PI) / 4;
    const plans = planMatTap(catalog, course.pieces, open, null, easyStartAim[0], easyStartAim[1], easyLevel, freeTheta, railHalfWidth());
    if (plans.length) showEasyPlans(plans, easyStartAim);
  };

  $("placeConfirm").onclick = () => {
    if (trainGhost) void confirmTrainPlace();
    else if (buildStyle === "easy" && easyPlans.length > 0) void confirmEasyPlan();
    else if (ghost && ghostPiece) void confirmPlace();
    else if (propsLayer.kind && propsLayer.aimAt) confirmProp();
  };
  $("placeRotate").onclick = () => {
    if (trainHand && trainAim) {
      trainAim.candIdx++;
      void updateTrainGhost();
    } else if (buildStyle === "easy" && easyPlans.length > 0) {
      const cur = easyPlans[easyPlanIdx]!;
      if (cur.kind === "start") rotateEasyStart(1);
      else if (easyPlans.length > 1) {
        easyPlanIdx = (easyPlanIdx + 1) % easyPlans.length;
        void renderEasyGhost();
      }
    } else if (propsLayer.kind || propsLayer.picked !== null) propsLayer.turn(1);
    else if (selectedKind && !selectedEnd) turnFree(1);
    else {
      placementIdx++;
      void updateGhost();
    }
  };
  $("placeCancel").onclick = () => {
    holdTrain(null);
    clearEasyPlan();
    easyBranchSource = null;
    refreshBranchHints();
    freeAim = null;
    selectedKind = null;
    shelf.select(null);
    void updateGhost();
    selectEnd(null);
    if (propsLayer.kind || propsLayer.picked !== null) {
      propsLayer.clearHand();
      shelf.redraw();
    }
    refreshQuickBar();
    updateEasyUi();
  };

  $("nextTrain").onclick = () => nextTrain();
  $("pickSpan").onclick = () => {
    $("moreMenu").classList.remove("open");
    spanPicking = true;
    toast("区間の終わりの部品をタップしてください");
  };
  $("levUp").onclick = () => {
    freeLevel += 1;
    void updateGhost();
  };
  $("levDown").onclick = () => {
    freeLevel = Math.max(0, freeLevel - 1);
    void updateGhost();
  };
  $("copyUp").onclick = () => {
    $("moreMenu").classList.remove("open");
    void copyIslandUp();
  };
  $("copyNext").onclick = () => {
    $("moreMenu").classList.remove("open");
    void copyContinue();
  };
  $("liftUp").onclick = () => void liftIsland(1);
  $("liftDown").onclick = () => void liftIsland(-1);
  $("tunnel").onclick = () => {
    $("moreMenu").classList.remove("open");
    void toggleWorn("Tunnel");
  };
  $("bridge").onclick = () => {
    $("moreMenu").classList.remove("open");
    void toggleWorn("Bridge");
  };
  $("modeSwitch").onclick = () => setMode(mode === "build" ? "drive" : "build");

  $("go").addEventListener("click", () => {
    running = !running;
    if (running && speed === 0) speed = train?.def.presetSpeed ?? 4;
    applySpeed();
  });
  // 向きを反転する。止まっている間は前進の既定速度から始める
  $("reverse").addEventListener("click", () => setSpeed(speed === 0 ? -(train?.def.presetSpeed ?? 4) : -speed));
  $("speed").addEventListener("input", (e) => setSpeed(Number((e.target as HTMLInputElement).value)));

  addEventListener("keydown", (e) => {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
    const step = train?.def.speedStep ?? 1;
    if (e.code === "Tab") {
      e.preventDefault();
      $("modeSwitch").click();
    } else if (e.code === "F1") {
      e.preventDefault();
      togglePanel("guidePanel");
    } else if (mode === "build") {
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") {
        e.preventDefault();
        void undo();
      } else if (e.code === "Enter") {
        if (trainGhost) void confirmTrainPlace();
        else if (buildStyle === "easy" && easyPlans.length > 0) void confirmEasyPlan();
        else if (ghost && ghostPiece) void confirmPlace();
        else if (propsLayer.kind && propsLayer.aimAt) confirmProp();
      } else if (e.code === "KeyQ" || e.code === "KeyE") {
        const step = e.code === "KeyQ" ? -1 : 1;
        if (buildStyle === "easy" && easyPlans.length > 0) {
          if (easyPlans[easyPlanIdx]!.kind === "start") rotateEasyStart(step);
          else if (easyPlans.length > 1) {
            easyPlanIdx = (easyPlanIdx + step + easyPlans.length) % easyPlans.length;
            void renderEasyGhost();
          }
        } else if (propsLayer.kind || propsLayer.picked !== null) propsLayer.turn(step);
        else turnFree(step);
      } else if (e.code === "PageUp" || e.code === "PageDown") {
        const delta = e.code === "PageUp" ? 1 : -1;
        if (buildStyle === "easy") {
          easyLevel = Math.min(4, Math.max(0, easyLevel + delta));
          updateEasyUi();
        } else {
          freeLevel = Math.max(0, freeLevel + delta);
          void updateGhost();
        }
      } else if (e.code === "Escape") {
        holdTrain(null);
        clearEasyPlan();
        easyBranchSource = null;
        refreshBranchHints();
        setShelfOpen(false);
        closePopups();
        freeAim = null;
        selectedKind = null;
        shelf.select(null);
        void updateGhost();
        selectEnd(null);
        if (selectedPiece !== null) selectPiece(selectedPiece);
        if (propsLayer.kind || propsLayer.picked !== null) {
          propsLayer.clearHand();
          shelf.redraw();
        }
        refreshQuickBar();
        updateEasyUi();
      } else if (e.code === "Delete" || e.code === "Backspace") {
        if (propsLayer.picked !== null) deleteProp();
        else void deletePiece();
      } else if (e.code === "KeyC") {
        if (buildStyle === "easy" && easyPlans.length > 0) {
          if (easyPlans[easyPlanIdx]!.kind === "start") rotateEasyStart(1);
          else if (easyPlans.length > 1) {
            easyPlanIdx = (easyPlanIdx + 1) % easyPlans.length;
            void renderEasyGhost();
          }
        } else {
          placementIdx++;
          void updateGhost();
        }
      }
    } else if (e.code === "Space") {
      e.preventDefault();
      $("go").click();
    } else if (e.code === "KeyR") $("reverse").click();
    else if (e.code === "KeyN") nextTrain();
    else if (e.code === "ArrowUp") setSpeed(speed + step);
    else if (e.code === "ArrowDown") setSpeed(speed - step);
  });

  setMode("build");
  const initialName = bundle.initialCourseName ?? "定番レイアウト1";
  courseSelect.value = initialName;
  if (bundle.initialCourse) {
    course = JSON.parse(JSON.stringify(bundle.initialCourse)) as CourseSave;
    await startCourse();
  } else {
    await openCourse(initialName);
  }
  const tReady = performance.now();
  (window as unknown as { __app: Record<string, unknown> }).__app.timing = {
    startMs: Math.round(t0),
    bundleMs: Math.round(tBundle - t0),
    sceneryMs: Math.round(tScenery - t0),
    courseMs: Math.round(tReady - Math.max(tScenery, tBundle)),
    readyMs: Math.round(tReady),
  };
  const loading = document.getElementById("loading");
  if (loading) {
    loading.classList.add("hide");
    setTimeout(() => loading.remove(), 300);
  }
  // 初回表示が終わってからクイックバーのアイコンを裏で生成する
  setTimeout(() => loadQuickBarThumbs(thumb), 0);
}
main().catch((err) => {
  console.error(err);
  const msg = document.getElementById("loadingMsg");
  if (msg) msg.textContent = "読み込みに失敗しました。ページを再読み込みするか、WebGL 対応ブラウザでお試しください。";
});

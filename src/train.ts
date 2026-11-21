// 車両。編成は json の consist が決め、車体は前後のガイドで経路に沿わせる
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import type { Route } from "./route";
import { toStandard } from "./scenery";

export interface ConsistEntry {
  model: string;
  repeat?: boolean;
  flip?: boolean;
}

export interface TrainDef {
  id: string;
  label: string;
  model: string;
  cars?: number;
  consist?: ConsistEntry[];
  couplingGap?: number;
  presetSpeed: number;
  speedStep?: number;
  maxSpeed: number;
  acceleration: number;
  /** TPS カメラの後方・上方（m） */
  cameraTpsBack: number;
  cameraTpsUp: number;
  /** 進行方向を測る接線の幅（m） */
  cameraTangentSpan?: number;
}

export async function loadTrainIds(base: string): Promise<string[]> {
  return (await fetch(`${base}data/trains.json`)).json();
}

export async function loadTrainDef(base: string, id: string): Promise<TrainDef> {
  return (await fetch(`${base}data/Trains/${id}/${id}.json`)).json();
}

const fbx = new FBXLoader();
const cache = new Map<string, Promise<THREE.Group>>();
const loadFbx = (url: string) => {
  let p = cache.get(url);
  if (!p) cache.set(url, (p = fbx.loadAsync(url)));
  return p;
};

/** consist を cars 両へ伸ばす。repeat の欄が増え、書いた形より短くはならない */
export function expandConsist(def: TrainDef): ConsistEntry[] {
  const base: ConsistEntry[] = def.consist?.length ? def.consist : [{ model: def.model, repeat: true }];
  const want = Math.max(def.cars ?? base.length, base.length);
  const out: ConsistEntry[] = [];
  const extra = want - base.length;
  for (const e of base) {
    if (e.repeat) for (let i = 0; i <= extra; i++) out.push(e);
    else out.push(e);
  }
  return out;
}

interface Car {
  group: THREE.Group;
  /** 前後ガイド（車輪）の間隔（m）。経路に乗るのはここ */
  span: number;
  /** 車体の半長（m）。鼻と尻はガイドの先へ張り出す。間隔はこちらで積む */
  half: number;
  /** 先頭車の中心から、この車の中心までの後ろ向きの距離 */
  offset: number;
  /** 運転席カメラの位置（FBX の `Cab_Camera`）。描かないが行列は持つ */
  cab: THREE.Object3D | null;
}

/**
 * 車体の塗装。クリアコートで窓と車体に艶（空と部屋の映り込み）を乗せ、地の色を少し持ち上げる。
 * Unity の材質値は灰色に沈むので、そのまま使うと web 版では鈍く見える
 */
function carPaint(m: THREE.Material): THREE.Material {
  const base = toStandard(m, 0.45, 0.9) as THREE.MeshStandardMaterial;
  const paint = new THREE.MeshPhysicalMaterial({
    color: base.color.clone().multiplyScalar(1.35),
    map: base.map,
    roughness: 0.4,
    metalness: 0.05,
    clearcoat: 0.6,
    clearcoatRoughness: 0.22,
    envMap: base.envMap,
    envMapIntensity: 1.0,
    side: base.side,
    transparent: base.transparent,
    opacity: base.opacity,
  });
  paint.name = base.name;
  return paint;
}

export class Train {
  /** 先頭の前ガイドの道のり */
  s = 0;
  speed = 0;
  target = 0;
  private cars: Car[] = [];
  private gap = 0.15;

  constructor(
    readonly def: TrainDef,
    readonly root: THREE.Group,
  ) {
    this.gap = def.couplingGap ?? 0.15;
    this.target = def.presetSpeed;
  }

  static async create(base: string, def: TrainDef): Promise<Train> {
    const root = new THREE.Group();
    const train = new Train(def, root);
    for (const entry of expandConsist(def)) {
      const src = await loadFbx(`${base}data/${entry.model}.fbx`);
      const model = src.clone();
      // レールと同じく、FBX は cm・右手系。0.01 倍して x を反転する
      model.scale.set(-0.01, 0.01, 0.01);
      const guide = (name: string) => model.getObjectByName(name)?.position;
      const front = guide("Train_FrontGuide");
      const rear = guide("Train_RearGuide");
      if (!front || !rear) throw new Error(`${entry.model}: Train_FrontGuide / Train_RearGuide が無い`);
      const span = Math.abs(rear.z - front.z) * 0.01;
      model.traverse((o) => {
        // 目印の空オブジェクトは描かない
        if (o.type === "Group" && o !== model) o.visible = false;
        // 光に反応する素材へ。絵は sRGB で読む。車体は影を落とすが受けない（縞が出るため。Unity 版と同じ）
        if (o instanceof THREE.Mesh) {
          o.material = Array.isArray(o.material) ? o.material.map(carPaint) : carPaint(o.material);
          o.castShadow = true;
          o.receiveShadow = false;
        }
      });
      const cab = model.getObjectByName("Cab_Camera") ?? null;
      const holder = new THREE.Group();
      if (entry.flip) holder.rotation.y = Math.PI;
      holder.add(model);
      const group = new THREE.Group();
      group.add(holder);
      root.add(group);
      // 車体の長さは見た目の外形から測る（ガイドではない）
      group.updateMatrixWorld(true);
      const body = new THREE.Box3().setFromObject(model);
      const half = (body.max.z - body.min.z) / 2;
      const prev = train.cars.at(-1);
      // 中心どうしの間隔 = 前の車の半長 + 連結の隙間 + この車の半長（Unity の `SetupConsist` と同じ）
      const offset = prev ? prev.offset + prev.half + train.gap + half : 0;
      train.cars.push({ group, span, half, offset, cab });
    }
    return train;
  }

  /** 先頭車の中心から最後尾の車の中心まで（カメラを引く量に使う） */
  get tailOffset() {
    return this.cars.at(-1)?.offset ?? 0;
  }

  /** 先頭車の前後ガイドの間隔 */
  get headSpan() {
    return this.cars[0]?.span ?? 0;
  }

  /** 先頭の前ガイドから最後尾の後ろガイドまで。これより短い線には置けない */
  get length() {
    const last = this.cars.at(-1);
    return this.headSpan + this.tailOffset + (last ? last.span / 2 - (this.cars[0]?.span ?? 0) / 2 : 0);
  }

  /** 棚の絵のために、まっすぐ並べる。先頭が原点、後ろの車は +z へ */
  layOutStraight() {
    for (const car of this.cars) {
      car.group.position.set(0, 0, car.offset);
      car.group.quaternion.identity();
    }
  }

  /** 先頭を道のり s に置く（開いたルートでは全体が収まる位置へ） */
  place(route: Route, s: number) {
    this.s = s;
    this.apply(route);
  }

  update(route: Route, dt: number) {
    const a = this.def.acceleration * dt;
    this.speed += Math.max(-a, Math.min(a, this.target - this.speed));
    this.s += this.speed * dt;
    // 線の端で止まる。開いた線は両端、投げ縄は手前の端だけ（輪は周回する）。後退でも尻が線から出ない
    const lap = route.length - route.loopStart;
    const pureLoop = route.closed && route.loopStart === 0;
    if (!route.closed) this.s = Math.min(this.s, route.length);
    if (!pureLoop && this.s < this.length) {
      this.s = this.length;
      if (this.speed < 0) this.speed = 0;
    }
    if (!route.closed && this.s >= route.length && this.speed > 0) this.speed = 0;
    // 周回は s を溜めずに畳む。長く走って浮動小数の精度が落ちないように
    if (route.closed && this.s > route.length * 2) this.s -= lap;
    else if (pureLoop && this.s < -route.length) this.s += lap;
    this.apply(route);
  }

  /** 後退しているか（速度が負、または止まっていて目標が負） */
  get reversing() {
    return this.speed < 0 || (this.speed === 0 && this.target < 0);
  }

  /** 進む向きの先頭車の運転席カメラ。後退中は後尾車（鼻が逆を向いている） */
  get activeCab(): THREE.Object3D | null {
    return (this.reversing ? this.cars.at(-1)?.cab : this.cars[0]?.cab) ?? null;
  }

  /** 進む向きの先頭車の中心の道のりと、その車のガイド間隔 */
  get leadCentre() {
    return this.reversing ? this.s - this.length + this.leadSpan / 2 : this.s - this.headSpan / 2;
  }

  get leadSpan() {
    return (this.reversing ? this.cars.at(-1)?.span : this.cars[0]?.span) ?? 0;
  }

  /** 進む向きの先頭の道のり。後退中は後尾の後ろガイド */
  get leadS() {
    return this.reversing ? this.s - this.length : this.s;
  }

  private apply(route: Route) {
    // 先頭の前ガイドが s。先頭車の中心はそこから半スパン後ろ、他の車は offset ぶん後ろ
    const lead = this.s - this.headSpan / 2;
    const up = new THREE.Vector3(0, 1, 0);
    for (const car of this.cars) {
      const centre = lead - car.offset;
      const f = route.at(centre + car.span / 2);
      const r = route.at(centre - car.span / 2);
      const pf = new THREE.Vector3(f.x, f.y, f.z);
      const pr = new THREE.Vector3(r.x, r.y, r.z);
      // 位置は前後ガイドの中点。進行方向は後ろから前へ。局所の前方は -z
      car.group.position.copy(pf).add(pr).multiplyScalar(0.5);
      const forward = pf.clone().sub(pr).normalize();
      const zAxis = forward.clone().negate();
      const xAxis = up.clone().cross(zAxis).normalize();
      const yAxis = zAxis.clone().cross(xAxis);
      car.group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));
    }
  }
}

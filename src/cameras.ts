// カメラ3種。自由（周回）/ 追従（TPS）/ 運転席。Unity の座標を three の世界へ移して使う
import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Route } from "./route";
import type { Train } from "./train";

export type CameraMode = "free" | "tps" | "cab";

/** Unity の座標 → three の世界（world グループの x 反転と同じ） */
const toThree = (p: { x: number; y: number; z: number }) => new THREE.Vector3(-p.x, p.y, p.z);

export class CameraRig {
  mode: CameraMode = "free";

  constructor(
    private camera: THREE.PerspectiveCamera,
    private controls: OrbitControls,
  ) {}

  set(mode: CameraMode) {
    this.mode = mode;
    this.controls.enabled = mode === "free";
  }

  update(route: Route | null, train: Train | null) {
    if (this.mode === "free" || !route || !train) return;
    if (this.mode === "tps") {
      // 先頭車の真後ろへ直線で引く。道のりで引くと、急なカーブで編成の真横に回り込む。
      // 編成が長いぶんは後方に 0.6 倍・上方に 0.3 倍だけ足す（Unity と同じ）
      // 後退中は後尾が先頭。進む向き（dir）で前後を入れ替える
      const dir = train.reversing ? -1 : 1;
      const span = train.def.cameraTangentSpan ?? 4;
      const nose = toThree(route.at(train.leadS));
      const forward = nose.clone().sub(toThree(route.at(train.leadS - dir * span)));
      forward.y = 0;
      forward.normalize();
      const extra = train.tailOffset;
      const back = train.def.cameraTpsBack + extra * 0.6;
      const up = train.def.cameraTpsUp + extra * 0.3;
      const look = toThree(route.at(train.leadCentre));
      this.camera.position.copy(nose).addScaledVector(forward, -back).add(new THREE.Vector3(0, up, 0));
      this.controls.target.copy(look);
      this.camera.lookAt(look);
    } else {
      // 前面展望（運転席）: 進む向きの先頭から、目の前の線路を少し見下ろす角度（Unity 版と同じ forward*13 - up*0.65）
      const dir = train.reversing ? -1 : 1;
      const cab = train.activeCab;
      let eye: THREE.Vector3;
      let forward: THREE.Vector3;
      if (cab) {
        eye = cab.getWorldPosition(new THREE.Vector3());
        // FBX の前方は -z（100 = 1m、model.scale 0.01 倍のため）
        const aheadLocal = cab.localToWorld(new THREE.Vector3(0, 0, -100));
        forward = aheadLocal.sub(eye).normalize();
      } else {
        // 後尾車に Cab_Camera が無い車両（Express 後退時など）のフォールバック
        const nose = toThree(route.at(train.leadS));
        const back = toThree(route.at(train.leadS - dir * 1.5));
        forward = nose.clone().sub(back).normalize();
        eye = nose.add(new THREE.Vector3(0, train.def.cameraCabUp ?? 0.95, 0));
      }
      const look = eye.clone().addScaledVector(forward, 13).add(new THREE.Vector3(0, -0.65, 0));
      this.camera.position.copy(eye);
      this.camera.lookAt(look);
      this.controls.target.copy(look);
    }
  }
}

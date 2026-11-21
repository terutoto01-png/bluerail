// 背景・光・材質。値は Unity 版（Windowlight.cs / Mat.cs / Room.cs / Skies/Day.json / UiPalette.json）と同じ
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { addOutdoors } from "./outdoors";

/** 色（UiPalette.json の windowlight.* と room.*） */
const C = {
  lightMain: 0xfff0da,
  lightFill: 0xe0ebf9,
  lightSky: 0x899eaf,
  lightBounce: 0x777d80,
  lightGround: 0x827360,
  floorSurface: 0xac8d6b,
  floorJoint: 0x9f805f,
  rugSurface: 0xc0b9a4,
  rugBinding: 0xb7ac91,
  wallpaper: 0xb8b5a7,
  zenith: 0x3f8fd8,
  horizon: 0x8ad1f7,
  ground: 0x4a5a48,
};

/** Unity 版の1ユニット = 36mm。家具の寸法を玩具の世界に合わせる */
const UNITS_PER_METRE = 1 / 0.036;
/** 玄関の土間の奥行と、床との段差（上がり框。約 16cm） */
const DOMA_LENGTH = 25;
const STEP_UP = 4.5;

/** Unity の Euler（度）が向ける前方ベクトルを three の世界（x 反転）で返す */
function forwardOf(xDeg: number, yDeg: number): THREE.Vector3 {
  const e = new THREE.Euler(THREE.MathUtils.degToRad(xDeg), THREE.MathUtils.degToRad(yDeg), 0, "YXZ");
  const f = new THREE.Vector3(0, 0, 1).applyEuler(e);
  return new THREE.Vector3(-f.x, f.y, f.z);
}

// --- 床とマット ---

/**
 * 512px の模様。Unity の `WindowlightSurfaceTexture` と同じ式。
 * 板は縦に4段、段ごとに半分ずらした継ぎ目。布は細かい織り目
 */
function surfaceTexture(surface: number, joint: number, fabric: boolean): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const base = new THREE.Color(surface);
  const seam = new THREE.Color(joint);
  const px = (c: number) => Math.round(THREE.MathUtils.clamp(c, 0, 1) * 255);
  // three の Color は線形。画像は sRGB で持つので、変換して書く
  const baseS = base.clone().convertLinearToSRGB();
  const seamS = seam.clone().convertLinearToSRGB();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const detail = fabric
        ? 0.012 * Math.sin(u * Math.PI * 32) * Math.sin(v * Math.PI * 32)
        : 0.008 * Math.sin(v * Math.PI * 18 + Math.sin(u * Math.PI * 2) * 0.4) + 0.01 * Math.sin(v * Math.PI * 8);
      const onSeam = !fabric && (y % 128 < 3 || (x + (Math.floor(y / 128) % 2) * 256) % 512 < 3);
      const c = onSeam ? seamS : baseS;
      const k = onSeam ? 1 : 1 + detail;
      const i = (y * size + x) * 4;
      img.data[i] = px(c.r * k);
      img.data[i + 1] = px(c.g * k);
      img.data[i + 2] = px(c.b * k);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/** 居間の木の床。部屋の大きさが決まってから、その広さへ縮める（外は庭の芝生になる） */
let floorMesh: { floor: THREE.Mesh; tex: THREE.Texture } | null = null;

function fitFloorToRoom(width: number, depth: number) {
  if (!floorMesh) return;
  floorMesh.floor.geometry.dispose();
  floorMesh.floor.geometry = new THREE.PlaneGeometry(width, depth);
  floorMesh.tex.repeat.set(width / 24, depth / 12.8);
}

function addFloor(scene: THREE.Scene) {
  const span = 400;
  const tex = surfaceTexture(C.floorSurface, C.floorJoint, false);
  // 1周期 = 24 × 12.8 ユニット（板の長さ × 4段）
  tex.repeat.set(span / 24, span / 12.8);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(span, span),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.78, envMapIntensity: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.04;
  floor.receiveShadow = true;
  scene.add(floor);
  floorMesh = { floor, tex };

  // マット: 縁取りの上に布を重ねる。どちらもレール面より下
  const rug = new THREE.Group();
  const [w, d] = [40, 32];
  const binding = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshStandardMaterial({ color: C.rugBinding, roughness: 1, envMapIntensity: 0 }),
  );
  binding.rotation.x = -Math.PI / 2;
  binding.position.y = -0.025;
  const weave = surfaceTexture(C.rugSurface, C.rugSurface, true);
  weave.repeat.set((w - 0.35) / 2, (d - 0.35) / 2);
  const fabric = new THREE.Mesh(
    new THREE.PlaneGeometry(w - 0.35, d - 0.35),
    new THREE.MeshStandardMaterial({ map: weave, roughness: 0.94, envMapIntensity: 0 }),
  );
  fabric.rotation.x = -Math.PI / 2;
  fabric.position.y = -0.018;
  for (const m of [binding, fabric]) m.receiveShadow = true;
  rug.add(binding, fabric);
  scene.add(rug);
}

// --- 空 ---

function addSky(scene: THREE.Scene) {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      zenith: { value: new THREE.Color(C.zenith) },
      horizon: { value: new THREE.Color(C.horizon) },
      ground: { value: new THREE.Color(C.ground) },
    },
    vertexShader: "varying vec3 d; void main(){ d = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }",
    fragmentShader: `varying vec3 d; uniform vec3 zenith; uniform vec3 horizon; uniform vec3 ground;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p){
        vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      float fbm(vec2 p){ float a = 0.5; float s = 0.0; for (int i = 0; i < 4; i++){ s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
      void main(){
        float h = d.y;
        vec3 sky = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.6));
        // 雲。空を平面へ写して、ゆるい塊の濃淡を出す。地平に近いほど薄く、天頂でも途切れる
        vec2 uv = d.xz / (h + 0.3) * 1.3;
        float cloud = smoothstep(0.50, 0.80, fbm(uv + vec2(3.7, 1.3))) * smoothstep(0.02, 0.22, h);
        sky = mix(sky, vec3(1.0, 1.0, 0.99), cloud * 0.8);
        vec3 c = h >= 0.0 ? sky : mix(horizon, ground, clamp(-h * 4.0, 0.0, 1.0));
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(900, 24, 16), material);
  dome.renderOrder = -1;
  scene.add(dome);
  return dome;
}

// --- 光 ---

export interface Lights {
  sun: THREE.DirectionalLight;
  /** 影を落とす範囲を、置かれたものが入る大きさに合わせる */
  fitShadow(box: THREE.Box3): void;
}

function addLights(scene: THREE.Scene): Lights {
  // 昼（Skies/Day.json）。物理単位の three は Unity の強度の π 倍で同じ明るさになる
  const sun = new THREE.DirectionalLight(C.lightMain, 1.4 * Math.PI);
  const sunDir = forwardOf(32, 145);
  sun.userData.dir = sunDir;
  sun.castShadow = true;
  const shadowSize = matchMedia("(pointer: coarse)").matches ? 2048 : 4096;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  sun.shadow.radius = 3;
  // Unity の shadowStrength（Day.json）。影を真っ暗にせず、環境光で薄く残す
  sun.shadow.intensity = 0.55;
  scene.add(sun, sun.target);

  const fill = new THREE.DirectionalLight(C.lightFill, 0.65 * Math.PI);
  const fillDir = forwardOf(22, 325);
  fill.position.copy(fillDir).multiplyScalar(-100);
  scene.add(fill);

  // 三方向の環境光。空・水平・地面
  const ambient = new THREE.HemisphereLight(C.lightSky, C.lightGround, 0.9 * Math.PI);
  scene.add(ambient);

  return {
    sun,
    fitShadow(box) {
      const centre = box.getCenter(new THREE.Vector3());
      const r = Math.min(120, Math.max(24, box.getSize(new THREE.Vector3()).length() / 2 + 6));
      sun.target.position.copy(centre);
      sun.position.copy(centre).addScaledVector(sunDir, -(r + 60));
      const cam = sun.shadow.camera;
      cam.left = cam.bottom = -r;
      cam.right = cam.top = r;
      cam.near = 1;
      cam.far = r * 2 + 140;
      cam.updateProjectionMatrix();
      sun.target.updateMatrixWorld();
    },
  };
}

// --- 部屋 ---

interface Wall {
  object: THREE.Object3D;
  /** 外向きの法線（three の世界）と、そこまでの距離。カメラがこの外へ出たら壁を消す */
  outward: THREE.Vector3;
  boundary: number;
}

/**
 * 奥の窓のカーテン。窓の開口は幅 0.374・高さ 0.664（壁のパネルが 1.00 × 1.29）で、床から 0.393 の高さ。
 * 左右に2枚、ひだは正弦で揺らして陰影を出す。レールは窓の前に吊る
 */
function addCurtains(room: THREE.Group, k: number) {
  const openingHalf = (0.374 * k) / 2;
  const width = 13;
  const height = 56;
  const rodY = 58;
  const z = -62.2; // 壁の内側の面（-65 + 厚みの半分）から少し手前
  const wood = new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.8, envMapIntensity: 0 });
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, openingHalf * 2 + width * 2 + 4, 8), wood);
  rod.rotation.z = Math.PI / 2;
  rod.position.set(0, rodY, z);
  room.add(rod);
  for (const side of [-1, 1]) {
    const finial = new THREE.Mesh(new THREE.SphereGeometry(1.1, 10, 8), wood);
    finial.position.set(side * (openingHalf + width + 2), rodY, z);
    room.add(finial);

    const geometry = new THREE.PlaneGeometry(width, height, 36, 1);
    const pos = geometry.attributes.position!;
    const colors: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      const fold = Math.sin((pos.getX(i) / width) * Math.PI * 7);
      pos.setZ(i, fold * 0.9);
      const shade = 0.9 + 0.1 * fold; // ひだの山が明るく、谷が暗い
      colors.push(shade, shade, shade);
    }
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    const drape = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: 0xf0d9a8, vertexColors: true, roughness: 1, side: THREE.DoubleSide, envMapIntensity: 0 }),
    );
    // 開口の外側へ寄せて吊る。内側の端が開口に少しかかる
    drape.position.set(side * (openingHalf + width / 2 - 3.5), rodY - 0.5 - height / 2, z);
    drape.castShadow = false;
    drape.receiveShadow = true;
    room.add(drape);
  }
}

/** 障子の紙。白い和紙に細い桟（格子）。奥が透けるほどは薄くしない */
function shojiTexture(cols: number, rows: number): THREE.CanvasTexture {
  const w = 256;
  const h = 512;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#f4efe2";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#8a6a4a";
  ctx.lineWidth = 6;
  for (let i = 0; i <= cols; i++) {
    const x = (w / cols) * i;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let j = 0; j <= rows; j++) {
    const y = (h / rows) * j;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.lineWidth = 14; // 外枠
  ctx.strokeRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 襖の紙。灰みの白に縁取りと、控えめな横の帯 */
function fusumaTexture(): THREE.CanvasTexture {
  const w = 256;
  const h = 512;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#e9e0c8";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#d8cdb0";
  ctx.fillRect(0, h * 0.62, w, h * 0.16); // 絵の帯の代わり
  ctx.fillStyle = "#c6b99a";
  ctx.fillRect(0, h * 0.7, w, 4);
  ctx.strokeStyle = "#2b2623"; // 黒漆の縁
  ctx.lineWidth = 16;
  ctx.strokeRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 畳の部屋の障子（奥の窓の内側）と襖（居間との開口）。
 * 窓の開口は壁のパネルの 幅 0.374・高さ 0.664・床から 0.393。襖は片側だけ閉めて、残りは開けておく
 */
function addJapaneseDoors(room: THREE.Group, d: { k: number; half: number; z0: number; panel: number; tatamiEnd: number }) {
  // 障子: 奥の壁の窓。紙は少し光って見えるよう発光を足す（外の明るさ）
  const width = 0.374 * d.k;
  const height = 0.664 * d.k;
  const shoji = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshStandardMaterial({
      map: shojiTexture(3, 6),
      emissive: new THREE.Color(0xfff6dc),
      emissiveMap: shojiTexture(3, 6),
      emissiveIntensity: 0.35,
      roughness: 1,
      envMapIntensity: 0,
      side: THREE.DoubleSide,
    }),
  );
  shoji.rotation.y = Math.PI / 2;
  shoji.position.set(d.tatamiEnd - 2.9, 0.393 * d.k + height / 2, d.z0);
  room.add(shoji);

  // 襖: 居間との開口（モデルの開口は幅 0.86・高さ 0.98）に収める。2枚引き。
  // 壁の面（x=half）に置き、開口の高さいっぱい。閉めた1枚は開口の半分の幅
  const openingWidth = 0.86 * d.k;
  const leafWidth = openingWidth / 2;
  const leafHeight = 0.98 * d.k;
  // 襖は閉めてある（2枚とも）。2本のレールに前後して乗るので、x を少しずらし、真ん中で少し重ねる
  const paper = new THREE.MeshStandardMaterial({ map: fusumaTexture(), roughness: 1, envMapIntensity: 0 });
  for (const side of [-1, 1]) {
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(1.4, leafHeight, leafWidth + 0.8), paper);
    leaf.position.set(d.half + side * 0.8, leafHeight / 2, d.z0 + side * (leafWidth / 2 - 0.4));
    leaf.castShadow = false;
    leaf.receiveShadow = true;
    room.add(leaf);
  }
  // 敷居（足元のレール）と鴨居（頭上のレール）。襖がレールに乗って見えるように
  const rail = new THREE.MeshStandardMaterial({ color: 0x6b4a32, roughness: 0.7, envMapIntensity: 0 });
  for (const y of [0.6, leafHeight + 0.6]) {
    const r = new THREE.Mesh(new THREE.BoxGeometry(3.6, 1.2, openingWidth), rail);
    r.position.set(d.half, y, d.z0);
    room.add(r);
  }
}

/** 部屋の半幅（側面の壁の x）。addRoom が決める */
let roomHalf = 0;

async function addRoom(scene: THREE.Scene, baseUrl: string): Promise<{ walls: Wall[]; props: THREE.Object3D[] }> {
  const loader = new GLTFLoader();
  const room = new THREE.Group();
  // Unity の座標で組み、世界と同じく x を反転して置く
  room.scale.x = -1;
  scene.add(room);
  const walls: Wall[] = [];
  const props: THREE.Object3D[] = [];

  const wallMaterial = new THREE.MeshStandardMaterial({
    color: C.wallpaper,
    roughness: 1,
    emissive: new THREE.Color(0x242722),
    emissiveIntensity: 0.4,
    envMapIntensity: 0,
  });

  const ROOM_GLBS = [
    "wallWindow",
    "wall",
    "wallDoorway",
    "wallDoorwayWide",
    "doorwayFront",
    "rugDoormat",
    "coatRack",
    "doorway",
    "wallWindowSlide",
    "tableCoffee",
    "lampRoundFloor",
    "bookcaseClosedWide",
    "cabinetTelevision",
    "televisionVintage",
    "tableRound",
    "chair",
    "sideTable",
    "lampSquareFloor",
    "lampSquareCeiling",
    "bookcaseOpen",
    "loungeSofa",
    "pottedPlant",
    "cardboardBoxOpen",
  ] as const;
  const glbCache = new Map<string, THREE.Object3D>();
  await Promise.all(
    ROOM_GLBS.map(async (id) => {
      const gltf = await loader.loadAsync(`${baseUrl}room/${id}.glb`);
      glbCache.set(id, gltf.scene);
    }),
  );

  /** 高さ wantedHeight に合わせて拡縮し、底の中心を floorPosition に置く（Unity の `AddRoomModel`） */
  function place(id: string, floorPosition: THREE.Vector3, wantedHeight: number, yawDeg: number, widthTo?: number) {
    const src = glbCache.get(id);
    if (!src) throw new Error(`未読込の部屋モデル: ${id}`);
    const model = src.clone();
    const holder = new THREE.Group();
    holder.rotation.y = THREE.MathUtils.degToRad(yawDeg);
    holder.add(model);
    model.scale.set(-1, 1, 1); // Unity の取り込みと同じ x 反転（glb も右手系）
    // glTF は +Z が前、Unity が読む FBX は −Z が前。向きの規約が逆なので 180° 回して、Unity と同じ向きにする
    model.rotation.y = Math.PI;
    holder.updateMatrixWorld(true);
    const before = new THREE.Box3().setFromObject(holder);
    const k = wantedHeight / Math.max(before.getSize(new THREE.Vector3()).y, 0.001);
    model.scale.set(-k, k, k);
    if (widthTo) {
      // 壁の幅だけ引き伸ばす（横方向のみ）
      const nowSize = new THREE.Box3().setFromObject(holder).getSize(new THREE.Vector3());
      const across = Math.abs(Math.sin(THREE.MathUtils.degToRad(yawDeg))) > 0.5 ? nowSize.z : nowSize.x;
      model.scale.x *= widthTo / Math.max(across, 0.001);
    }
    holder.updateMatrixWorld(true);
    const after = new THREE.Box3().setFromObject(holder);
    const c = after.getCenter(new THREE.Vector3());
    holder.position.set(floorPosition.x - c.x, floorPosition.y - after.min.y, floorPosition.z - c.z);
    model.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const isWall = id.startsWith("wall");
      // 家具は環境の映り込みを受けない（映り込ませるのはレールと車体だけ）
      const slots = [o.material].flat().map((m) => (isWall && m.name === "metalDark" ? wallMaterial : toStandard(m, 0.7, 0)));
      o.material = Array.isArray(o.material) ? slots : slots[0]!;
      // 壁は影を落とさない（部屋の外側が遊び場に影を落とすのを防ぐ）
      o.castShadow = !isWall;
      o.receiveShadow = true;
    });
    room.add(holder);
    // 壁は別の規則で出し入れする。家具・照明・扉は、カメラの邪魔になったら消す
    holder.name = id;
    if (!id.startsWith("wall")) props.push(holder);
    return holder;
  }

  const h = 2.4 * UNITS_PER_METRE;
  const window = place("wallWindow", new THREE.Vector3(0, 0, -65), h, 0);
  const windowHalf = new THREE.Box3().setFromObject(window).getSize(new THREE.Vector3()).x / 2;
  const half = windowHalf * 3;
  const worldDir = (x: number, z: number) => new THREE.Vector3(-x, 0, z); // Unity → three
  walls.push({ object: window, outward: worldDir(0, -1), boundary: 65 });
  addCurtains(room, h / 1.29);
  for (const side of [-1, 1]) {
    const w = place("wall", new THREE.Vector3(side * (windowHalf + windowHalf), 0, -65), h, 0, windowHalf * 2);
    walls.push({ object: w, outward: worldDir(0, -1), boundary: 65 });
  }
  const front = place("wall", new THREE.Vector3(0, 0, 65), h, 180, half * 2);
  walls.push({ object: front, outward: worldDir(0, 1), boundary: 65 });

  // --- 家: 左の壁の先に廊下と玄関、右の壁の先に畳の部屋 ---
  // 壁のパネルは幅 1.00 × 高さ 1.29（モデルの寸法）。ほかの部品も同じ倍率で並べる
  const k = h / 1.29;
  const panel = windowHalf * 2; // パネル1枚の幅（開口の幅もこれ）
  const z0 = 8; // 開口の中心
  const aperture = [z0 - panel / 2, z0 + panel / 2];
  /** 側面の壁を、開口の前後だけ伸ばした壁で埋めて、真ん中に開口のパネルを置く */
  function sideWall(x: number, yaw: number, outwardX: number, openingId: string) {
    const back = place("wall", new THREE.Vector3(x, 0, (-65 + aperture[0]!) / 2), h, yaw, aperture[0]! + 65);
    const mid = place(openingId, new THREE.Vector3(x, 0, z0), h, yaw);
    const near = place("wall", new THREE.Vector3(x, 0, (aperture[1]! + 65) / 2), h, yaw, 65 - aperture[1]!);
    for (const w of [back, mid, near]) walls.push({ object: w, outward: worldDir(outwardX, 0), boundary: half });
  }
  sideWall(-half, 90, -1, "wallDoorway");
  sideWall(half, 270, 1, "wallDoorwayWide");

  // 廊下（左）: 開口の幅のまま 70 ユニット伸ばし、突き当たりに玄関の扉
  const hallLength = 70;
  const hallEnd = -half - hallLength;
  for (const z of aperture) {
    const w = place("wall", new THREE.Vector3((-half + hallEnd) / 2, 0, z), h, 0, hallLength);
    walls.push({ object: w, outward: worldDir(0, z < z0 ? -1 : 1), boundary: Math.abs(z) });
  }
  place("wallDoorway", new THREE.Vector3(hallEnd, -STEP_UP, z0), h, 90);
  place("doorwayFront", new THREE.Vector3(hallEnd + 1, -STEP_UP, z0), 1.01 * k, 90);
  place("rugDoormat", new THREE.Vector3(hallEnd + 14, -STEP_UP + 0.03, z0), 0.012 * k, 90);
  place("coatRack", new THREE.Vector3(hallEnd + 22, 1.55 * UNITS_PER_METRE, aperture[1]! - 1), 0.28 * k, 0);
  // 居間と玄関ホールのあいだの扉（閉じた状態）。開口は幅 0.41・高さ 0.98、扉は 0.49 × 1.01（枠の寸法）
  place("doorway", new THREE.Vector3(-half, 0, z0), 1.01 * k, 90);

  // 畳の部屋（右）: 開口の先に 90 × 90。窓（障子の代わり）と座卓、座布団
  const tatamiSize = 90;
  const tatamiEnd = half + tatamiSize;
  for (const [z, out] of [[z0 - tatamiSize / 2, -1], [z0 + tatamiSize / 2, 1]] as const) {
    const w = place("wall", new THREE.Vector3((half + tatamiEnd) / 2, 0, z), h, out < 0 ? 0 : 180, tatamiSize);
    walls.push({ object: w, outward: worldDir(0, out), boundary: Math.abs(z) });
  }
  const gap = (tatamiSize - panel) / 2;
  place("wallWindowSlide", new THREE.Vector3(tatamiEnd, 0, z0), h, 270);
  place("wall", new THREE.Vector3(tatamiEnd, 0, z0 - panel / 2 - gap / 2), h, 270, gap);
  place("wall", new THREE.Vector3(tatamiEnd, 0, z0 + panel / 2 + gap / 2), h, 270, gap);
  place("tableCoffee", new THREE.Vector3(half + 45, 0, z0), 0.4 * UNITS_PER_METRE, 90);
  // 座布団: 約 50cm 角の平らな箱。座卓（長辺 32）の外側の短辺側に置く
  for (const side of [-1, 1]) {
    const cushion = new THREE.Mesh(
      new THREE.BoxGeometry(14, 2.4, 14),
      new THREE.MeshStandardMaterial({ color: 0x8e5d78, roughness: 1, envMapIntensity: 0 }),
    );
    cushion.position.set(half + 45, 1.2, z0 + side * 25);
    cushion.castShadow = cushion.receiveShadow = true;
    room.add(cushion);
  }
  place("lampRoundFloor", new THREE.Vector3(tatamiEnd - 8, 0, z0 - tatamiSize / 2 + 8), 0.86 * k * 0.9, 0);

  addHouseFloors(room, { half, z0, panel, hallEnd, hallLength, tatamiEnd, tatamiSize });

  // --- 玄関の生活感: 下駄箱・傘立て・靴 ---
  const U = UNITS_PER_METRE;
  const gz = aperture[1]!;
  place("bookcaseClosedWide", new THREE.Vector3(hallEnd + 52, 0, gz - 6), 0.95 * U, 0);
  const umbrellaStand = new THREE.Group();
  const stand = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.2, 11, 12), new THREE.MeshStandardMaterial({ color: 0x4d5a63, roughness: 0.6, envMapIntensity: 0 }));
  stand.position.y = 5.5;
  umbrellaStand.add(stand);
  for (const [dx, dz, c] of [[-1, 0.4, 0x2f5d8a], [0.9, -0.6, 0xa84c4c], [0.1, 1, 0x3a6b4f]] as const) {
    const umbrella = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 26, 6), new THREE.MeshStandardMaterial({ color: c, roughness: 0.7, envMapIntensity: 0 }));
    umbrella.position.set(dx, 20, dz);
    umbrella.rotation.z = dx * 0.08;
    umbrellaStand.add(umbrella);
  }
  umbrellaStand.position.set(hallEnd + 12, -STEP_UP, aperture[1]! - 5);
  room.add(umbrellaStand);
  // 靴: 土間に3足。足先は扉のほう（-x）
  const shoe = (x: number, z: number, color: number) => {
    const s = new THREE.Group();
    const sole = new THREE.Mesh(new THREE.BoxGeometry(9, 1.6, 3.4), new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.8, envMapIntensity: 0 }));
    sole.position.y = 0.8;
    const upper = new THREE.Mesh(new THREE.BoxGeometry(7, 3.4, 3.2), new THREE.MeshStandardMaterial({ color, roughness: 0.7, envMapIntensity: 0 }));
    upper.position.set(0.8, 3.1, 0);
    s.add(sole, upper);
    s.position.set(x, -STEP_UP, z);
    room.add(s);
  };
  shoe(hallEnd + 20, z0 - 11, 0x3d3a37);
  shoe(hallEnd + 20, z0 - 6.5, 0x3d3a37);
  shoe(hallEnd + 21, z0 + 12, 0xb5654a);

  // --- 居間の家具: テレビ台とテレビ、ダイニングテーブルと椅子 ---
  // 太陽の影は右奥（+x, -z）へ伸びる。遊ぶ場所（マット）へ影が掛からないよう、背の高い家具は手前の右か、左前に置く
  // テレビ台の奥行は 11。手前の壁（巾木の内側 z=61.9）に食い込まない位置へ
  place("cabinetTelevision", new THREE.Vector3(-43, 0, 56), 0.5 * U, 0);
  place("televisionVintage", new THREE.Vector3(-43, 0.5 * U, 56), 0.42 * U, 0);
  // 重ならない位置: テーブルは直径 36（高さ 0.6m）、椅子は幅 10。椅子はテーブルの縁の外、壁の巾木の内側
  place("tableRound", new THREE.Vector3(40, 0, 32), 0.6 * U, 0);
  // yaw 0 は -z を向く。テーブル（z=32）より手前（z が小さい側）の椅子は +z を向くので 180°
  place("chair", new THREE.Vector3(40, 0, 8), 0.85 * U, 180);
  place("chair", new THREE.Vector3(40, 0, 56), 0.85 * U, 0);
  // 長辺（19）を壁に沿わせる。向きを回さないと壁に食い込む
  place("sideTable", new THREE.Vector3(70, 0, -28), 0.5 * U, 90);
  // ソファは x が 19.4〜66.6。照明の幅 4.3 の半分を足した外側に置く
  place("lampSquareFloor", new THREE.Vector3(70, 0, -48), 1.1 * U, 0);

  // --- 巾木: 壁の足元の細い板 ---
  const skirtingMaterial = new THREE.MeshStandardMaterial({ color: 0xf3ecdc, roughness: 0.8, envMapIntensity: 0 });
  const skirting = (x: number, z: number, length: number, alongX: boolean) => {
    if (length <= 0.5) return;
    const m = new THREE.Mesh(new THREE.BoxGeometry(alongX ? length : 0.8, 3, alongX ? 0.8 : length), skirtingMaterial);
    m.position.set(x, 1.5, z);
    m.receiveShadow = true;
    room.add(m);
  };
  const inner = 2.3; // 壁の厚みの半分
  const wallTop = 65 - inner;
  // 居間: 奥と手前の壁は全幅、左右の壁は開口を抜く
  skirting(0, -wallTop + 0.4, half * 2, true);
  skirting(0, wallTop - 0.4, half * 2, true);
  for (const side of [-1, 1]) {
    const x = side * (half - inner - 0.4);
    skirting(x, (-wallTop + aperture[0]!) / 2, aperture[0]! + wallTop, false);
    skirting(x, (aperture[1]! + wallTop) / 2, wallTop - aperture[1]!, false);
  }
  // 廊下の両側
  for (const z of [aperture[0]! + inner + 0.4, aperture[1]! - inner - 0.4]) {
    skirting((-half + hallEnd) / 2, z, hallLength, true);
  }
  // 畳の部屋: 両側と奥（畳寄せの代わり）
  for (const sz of [-1, 1]) skirting((half + tatamiEnd) / 2, z0 + sz * (tatamiSize / 2 - inner - 0.4), tatamiSize, true);
  skirting(tatamiEnd - inner - 0.4, z0, tatamiSize, false);

  // --- 障子と襖（畳の部屋） ---
  addJapaneseDoors(room, { k, half, z0, panel, tatamiEnd });

  // --- 天井 ---
  // 下向きの一枚板。上から見ると裏面なので描かれず、見下ろしの邪魔にならない。低い視点や運転席では見える。
  // 影は落とさない（窓の光を遮らない）
  const ceilingMaterial = new THREE.MeshStandardMaterial({
    color: 0xe9e4d6,
    roughness: 1,
    emissive: new THREE.Color(0x242722),
    emissiveIntensity: 0.3,
    envMapIntensity: 0,
  });
  const ceiling = (w: number, d: number, x: number, z: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), ceilingMaterial);
    m.rotation.x = Math.PI / 2; // 法線を下へ
    m.position.set(x, h, z);
    room.add(m);
  };
  ceiling(half * 2, 130, 0, 0);
  ceiling(hallLength, panel, -half - hallLength / 2, z0);
  ceiling(tatamiSize, tatamiSize, half + tatamiSize / 2, z0);
  // 照明は天井から吊る
  const lamp = 0.23 * k;
  for (const [x, z] of [[0, 0], [-half - hallLength / 2, z0], [half + tatamiSize / 2, z0]] as const) {
    place("lampSquareCeiling", new THREE.Vector3(x, h - lamp, z), lamp, 0);
  }
  roomHalf = half;

  // 読める程度の家具だけ。中央は空けて、線路を主役にする
  place("bookcaseOpen", new THREE.Vector3(-45, 0, -55), 1.4 * UNITS_PER_METRE, 0);
  place("loungeSofa", new THREE.Vector3(43, 0, -50), 0.8 * UNITS_PER_METRE, 180);
  place("pottedPlant", new THREE.Vector3(-25, 0, -56), 0.55 * UNITS_PER_METRE, 0);
  place("cardboardBoxOpen", new THREE.Vector3(22, 0, -35), 0.25 * UNITS_PER_METRE, 205);
  return { walls, props };
}

/** 畳。1枚 50 × 25 ユニット（Unity の Tatami.json の周期と同じ）。縁を暗い線で、織り目を細い横線で */
function tatamiTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const hex = (r: number, g: number, b: number) =>
    `#${new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace).getHexString()}`;
  const base = hex(0.34, 0.33, 0.155);
  const tone = hex(0.3, 0.295, 0.135);
  const edge = hex(0.23, 0.225, 0.115);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  const half = size / 2;
  for (const [row, shift] of [[0, 0], [half, half]] as const) {
    // 織り目: 細い横線を交互に
    for (let y = row; y < row + half; y += 4) {
      ctx.fillStyle = tone;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(0, y, size, 2);
    }
    ctx.globalAlpha = 1;
    // 縁: 長辺の2本と、短辺（段ごとに半分ずらして並べる）
    ctx.fillStyle = edge;
    ctx.fillRect(0, row, size, 5);
    ctx.fillRect(shift, row, 4, half);
    if (shift) ctx.fillRect(0, row, 4, half);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/** 玄関の土間。灰色の石タイル */
function tileTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#8a847c";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#6f6a64";
  for (let i = 0; i <= size; i += size / 2) {
    ctx.fillRect(i, 0, 3, size);
    ctx.fillRect(0, i, size, 3);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

interface HouseDims {
  half: number;
  z0: number;
  panel: number;
  hallEnd: number;
  hallLength: number;
  tatamiEnd: number;
  tatamiSize: number;
}

/** 廊下（板張り）・玄関の土間・畳の床。メインの床（y=-0.04）の少し上に敷く */
function addHouseFloors(room: THREE.Group, d: HouseDims) {
  const plane = (w: number, depth: number, map: THREE.Texture, x: number, z: number, roughness: number) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, depth),
      new THREE.MeshStandardMaterial({ map, roughness, envMapIntensity: 0 }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, -0.03, z);
    m.receiveShadow = true;
    room.add(m);
  };
  // 廊下: 板は進行方向（x）に沿う。1周期 24 × 12.8。玄関の土間の分だけ手前で止める
  const hall = surfaceTexture(0x8f7455, 0x7d6347, false);
  const floorLength = d.hallLength - DOMA_LENGTH;
  hall.repeat.set(floorLength / 24, d.panel / 12.8);
  plane(floorLength, d.panel, hall, -d.half - floorLength / 2, d.z0, 0.7);
  // 土間: 玄関の扉の前。床より一段（上がり框）低い
  const tile = tileTexture();
  tile.repeat.set(DOMA_LENGTH / 12.5, d.panel / 12.5);
  const doma = new THREE.Mesh(
    new THREE.PlaneGeometry(DOMA_LENGTH, d.panel),
    new THREE.MeshStandardMaterial({ map: tile, roughness: 0.85, envMapIntensity: 0 }),
  );
  doma.rotation.x = -Math.PI / 2;
  doma.position.set(d.hallEnd + DOMA_LENGTH / 2, -STEP_UP - 0.03, d.z0);
  doma.receiveShadow = true;
  room.add(doma);
  // 上がり框（床の縁の横木）と、土間の脇の壁の下を埋める漆喰
  const front = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, STEP_UP, d.panel),
    new THREE.MeshStandardMaterial({ color: 0x6b4f35, roughness: 0.6, envMapIntensity: 0 }),
  );
  front.position.set(d.hallEnd + DOMA_LENGTH, -STEP_UP / 2 - 0.03, d.z0);
  front.castShadow = front.receiveShadow = true;
  room.add(front);
  for (const side of [-1, 1]) {
    const fill = new THREE.Mesh(
      new THREE.BoxGeometry(DOMA_LENGTH, STEP_UP, 1.2),
      new THREE.MeshStandardMaterial({ color: 0xd9d2c0, roughness: 0.9, envMapIntensity: 0 }),
    );
    fill.position.set(d.hallEnd + DOMA_LENGTH / 2, -STEP_UP / 2 - 0.03, d.z0 + (side * d.panel) / 2);
    fill.receiveShadow = true;
    room.add(fill);
  }
  // 畳: 1周期 = 50 × 50（2枚）
  const tatami = tatamiTexture();
  tatami.repeat.set(d.tatamiSize / 50, d.tatamiSize / 50);
  plane(d.tatamiSize, d.tatamiSize, tatami, d.half + d.tatamiSize / 2, d.z0, 0.9);
}

/**
 * 部屋と空を撮った環境。映り込ませるのはレールと車体だけにする。
 * scene.environment に置くと床・壁・家具の拡散光にまで掛かって白飛びするので、材質ごとに持たせる
 */
let sharedEnvironment: THREE.Texture | null = null;
export function setSharedEnvironment(texture: THREE.Texture) {
  sharedEnvironment = texture;
}

/** FBX の素材（Phong）を、光に反応する標準素材へ。色と絵は引き継ぐ。env は映り込みの強さ（0 なら映さない） */
export function toStandard(m: THREE.Material, roughness = 0.7, env = 0.4): THREE.Material {
  if (m instanceof THREE.MeshStandardMaterial) {
    m.envMap = env > 0 ? sharedEnvironment : null;
    m.envMapIntensity = env;
    return m;
  }
  const src = m as THREE.MeshPhongMaterial;
  // FBX に入っている色は、Unity が線形の値としてそのまま使う（three は sRGB として読むので暗く・濃くなる）。
  // 保存された値を取り出して、線形として入れ直す
  const stored = (src.color ?? new THREE.Color(1, 1, 1)).clone().convertLinearToSRGB();
  const out = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setRGB(stored.r, stored.g, stored.b, THREE.LinearSRGBColorSpace),
    map: src.map ?? null,
    roughness,
    metalness: 0,
    envMap: env > 0 ? sharedEnvironment : null,
    envMapIntensity: env,
    side: src.side,
    transparent: src.transparent,
    opacity: src.opacity,
  });
  out.name = m.name;
  if (out.map) out.map.colorSpace = THREE.SRGBColorSpace;
  return out;
}

export interface Scenery {
  lights: Lights;
  /** 視点の注視点が動ける範囲（部屋の中）。x と z の半幅 */
  limit: { x: number; z: number };
  /** 置き物（家具・照明・扉）。重なりの検査に使う */
  props: THREE.Object3D[];
  /** カメラの位置で壁を出し入れする。外へ出たら消して、中が見えるように */
  updateWalls(cameraPosition: THREE.Vector3): void;
  /**
   * 家具・照明・扉を、カメラの邪魔になるときだけ消す。
   * カメラが箱の中に入った物と、カメラから注視点への視線をふさぐ物が対象
   */
  updateProps(cameraPosition: THREE.Vector3, target: THREE.Vector3): void;
}

/** 箱を、この幅だけ広げて測る。ぎりぎりでちらつかないように */
const PROP_MARGIN = 1.5;

export async function buildScenery(scene: THREE.Scene, baseUrl: string): Promise<Scenery> {
  scene.background = new THREE.Color(C.horizon);
  addFloor(scene);
  addSky(scene);
  const lights = addLights(scene);
  const { walls, props } = await addRoom(scene, baseUrl);
  fitFloorToRoom(roomHalf * 2, 130);
  addOutdoors(scene, roomHalf);
  // 置き物は動かないので、外形の箱は1度だけ測る（部屋は x 反転して置いてあるので、世界座標で測る）
  scene.updateMatrixWorld(true);
  const boxes = props.map((object) => ({ object, box: new THREE.Box3().setFromObject(object).expandByScalar(PROP_MARGIN) }));
  const ray = new THREE.Ray();
  const hit = new THREE.Vector3();
  return {
    lights,
    // 壁の内側。端まで行くと外の床が見えるので、少し手前で止める
    limit: { x: roomHalf - 8, z: 57 },
    props,
    updateWalls(cam) {
      for (const w of walls) w.object.visible = cam.dot(w.outward) < w.boundary - 1;
    },
    updateProps(cam, target) {
      ray.origin.copy(cam);
      ray.direction.copy(target).sub(cam);
      const reach = ray.direction.length();
      ray.direction.normalize();
      for (const { object, box } of boxes) {
        let hide = box.containsPoint(cam);
        // 視線の途中にあれば消す。注視点の手前で当たるものだけ（注視点の向こうの物は邪魔にならない）。
        // 注視点がその物の中なら、見たい対象なので消さない
        if (!hide && !box.containsPoint(target) && ray.intersectBox(box, hit)) hide = hit.distanceTo(cam) < reach - 0.5;
        object.visible = !hide;
      }
    },
  };
}

// 背景・光・材質。部屋・家具は持たず、広い木の床＋布マット＋青空と雲だけで最軽量に描く
import * as THREE from "three";

/** 色（UiPalette の windowlight.* と同じ役割） */
const C = {
  lightMain: 0xfff0da,
  lightFill: 0xe0ebf9,
  lightSky: 0x899eaf,
  lightGround: 0x827360,
  floorSurface: 0xac8d6b,
  floorJoint: 0x9f805f,
  rugSurface: 0xc0b9a4,
  rugBinding: 0xb7ac91,
  zenith: 0x3f8fd8,
  horizon: 0x8ad1f7,
  ground: 0x8fa889,
};

/** 左手系 Euler（度）が向ける前方ベクトルを three の世界（x 反転）で返す */
function forwardOf(xDeg: number, yDeg: number): THREE.Vector3 {
  const e = new THREE.Euler(THREE.MathUtils.degToRad(xDeg), THREE.MathUtils.degToRad(yDeg), 0, "YXZ");
  const f = new THREE.Vector3(0, 0, 1).applyEuler(e);
  return new THREE.Vector3(-f.x, f.y, f.z);
}

// --- 床とマット ---

/** 256px の軽量模様。板は縦に4段、段ごとに半分ずらした継ぎ目。布は細かい織り目 */
function surfaceTexture(surface: number, joint: number, fabric: boolean): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const base = new THREE.Color(surface).convertLinearToSRGB();
  const seam = new THREE.Color(joint).convertLinearToSRGB();
  const px = (c: number) => Math.round(THREE.MathUtils.clamp(c, 0, 1) * 255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const detail = fabric
        ? 0.012 * Math.sin(u * Math.PI * 32) * Math.sin(v * Math.PI * 32)
        : 0.008 * Math.sin(v * Math.PI * 18 + Math.sin(u * Math.PI * 2) * 0.4) + 0.01 * Math.sin(v * Math.PI * 8);
      const onSeam = !fabric && (y % 64 < 2 || (x + (Math.floor(y / 64) % 2) * 128) % 256 < 2);
      const c = onSeam ? seam : base;
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
  tex.anisotropy = 4;
  return tex;
}

function addFloor(scene: THREE.Scene) {
  const span = 420;
  const tex = surfaceTexture(C.floorSurface, C.floorJoint, false);
  tex.repeat.set(span / 24, span / 12.8);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(span, span),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.78, envMapIntensity: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.04;
  floor.receiveShadow = true;
  scene.add(floor);

  // プレイマット: 縁取りの上に布を重ねる。定番レイアウトも余裕で収まる広さ
  const rug = new THREE.Group();
  const [w, d] = [60, 44];
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

// --- 空と雲 ---

function addSky(scene: THREE.Scene) {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
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
  const sun = new THREE.DirectionalLight(C.lightMain, 1.4 * Math.PI);
  const sunDir = forwardOf(32, 145);
  sun.userData.dir = sunDir;
  sun.castShadow = true;
  const shadowSize = matchMedia("(pointer: coarse)").matches ? 2048 : 4096;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  sun.shadow.radius = 3;
  sun.shadow.intensity = 0.55;
  scene.add(sun, sun.target);

  const fill = new THREE.DirectionalLight(C.lightFill, 0.65 * Math.PI);
  const fillDir = forwardOf(22, 325);
  fill.position.copy(fillDir).multiplyScalar(-100);
  scene.add(fill);

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

/** 映り込ませるのはレールと車体だけにする */
let sharedEnvironment: THREE.Texture | null = null;
export function setSharedEnvironment(texture: THREE.Texture) {
  sharedEnvironment = texture;
}

/** FBX の素材（Phong）を、光に反応する標準素材へ。色と絵は引き継ぐ */
export function toStandard(m: THREE.Material, roughness = 0.7, env = 0.4): THREE.Material {
  if (m instanceof THREE.MeshStandardMaterial) {
    m.envMap = env > 0 ? sharedEnvironment : null;
    m.envMapIntensity = env;
    return m;
  }
  const src = m as THREE.MeshPhongMaterial;
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
  /** 視点の注視点が動ける範囲 */
  limit: { x: number; z: number };
}

export function buildScenery(scene: THREE.Scene): Scenery {
  scene.background = new THREE.Color(C.horizon);
  // 遠くの床の縁が地平線の空へ自然になじむように薄いフォグを置く
  scene.fog = new THREE.Fog(C.horizon, 130, 240);
  addFloor(scene);
  addSky(scene);
  const lights = addLights(scene);
  return {
    lights,
    limit: { x: 80, z: 80 },
  };
}

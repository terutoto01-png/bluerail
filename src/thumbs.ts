// 棚のアイコン。部品のモデルを1回だけ描いて絵にし、覚えておく。レールは真上から、町なみと電車は斜め上から
import * as THREE from "three";

const SIZE = 128;

export interface Thumbnailer {
  /** レール（FBX の部品）。真上から */
  (kind: string): Promise<string>;
  /** すでに Unity の局所座標で組んだ物（町なみ・電車）。斜め上から。key で覚える */
  object(key: string, make: () => Promise<THREE.Object3D>): Promise<string>;
}

export function createThumbnailer(renderer: THREE.WebGLRenderer, loadModel: (kind: string) => Promise<THREE.Group>): Thumbnailer {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb8a98a, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-4, 10, -3);
  scene.add(sun);
  const target = new THREE.WebGLRenderTarget(SIZE, SIZE, { samples: 4 });
  // 出力は sRGB。指定しないと線形のまま絵になって暗くなる
  target.texture.colorSpace = THREE.SRGBColorSpace;
  const cache = new Map<string, Promise<string>>();
  // 描く順に1つずつ。描画ターゲットと状態を共有しているので、並行して描かない
  let queue: Promise<unknown> = Promise.resolve();

  /** holder（Unity の座標で組んだ物）を撮って、画像の URL にする */
  async function capture(content: THREE.Object3D, oblique: boolean): Promise<string> {
    const holder = new THREE.Group();
    holder.scale.x = -1; // ゲームの世界と同じく、Unity の左手系へ合わせる
    holder.add(content);
    scene.add(holder);
    scene.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(holder);
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    if (oblique) {
      const half = size.length() / 2 + 0.3;
      cam.left = -half;
      cam.right = half;
      cam.top = half;
      cam.bottom = -half;
      cam.position.copy(centre).add(new THREE.Vector3(-1, 1.1, -1.4).normalize().multiplyScalar(60));
      cam.lookAt(centre);
    } else {
      // 真上から。局所の前方（-z）が画面の上
      const half = Math.max(size.x, size.z) / 2 + 0.6;
      cam.left = -half;
      cam.right = half;
      cam.top = half;
      cam.bottom = -half;
      cam.up.set(0, 0, -1);
      cam.position.set(centre.x, centre.y + 30, centre.z);
      cam.lookAt(centre);
    }
    cam.updateProjectionMatrix();

    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, cam);
    const px = new Uint8Array(SIZE * SIZE * 4);
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, SIZE, SIZE, px);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    scene.remove(holder);

    // 描画ターゲットは下が先頭なので、上下を返して絵にする
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(SIZE, SIZE);
    for (let y = 0; y < SIZE; y++) {
      img.data.set(px.subarray((SIZE - 1 - y) * SIZE * 4, (SIZE - y) * SIZE * 4), y * SIZE * 4);
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL("image/png");
  }

  async function renderRail(kind: string): Promise<string> {
    const model = (await loadModel(kind)).clone();
    model.scale.set(-0.01, 0.01, 0.01);
    model.children.filter((c) => c.name.startsWith("Connection_")).forEach((c) => model.remove(c));
    return capture(model, false);
  }

  const enqueue = (key: string, job: () => Promise<string>) => {
    let p = cache.get(key);
    if (!p) {
      p = queue.then(job);
      queue = p.catch(() => undefined);
      cache.set(key, p);
    }
    return p;
  };

  const thumb = ((kind: string) => enqueue(`rail:${kind}`, () => renderRail(kind))) as Thumbnailer;
  thumb.object = (key, make) => enqueue(`obj:${key}`, async () => capture(await make(), true));
  return thumb;
}

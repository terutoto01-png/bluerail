// レールに着る装飾（Unity §10.6）。部品が名乗る架線柱を継ぎ目に立てる。状態を持たず、毎回作り直す
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import type { Catalog } from "./catalog";
import type { PieceSave } from "./course";
import { portHeading, toWorld } from "./track";
import { toStandard } from "./scenery";

interface DecorDef {
  id: string;
  at: string;
  model?: string;
  side?: string;
}

const loader = new FBXLoader();
const loaded = new Map<string, Promise<{ def: DecorDef; model: THREE.Group }>>();

function loadDecor(base: string, id: string) {
  let p = loaded.get(id);
  if (!p) {
    p = (async () => {
      const def = (await (await fetch(`${base}data/Scenery/${id}/${id}.json`)).json()) as DecorDef;
      const src = await loader.loadAsync(`${base}data/${def.model}.fbx`);
      src.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.material = Array.isArray(o.material) ? o.material.map((m) => toStandard(m, 0.5)) : toStandard(o.material, 0.5);
        o.castShadow = true;
        o.receiveShadow = true;
      });
      // 橋脚と同じく、FBX は cm・右手系。0.01 倍して x を反転する
      src.scale.set(-0.01, 0.01, 0.01);
      const holder = new THREE.Group();
      holder.add(src);
      return { def, model: holder };
    })();
    loaded.set(id, p);
  }
  return p;
}

/** 継ぎ目に立つ装飾を、いまの部品から全部立て直す。同じ継ぎ目へ集まる部品は1本だけ */
export async function buildDecorations(base: string, catalog: Catalog, pieces: PieceSave[]): Promise<THREE.Group> {
  const out = new THREE.Group();
  const seen = new Set<string>();
  for (const piece of pieces) {
    const def = catalog.of(piece);
    // 覆われた駒には、カタログのぶんを立てない（柱がトンネルの中に立つ）
    if (piece.decorations?.length) continue;
    for (const id of def?.decorations ?? []) {
      const { def: dd, model } = await loadDecor(base, id);
      if (dd.at !== "joint") continue;
      const yaw = (piece.euler.y * Math.PI) / 180;
      // 継ぎ目（面）ごとに1本。複線は面に口が2つあるので、2本の中間に門型を1つ立てる
      for (const face of new Set(def!.ports.map((p) => p.face))) {
        const ports = def!.ports.filter((p) => p.face === face);
        const at = ports.map((p) => toWorld(piece, p.position));
        const x = at.reduce((s, v) => s + v[0], 0) / at.length;
        const y = at.reduce((s, v) => s + v[1], 0) / at.length;
        const z = at.reduce((s, v) => s + v[2], 0) / at.length;
        const key = `${id}:${x.toFixed(1)}:${y.toFixed(1)}:${z.toFixed(1)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const g = model.clone();
        g.position.set(x, y, z);
        g.rotation.y = -(portHeading(ports[0]!) - yaw);
        out.add(g);
      }
    }
  }
  return out;
}

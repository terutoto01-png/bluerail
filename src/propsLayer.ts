// マットに置いた町なみの管理。置く（狙う→ゴースト→確定）、選ぶ、回す、消す。部品（レール）とは別の層
import * as THREE from "three";
import { buildProp, extractFreeProps, loadProps, type PropDef, type PropSave } from "./props";

/** 位置の刻み（Unity の `FreeGrid`）と向きの刻み */
const GRID = 1.5;
const YAW_STEP = 45;

const ghostMaterial = new THREE.MeshBasicMaterial({ color: 0x6fb7ff, transparent: true, opacity: 0.55, depthWrite: false });

export class PropsLayer {
  readonly group = new THREE.Group();
  defs: PropDef[] = [];
  private items: PropSave[] = [];
  private groups: THREE.Group[] = [];
  private ghost: THREE.Group | null = null;
  /** いま持っている種類（置く手つきの途中） */
  kind: string | null = null;
  aimAt: [number, number] | null = null;
  yaw = 0;
  /** 置いた物のうち、選んでいる番号 */
  picked: number | null = null;
  private frame: THREE.Mesh | null = null;

  async load(base: string) {
    this.defs = await loadProps(base);
  }

  setDefs(allDefs: PropDef[]) {
    this.defs = extractFreeProps(allDefs);
  }

  defOf(id: string) {
    return this.defs.find((d) => d.id === id);
  }

  /** コースの props を差し込む。配列そのものを使い、置く・消すはその配列を書き換える */
  setItems(items: PropSave[]) {
    this.items = items;
    this.picked = null;
    this.render();
  }

  render() {
    for (const g of this.groups) this.group.remove(g);
    this.groups = [];
    this.items.forEach((item, i) => {
      const def = this.defOf(item.id);
      if (!def) return;
      const g = buildProp(def);
      g.position.set(item.position.x, item.position.y, item.position.z);
      g.rotation.y = THREE.MathUtils.degToRad(item.yaw);
      g.userData.prop = i;
      this.group.add(g);
      this.groups.push(g);
    });
    this.paintPick();
  }

  /** 種類を持つ（null で手放す）。持つと選択と狙いは外れる */
  hold(kind: string | null) {
    this.kind = kind;
    this.aimAt = null;
    if (kind) this.picked = null;
    this.paintPick();
    this.refreshGhost();
  }

  /** マットの点 p（Unity の座標）を狙う。格子へ丸める */
  aim(p: THREE.Vector3) {
    if (!this.kind) return;
    this.aimAt = [Math.round(p.x / GRID) * GRID, Math.round(p.z / GRID) * GRID];
    this.refreshGhost();
  }

  turn(steps: number) {
    this.yaw = (this.yaw + steps * YAW_STEP + 360) % 360;
    if (this.kind) this.refreshGhost();
    else if (this.picked !== null) {
      this.items[this.picked]!.yaw = this.yaw;
      this.render();
    }
  }

  private refreshGhost() {
    if (this.ghost) this.group.remove(this.ghost);
    this.ghost = null;
    const def = this.kind ? this.defOf(this.kind) : undefined;
    if (!def || !this.aimAt) return;
    const g = buildProp(def);
    g.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.material = ghostMaterial;
        o.castShadow = false;
      }
    });
    g.position.set(this.aimAt[0], 0, this.aimAt[1]);
    g.rotation.y = THREE.MathUtils.degToRad(this.yaw);
    this.ghost = g;
    this.group.add(g);
  }

  /** ゴーストを置く。置いた物を返す */
  confirm(): PropSave | null {
    if (!this.kind || !this.aimAt) return null;
    const item: PropSave = { id: this.kind, position: { x: this.aimAt[0], y: 0, z: this.aimAt[1] }, yaw: this.yaw };
    this.items.push(item);
    this.aimAt = null;
    this.refreshGhost();
    this.render();
    return item;
  }

  hitsGhost(ray: THREE.Raycaster): boolean {
    return !!this.ghost && ray.intersectObject(this.ghost, true).length > 0;
  }

  /** レイが当たった置き済みの物の番号 */
  pickAt(ray: THREE.Raycaster): number | null {
    const hit = ray.intersectObjects(this.groups, true)[0];
    let o: THREE.Object3D | null = hit?.object ?? null;
    while (o && o.userData.prop === undefined) o = o.parent;
    return o ? (o.userData.prop as number) : null;
  }

  pick(i: number | null) {
    this.picked = i === this.picked ? null : i;
    if (this.picked !== null) this.yaw = this.items[this.picked]!.yaw;
    this.paintPick();
  }

  remove(): boolean {
    if (this.picked === null) return false;
    this.items.splice(this.picked, 1);
    this.picked = null;
    this.render();
    return true;
  }

  private paintPick() {
    this.frame?.removeFromParent();
    this.frame = null;
    if (this.picked === null) return;
    const g = this.groups[this.picked];
    if (!g) return;
    // 枠は g の局所で描く。置き場所に左右されない外形は、組み立て直した物から測る
    const local = new THREE.Box3().setFromObject(buildProp(this.defOf(this.items[this.picked]!.id)!));
    const size = local.getSize(new THREE.Vector3()).addScalar(0.1);
    this.frame = new THREE.Mesh(
      new THREE.BoxGeometry(size.x, size.y, size.z),
      new THREE.MeshBasicMaterial({ color: 0xf5df91, transparent: true, opacity: 0.4, depthWrite: false }),
    );
    this.frame.position.copy(local.getCenter(new THREE.Vector3()));
    g.add(this.frame);
  }

  /** 画面の外へ出す（モード切り替えなどで、ゴーストや選択を消す） */
  clearHand() {
    this.kind = null;
    this.aimAt = null;
    this.picked = null;
    this.refreshGhost();
    this.paintPick();
  }
}

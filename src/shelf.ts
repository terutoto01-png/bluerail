// 部品の棚。上の段でカテゴリーを選び、下の段で部品を選ぶ。中身はカタログの categories から引く
import type { Catalog, RailDef } from "./catalog";

/** 段。id が `fav` `hist` 以外ならカタログの categories と一致する */
const DRAWERS: { id: string; label: string }[] = [
  { id: "fav", label: "お気に入り" },
  { id: "hist", label: "履歴" },
  { id: "Basic", label: "基本" },
  { id: "Point", label: "分岐" },
  { id: "Level", label: "上下" },
  { id: "Double", label: "複線" },
  { id: "Advance", label: "スリム" },
];

/** 上の段。drawers が無い段は作るまで押せない。「電車」は部品ではなく編成を選ぶ */
const GROUPS: { id: string; label: string; drawers?: { id: string; label: string }[] }[] = [
  { id: "rail", label: "線路", drawers: DRAWERS },
  {
    id: "station",
    label: "駅・仕掛け",
    drawers: [
      { id: "Station", label: "駅" },
      { id: "Gimmick", label: "仕掛け" },
    ],
  },
  { id: "scenery", label: "情景", drawers: [{ id: "town", label: "町なみ" }] },
  {
    id: "train",
    label: "電車",
    drawers: [
      { id: "trains", label: "いまの編成を替える" },
      { id: "addTrain", label: "＋ 編成を追加" },
    ],
  },
];

/** 扱わない部品（ループは除外） */
const EXCLUDED = new Set(["Loop"]);

const HISTORY_MAX = 12;

function load(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function save(key: string, value: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 保存できなくても棚は動く
  }
}

export interface ShelfHooks {
  catalog: Catalog;
  thumb(kind: string): Promise<string>;
  /** 部品が選ばれた（null は選択を外した） */
  onSelect(kind: string | null): void;
  /** 選択中の部品をもう一度押した。置き方を次へ回す */
  onCycle(): void;
  /** いまの端に置けるか。端が選ばれていなければ常に true */
  available(kind: string): boolean;
  /** 選べる電車（id と表示名）の一覧 */
  trains(): { id: string; label: string }[];
  /** いま走らせている電車 */
  currentTrain(): string;
  /** 電車が選ばれた（いまの編成の車種を替える） */
  onTrain(id: string): void;
  /** 新しい編成として追加する */
  onAddTrain(id: string): void;
  /** 町なみ・電車の棚の絵 */
  iconOfProp(id: string): Promise<string>;
  iconOfTrain(id: string): Promise<string>;
  /** 置ける町なみ（id と名前） */
  props(): { id: string; label: string }[];
  /** いま持っている町なみ */
  heldProp(): string | null;
  /** 町なみが選ばれた（同じものをもう一度で手放す） */
  onProp(id: string | null): void;
}

export class Shelf {
  private group = "rail";
  private drawer = "Basic";
  private selected: string | null = null;
  private favorites = load("bluerail.favorites");
  private history = load("bluerail.history");
  private rendered = false;
  private readonly tiles = document.getElementById("tiles")!;
  private readonly drawers = document.getElementById("drawers")!;

  constructor(private hooks: ShelfHooks) {
    this.renderGroups();
    this.renderDrawers();
  }

  /** 棚を初めて開いたときにタイルとサムネイル生成を開始する（起動直後の帯域を塞がない） */
  ensureRendered() {
    if (this.rendered) return;
    this.rendered = true;
    this.renderTiles();
  }

  private renderGroups() {
    const groups = document.getElementById("groups")!;
    groups.replaceChildren();
    for (const g of GROUPS) {
      const b = document.createElement("button");
      b.textContent = g.label;
      b.className = g.id === this.group ? "on" : "";
      if (!g.drawers) {
        b.disabled = true;
        b.title = "準備中";
      }
      b.onclick = () => {
        this.group = g.id;
        this.drawer = g.drawers![0]!.id;
        this.renderGroups();
        this.renderDrawers();
        this.renderTiles();
      };
      groups.append(b);
    }
  }

  /** 絵が撮れたら差し込む img。撮れなければ消える */
  private iconImg(url: Promise<string>): HTMLImageElement {
    const img = document.createElement("img");
    img.alt = "";
    img.width = img.height = 64;
    url.then((u) => (img.src = u), () => img.remove());
    return img;
  }

  /** 外から状態が変わったので、いまの段を描き直す */
  redraw() {
    if (!this.rendered) return;
    this.renderTiles();
  }

  private renderProps() {
    const held = this.hooks.heldProp();
    for (const p of this.hooks.props()) {
      const tile = document.createElement("div");
      tile.className = "tile text";
      tile.classList.toggle("on", p.id === held);
      const label = document.createElement("span");
      label.textContent = p.label;
      tile.append(this.iconImg(this.hooks.iconOfProp(p.id)), label);
      tile.onclick = () => {
        this.hooks.onProp(p.id === this.hooks.heldProp() ? null : p.id);
        this.renderTiles();
      };
      this.tiles.append(tile);
    }
  }

  private renderTrains() {
    const adding = this.drawer === "addTrain";
    const current = this.hooks.currentTrain();
    for (const t of this.hooks.trains()) {
      const tile = document.createElement("div");
      tile.className = "tile text";
      tile.classList.toggle("on", !adding && t.id === current);
      const label = document.createElement("span");
      label.textContent = adding ? `＋ ${t.label}` : t.label;
      tile.append(this.iconImg(this.hooks.iconOfTrain(t.id)), label);
      tile.onclick = () => {
        if (adding) this.hooks.onAddTrain(t.id);
        else this.hooks.onTrain(t.id);
        this.renderTiles();
      };
      this.tiles.append(tile);
    }
  }

  /** 履歴の先頭へ。同じものは上げ直すだけで増やさない */
  pushHistory(kind: string) {
    this.history = [kind, ...this.history.filter((k) => k !== kind)].slice(0, HISTORY_MAX);
    save("bluerail.history", this.history);
    if (this.rendered && this.drawer === "hist") this.renderTiles();
  }

  /** 端の選択が変わったので、置けない部品を灰色にし直す */
  refreshAvailability() {
    if (!this.rendered) return;
    for (const el of this.tiles.querySelectorAll<HTMLElement>(".tile")) {
      el.classList.toggle("off", !this.hooks.available(el.dataset.kind!));
    }
  }

  select(kind: string | null) {
    this.selected = kind;
    if (!this.rendered) return;
    for (const el of this.tiles.querySelectorAll<HTMLElement>(".tile")) {
      el.classList.toggle("on", el.dataset.kind === kind);
    }
  }

  private partsOf(drawer: string): RailDef[] {
    const { catalog } = this.hooks;
    const byOrder = (a: RailDef, b: RailDef) => a.order - b.order || a.id.localeCompare(b.id);
    if (drawer === "fav") return this.favorites.map((k) => catalog.get(k)).filter((d): d is RailDef => !!d);
    if (drawer === "hist") return this.history.map((k) => catalog.get(k)).filter((d): d is RailDef => !!d);
    return [...catalog.values()].filter((d) => !EXCLUDED.has(d.id) && d.categories.includes(drawer)).sort(byOrder);
  }

  private renderDrawers() {
    this.drawers.replaceChildren();
    for (const d of GROUPS.find((g) => g.id === this.group)!.drawers!) {
      const b = document.createElement("button");
      b.textContent = d.label;
      b.className = d.id === this.drawer ? "on" : "";
      b.onclick = () => {
        this.drawer = d.id;
        this.renderDrawers();
        this.renderTiles();
      };
      this.drawers.append(b);
    }
  }

  private renderTiles() {
    this.tiles.replaceChildren();
    if (this.group === "train") {
      this.renderTrains();
      return;
    }
    if (this.group === "scenery") {
      this.renderProps();
      return;
    }
    const parts = this.partsOf(this.drawer);
    if (!parts.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = this.drawer === "fav" ? "☆ を押した部品がここに並びます" : "まだありません";
      this.tiles.append(empty);
      return;
    }
    for (const def of parts) {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.dataset.kind = def.id;
      tile.title = def.label;
      tile.classList.toggle("on", def.id === this.selected);
      tile.classList.toggle("off", !this.hooks.available(def.id));

      const star = document.createElement("button");
      star.className = "star";
      star.textContent = "★";
      star.classList.toggle("on", this.favorites.includes(def.id));
      star.title = "お気に入り";
      star.onclick = (e) => {
        e.stopPropagation();
        this.favorites = this.favorites.includes(def.id)
          ? this.favorites.filter((k) => k !== def.id)
          : [...this.favorites, def.id];
        save("bluerail.favorites", this.favorites);
        if (this.drawer === "fav") this.renderTiles();
        else star.classList.toggle("on");
      };

      const img = document.createElement("img");
      img.alt = "";
      img.width = img.height = 64;
      this.hooks.thumb(def.id).then((url) => (img.src = url), () => img.remove());

      const label = document.createElement("span");
      label.textContent = def.label;

      tile.append(star, img, label);
      tile.onclick = () => {
        if (this.selected === def.id) this.hooks.onCycle();
        else {
          this.select(def.id);
          this.hooks.onSelect(def.id);
        }
      };
      this.tiles.append(tile);
    }
  }
}

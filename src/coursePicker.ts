// 「コースをえらぶ」シート。見取り図つきのカードを並べ、タップでそのコースへ切り替える
import type { Catalog } from "./catalog";
import type { PieceSave } from "./course";
import { drawCourseThumb } from "./minimap";

interface Options {
  catalog: Catalog;
  /** 並べるコース（value はメニューのコース選択と同じ値） */
  list: () => { value: string; label: string }[];
  current: () => string;
  load: (value: string) => Promise<PieceSave[] | null>;
  onPick: (value: string) => void;
}

const THUMB_W = 150;
const THUMB_H = 96;

export class CoursePicker {
  private grid: HTMLElement;
  /** 見取り図は一度描いたら覚えておく（保存コースは中身が変わりうるので覚えない） */
  private thumbs = new Map<string, string>();

  constructor(
    private root: HTMLElement,
    private opts: Options,
  ) {
    root.replaceChildren();
    const head = document.createElement("div");
    head.className = "head";
    const title = document.createElement("b");
    title.textContent = "コースをえらぶ";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "close";
    close.textContent = "✕";
    close.title = "閉じる";
    close.onclick = () => this.close();
    head.append(title, close);
    this.grid = document.createElement("div");
    this.grid.className = "grid";
    root.append(head, this.grid);
    // 背景（シートの外）をタップしても閉じる
    root.addEventListener("click", (e) => {
      if (e.target === root) this.close();
    });
  }

  get isOpen() {
    return this.root.classList.contains("open");
  }

  open() {
    this.render();
    this.root.classList.add("open");
  }

  close() {
    this.root.classList.remove("open");
  }

  private render() {
    const current = this.opts.current();
    this.grid.replaceChildren();
    const items = [...this.opts.list(), { value: "", label: "新しいコース（白紙から作る）" }];
    for (const item of items) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = `courseCard${item.value === current ? " on" : ""}`;
      const pic = document.createElement("div");
      pic.className = "pic";
      const name = document.createElement("span");
      name.textContent = item.label;
      card.append(pic, name);
      card.onclick = () => {
        this.close();
        if (item.value !== current) this.opts.onPick(item.value);
      };
      this.grid.append(card);
      if (!item.value) {
        pic.textContent = "＋";
        pic.classList.add("blank");
      } else void this.paintThumb(item.value, pic);
    }
    this.grid.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }

  private async paintThumb(value: string, pic: HTMLElement) {
    const keep = !value.startsWith("saved:");
    let url = keep ? this.thumbs.get(value) : undefined;
    if (!url) {
      const pieces = await this.opts.load(value).catch(() => null);
      if (!pieces) return;
      const canvas = document.createElement("canvas");
      drawCourseThumb(canvas, this.opts.catalog, pieces, THUMB_W, THUMB_H);
      url = canvas.toDataURL();
      if (keep) this.thumbs.set(value, url);
    }
    const img = document.createElement("img");
    img.alt = "";
    img.src = url;
    pic.replaceChildren(img);
  }
}

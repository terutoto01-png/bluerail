# つなげて！青レール！（Web / Three.js）作業規則

## プロジェクト概要

- 本リポジトリは Three.js + TypeScript + Vite による Web 版が正本である。
- データ（レール・車両・情景・橋脚・コース）は `public/data/` に置く。部品を追加・修正する際は JSON と FBX を `public/data/` 配下に配置する。
- 配信先は GitHub Pages（相対パス `base: "./"`、`dist/` をそのまま配信）。

## 設計・実装ルール

- 座標系: データは左手系（旧 Unity 座標）のまま保持し、描画ルート（`world`）のみ `scale.x = -1` で反転する。FBX は cm・右手系のため `scale(-0.01, 0.01, 0.01)` で合わせる。
- 画面の配色は `index.html` の CSS 変数（`--surface`, `--ink`, `--selected`, `--primary`, `--part-selected` 等）を使う。
- キーボードショートカットは、文字入力中（`INPUT` / `TEXTAREA` / `SELECT` / `contentEditable`）に発火させない。
- 公開物（HTML タイトル・UI 文言・保存キー等）に他社商標名を入れない。
- ファイル名・参照パスは Linux（大文字小文字区別）の GitHub Pages でも壊れないよう完全一致させる。

## 検証

- 変更後は `npm run check` および `npm run build` が通ることを確認する。
- UI・見た目・操作を変えた場合は `npm run dev` または `npm run preview` でブラウザ実機確認を行う。

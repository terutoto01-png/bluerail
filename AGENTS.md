# つなげて！青レール！（Web / Three.js）作業規則

## プロジェクト概要

- 本リポジトリ（`C:\work\bluerail`）は Three.js + TypeScript + Vite による Web 版の正本である。
- データ（レール・車両・情景・橋脚・コース）は `public/data/` に置く。初期読み込み高速化のため、`npm run bundle`（`dev` / `build` に組み込み済み）がメタデータ群と初期コースを `public/data/bundle.json` へまとめる。
- 公開先: GitHub Pages（https://terutoto01-png.github.io/bluerail/、`base: "./"`、`gh-pages` ブランチ配信）。デプロイは `npm run deploy`（`scripts/deploy-pages.mjs`）で行う。

## 現在の構成・方針

- **「走る」が主役**: 起動直後は走行モード（`setMode("drive")`）で電車が走っている状態から始まる。下の運転台（`#driveDock`）にカメラ・マスコン・向き・速度・コース選び・次の電車をまとめ、上はコース名と `🔨 つくる` だけにする。
  - **マスコン**（`src/mascon.ts`）: 溝の上の取っ手を左右に動かすレバー。8 段（非常・B2・B1・切・P1〜P4）で、力行は段ごとの上限まで加速、切は惰行、ブレーキは段ごとの強さで減速する（`Train.rate` で加減速の倍率を渡す）。向き（まえ／うしろ）は停止中のみ切替。
  - **コースをえらぶ**（`src/coursePicker.ts`）: 見取り図（`drawCourseThumb`）つきのカードをボトムシートで並べる。
  - 手本コースは `public/data/Courses/` に置き、`courses.json` の並び順で表示する。名前に他社商標を入れない。
- **つくる（配置モード）は 2 スタイル**:
  - **`かんたん`（デフォルト）**: 左右カーブを意識せず行き先タップで自動つなぎ・自動分岐／合流・自動閉合・自動高架（`src/easy.ts`）。`🚃 電車＋` で未使用車種優先のランダム選択＋空き路線優先の自動配置。
  - **`くわしく`**: 従来のクイックバー・全部品棚・部品編集ドックへ 1 タップ切替。
- **スリム（`Advance*`）**: 未完成のため、現在は UI（棚・車両一覧・車線切替）から除外中。内部の経路計算やアセットは将来の再有効化に備えて保持している。
- **複数編成・多層コース**: 各編成は `course.trains` に `{ train, at, port, piece, lane }` を保存する。保存・書き出し前に `syncCourseTrains()` で実ルート起点（`r.segs[0]`）を同期し、2 段目・別路線に置いた編成が再読み込みで 1 段目へ戻らないように保つ。
- **スマホ・iPad 対応**: 1 本指回転・2 本指ズーム／移動（`OrbitControls`）、タッチ選択補助、`100dvh` / `safe-area-inset-*` を維持する。

## 設計・実装ルール

- 座標系: データは左手系（旧 Unity 座標）のまま保持し、描画ルート（`world`）のみ `scale.x = -1` で反転する。FBX は cm・右手系のため `scale(-0.01, 0.01, 0.01)` で合わせる。
- 画面の配色は `index.html` の CSS 変数（`--surface`, `--ink`, `--selected`, `--primary`, `--part-selected` 等）を使う。
- キーボードショートカットは、文字入力中（`INPUT` / `TEXTAREA` / `SELECT` / `contentEditable`）に発火させない。
- 公開物（HTML タイトル・UI 文言・保存キー・コース名等）に他社商標名を入れない。
- ファイル名・参照パスは Linux（大文字小文字区別）の GitHub Pages でも壊れないよう完全一致させる。
- Git 作成者（`user.name` / `user.email`）はリポジトリ設定の GitHub noreply アドレスを維持し、ローカル個人パスや個人メールアドレスをコミット・アセットへ含めない。

## 検証

- 変更後は `npm run build`（`bundle` + `tsc --noEmit` + `vite build`）および `npm run test:easy` が通ることを確認する。
- UI・見た目・操作を変えた場合は `npm run dev` または `npm run preview` で PC・スマホ幅の動作と表示を確認する。

# つなげて！青レール！

ブラウザ上で青いレールをつなげて電車を走らせる 3D レイアウトシミュレーター（Three.js + TypeScript + Vite）。

## 開発・ビルド

```bash
npm install
npm run dev      # 開発サーバー（http://localhost:5173）
npm run check    # TypeScript 型検査
npm run build    # 型検査 → dist/ 生成
npm run preview  # dist/ のローカル確認
```

## 構成

- `public/data/`: レール（63種）・車両（10種）・情景・橋脚・手本コース（11本）の JSON / FBX データ
- `src/`: Three.js ランタイム・配置・重なり判定・経路構築・列車走行・UI

## 操作

配置モードが既定。`Tab` で走行モードへ切り替えます。

| 配置 | 内容 |
|---|---|
| 棚から部品を選び、白い玉をクリック | その端にゴーストを表示（置けない形は赤） |
| ゴーストをクリック | 配置確定（開いた端が1つなら連続配置） |
| 同じ部品をもう一度 / `C` | 置き方（向き・面）を切替 |
| 部品を持ってマットをクリック | 自由配置（`Q`/`E` で回転、`PageUp`/`PageDown` で階層） |
| 部品をクリック | 選択（`Delete` で削除、同形状で差し替え、全体上下・複製・トンネル・鉄橋） |
| `Ctrl+Z` / `Esc` | 元に戻す / 選択解除 |
| 左ドラッグ・右ドラッグ・ホイール | 視点の移動・回転・ズーム |

| 走行 | 内容 |
|---|---|
| スペース / `↑↓` / `R` | 発車・停止 / 速度調整 / 反転 |
| `N` | 操作・視点対象の編成を切替 |
| 分岐レールをクリック | 自動（水色）→ 固定（緑・だいだい・紫） |

## GitHub Pages 公開

```bash
npm run deploy   # ビルド → dist/ を gh-pages ブランチへ公開
```

GitHub リポジトリの **Settings → Pages → Source** で `Deploy from a branch`（`gh-pages` / `/ (root)`）が設定されています。

## クレジット

- 3D 描画: [Three.js](https://threejs.org/) (MIT License)

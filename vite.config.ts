import { defineConfig } from "vite";

// 配布は dist/ を置くだけ。相対パスにして GitHub Pages のサブパス配下でもそのまま動かす
// server.host: LAN のスマホから開いて実機確認できるようにする
export default defineConfig({
  base: "./",
  server: { host: true, port: 5173 },
});

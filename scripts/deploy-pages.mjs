// dist/ を .nojekyll 付きで gh-pages ブランチへデプロイする
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const dist = path.join(root, "dist");
if (!fs.existsSync(path.join(dist, "index.html"))) {
  console.error("dist/index.html が見つかりません。先に npm run build を実行してください。");
  process.exit(1);
}

const remoteUrl = execSync("git remote get-url origin", { cwd: root, encoding: "utf8" }).trim();
const userName = execSync("git config user.name", { cwd: root, encoding: "utf8" }).trim();
const userEmail = execSync("git config user.email", { cwd: root, encoding: "utf8" }).trim();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bluerail-pages-"));
try {
  fs.cpSync(dist, tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, ".nojekyll"), "");

  const run = (cmd) => execSync(cmd, { cwd: tmp, stdio: "inherit" });
  run("git init -b gh-pages");
  run(`git config user.name "${userName}"`);
  run(`git config user.email "${userEmail}"`);
  run("git add -A");
  run('git commit -m "Deploy dist to GitHub Pages"');
  run(`git push --force "${remoteUrl}" gh-pages:gh-pages`);
  console.log("Deployed dist/ to gh-pages successfully.");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rolldown } from "rolldown";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "node_modules", ".vite-temp", "easy-test");
fs.mkdirSync(outDir, { recursive: true });
const bundleFile = path.join(outDir, "easy-bundle.mjs");

// src/easy.ts と検証に必要な幾何モジュールをまとめる
const entryFile = path.join(outDir, "entry.ts");
fs.writeFileSync(
  entryFile,
  `export * from ${JSON.stringify(path.join(root, "src", "catalog.ts"))};
export * from ${JSON.stringify(path.join(root, "src", "place.ts"))};
export * from ${JSON.stringify(path.join(root, "src", "overlap.ts"))};
export * from ${JSON.stringify(path.join(root, "src", "track.ts"))};
export * from ${JSON.stringify(path.join(root, "src", "route.ts"))};
export * from ${JSON.stringify(path.join(root, "src", "easy.ts"))};
`,
);

const build = await rolldown({ input: entryFile });
await build.write({ file: bundleFile, format: "esm" });
await build.close();

const mod = await import(pathToFileURL(bundleFile).href);
const {
  Catalog,
  openPorts,
  findOverlaps,
  looseJoints,
  buildRoute,
  planToPoint,
  planToPort,
  planBranchToPoint,
  planMergeIntoPiece,
  planBranchAndMerge,
  planAutoClose,
  planMatTap,
  applyPlanToPieces,
  branchVariants,
} = mod;

const bundleData = JSON.parse(fs.readFileSync(path.join(root, "public", "data", "bundle.json"), "utf8"));
const catalog = new Catalog(bundleData.rails.map((d) => [d.id, d]));
const HALF_W = 0.53;

function auditPieces(pieces, label) {
  const loose = looseJoints(catalog, pieces);
  const overlaps = [];
  for (let i = 0; i < pieces.length; i++) {
    const rest = pieces.filter((_, j) => j !== i);
    const hits = findOverlaps(catalog, rest, pieces[i], openPorts(catalog, rest), HALF_W);
    if (hits.length) overlaps.push({ i, kind: pieces[i].kind, hits });
  }
  if (loose.length || overlaps.length) {
    console.error(`FAIL [${label}]: loose=${loose.length} overlaps=${overlaps.length}`);
    if (loose.length) console.error("  loose:", loose.slice(0, 3));
    if (overlaps.length) console.error("  overlaps:", overlaps.slice(0, 3));
    return false;
  }
  return true;
}

function makeStart() {
  return [
    {
      kind: "Straight",
      position: { x: 0, y: 0, z: 0 },
      euler: { x: 0, y: 0, z: 0 },
      state: "",
      lift: 0,
      liftFrom: "",
      branchSet: false,
      autoFlip: false,
    },
  ];
}

let failures = 0;
function check(ok, msg) {
  if (ok) console.log(`  PASS: ${msg}`);
  else {
    console.error(`  FAIL: ${msg}`);
    failures++;
  }
}

function timed(name, fn) {
  const t0 = performance.now();
  const res = fn();
  const ms = (performance.now() - t0).toFixed(1);
  console.log(`[${name}] (${ms}ms)`);
  return res;
}

// 1. 基本方向テスト（左/右を意識せずにタップ方向で自動選択）
{
  const pieces = makeStart();
  const open = openPorts(catalog, pieces);
  const end = open.find((o) => o.id === "End"); // (0, 0, -6), outward = -z

  const pStraight = timed("1a. Tap straight ahead", () => planToPoint(catalog, pieces, open, end, 0, -12, 0, HALF_W));
  check(pStraight.length > 0 && pStraight[0].additions[0].kind === "Straight", `ahead -> ${pStraight[0]?.additions.map((a) => a.kind).join("+")}`);

  const pLeft = timed("1b. Tap left (+x, -z)", () => planToPoint(catalog, pieces, open, end, 4, -10, 0, HALF_W));
  check(pLeft.length > 0 && pLeft[0].additions[0].kind === "Left", `left -> ${pLeft[0]?.additions.map((a) => a.kind).join("+")}`);

  const pRight = timed("1c. Tap right (-x, -z)", () => planToPoint(catalog, pieces, open, end, -4, -10, 0, HALF_W));
  check(pRight.length > 0 && pRight[0].additions[0].kind === "Right", `right -> ${pRight[0]?.additions.map((a) => a.kind).join("+")}`);

  const pHalf = timed("1d. Tap short ahead", () => planToPoint(catalog, pieces, open, end, 0, -9, 0, HALF_W));
  check(pHalf.length > 0 && pHalf[0].additions[0].kind === "HalfStraight", `short -> ${pHalf[0]?.additions.map((a) => a.kind).join("+")}`);
}

// 2. マット連続タップだけでオーバルを作って自動閉合（輪にする）
{
  let pieces = makeStart();
  // End は (0,0,-6) から -z 向き
  const taps = [
    [0, -14],
    [10, -20],
    [12, -8],
    [10, 4],
  ];
  for (let i = 0; i < taps.length; i++) {
    const [tx, tz] = taps[i];
    const open = openPorts(catalog, pieces);
    const plans = timed(`2.${i + 1}. Tap (${tx}, ${tz})`, () => planMatTap(catalog, pieces, open, null, tx, tz, 0, 0, HALF_W));
    check(plans.length > 0, `found ${plans.length} plans: ${plans[0]?.additions.map((a) => a.kind).join("+")}`);
    if (plans[0]) pieces = applyPlanToPieces(pieces, plans[0]);
  }
  const closePlans = timed("2.close. Auto-close loop", () => planAutoClose(catalog, pieces, openPorts(catalog, pieces), null, HALF_W));
  check(closePlans.length > 0, `auto-close found: ${closePlans[0]?.additions.map((a) => a.kind).join("+")}`);
  if (closePlans[0]) {
    pieces = applyPlanToPieces(pieces, closePlans[0]);
    check(auditPieces(pieces, "oval auto-close"), "no loose joints / no overlaps");
    const openAfter = openPorts(catalog, pieces);
    check(openAfter.length === 0, `open ports after close = ${openAfter.length}`);
    const route = buildRoute(catalog, pieces);
    check(route.closed && route.length > 20, `route closed=${route.closed}, len=${route.length.toFixed(1)}m`);
  }
}

// 3. 高架（2階へ自動スロープ → 地上へ自動スロープ）
{
  let pieces = makeStart();
  let open = openPorts(catalog, pieces);
  let end = open.find((o) => o.id === "End");
  const upPlans = timed("3a. Climb to 2F", () => planToPoint(catalog, pieces, open, end, 0, -24, 1, HALF_W));
  check(
    upPlans.length > 0 && upPlans[0].additions.some((a) => a.kind === "SlopeUpOriginal"),
    `up -> ${upPlans[0]?.additions.map((a) => a.kind).join("+")}`,
  );
  if (upPlans[0]) {
    pieces = applyPlanToPieces(pieces, upPlans[0]);
    check(auditPieces(pieces, "climb 2F"), "2F geometry clean");
    open = openPorts(catalog, pieces);
    const highEnd = open.find((o) => o.pos[1] > 1.0);
    check(!!highEnd, `highEnd y=${highEnd?.pos[1].toFixed(2)}`);
    if (highEnd) {
      const downPlans = timed("3b. Descend to 1F", () => planToPoint(catalog, pieces, open, highEnd, 0, highEnd.pos[2] - 18, 0, HALF_W));
      check(
        downPlans.length > 0 && downPlans[0].additions.some((a) => a.kind === "SlopeDownOriginal"),
        `down -> ${downPlans[0]?.additions.map((a) => a.kind).join("+")}`,
      );
      if (downPlans[0]) {
        pieces = applyPlanToPieces(pieces, downPlans[0]);
        check(auditPieces(pieces, "descend 1F"), "1F return geometry clean");
      }
    }
  }
}

// 4. 定番レイアウト1 の既存直線から自動分岐（外へ伸ばす）
{
  const course = JSON.parse(fs.readFileSync(path.join(root, "public", "data", "Courses", "定番レイアウト1.json"), "utf8"));
  let pieces = course.pieces;
  const open = openPorts(catalog, pieces);
  // Piece 5: Straight at (16.5, 0, 9.833) euler.y=90 -> goes from x=16.5 to x=10.5 along z=9.833
  const vars = timed("4a. Branch variants on 定番 Straight #5", () => branchVariants(catalog, pieces, open, 5, HALF_W));
  check(vars.length > 0, `found ${vars.length} collision-free branch variants`);

  const branchPlans = timed("4b. Branch outward from #5 to (8, 18)", () =>
    planBranchToPoint(catalog, pieces, open, 5, 8, 18, 0, HALF_W),
  );
  check(branchPlans.length > 0, `branch plan: rep=${branchPlans[0]?.replacements[0]?.piece.kind}, add=${branchPlans[0]?.additions.map((a) => a.kind).join("+")}`);
  if (branchPlans[0]) {
    const nextPieces = applyPlanToPieces(pieces, branchPlans[0]);
    check(auditPieces(nextPieces, "teiban branch #5"), "teiban branch geometry clean");
    check(openPorts(catalog, nextPieces).length === 1, `open ports after branch = ${openPorts(catalog, nextPieces).length}`);
  }
}

// 5. 定番レイアウト1 の連続 1/2直線（手前中央 #31〜#35）からも自動分岐できるか
{
  const course = JSON.parse(fs.readFileSync(path.join(root, "public", "data", "Courses", "定番レイアウト1.json"), "utf8"));
  const pieces = course.pieces;
  const open = openPorts(catalog, pieces);
  const halfIdx = pieces.findIndex((p, i) => i >= 30 && p.kind === "HalfStraight" && Math.abs(p.position.z - -8.166658) < 0.05);
  check(halfIdx >= 0, `found front HalfStraight at index ${halfIdx}`);
  if (halfIdx >= 0) {
    const branchPlans = timed("5. Branch outward from HalfStraight pair to (-2, -16)", () =>
      planBranchToPoint(catalog, pieces, open, halfIdx, -2, -16, 0, HALF_W),
    );
    check(
      branchPlans.length > 0 && branchPlans[0].replacements[0]?.indices.length === 2,
      `half-pair branch: replaced ${branchPlans[0]?.replacements[0]?.indices.join("&")} -> ${branchPlans[0]?.replacements[0]?.piece.kind} + ${branchPlans[0]?.additions.map((a) => a.kind).join("+")}`,
    );
    if (branchPlans[0]) {
      const nextPieces = applyPlanToPieces(pieces, branchPlans[0]);
      check(auditPieces(nextPieces, "teiban half-pair branch"), "half-pair branch geometry clean");
    }
  }
}

// 6. オーバルでの自動分岐＋自動合流（両端自動ターンアウト）
{
  const ovalCourse = JSON.parse(fs.readFileSync(path.join(root, "public", "data", "Courses", "大きな周回.json"), "utf8"));
  const pieces = ovalCourse.pieces;
  const open = openPorts(catalog, pieces);
  const straights = pieces.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === "Straight");
  console.log(`  大きな周回 has ${straights.length} straights`);
  if (straights.length >= 4) {
    // 同じ辺の少し離れた直線どうし、または向かい合う直線どうしでテスト
    const a = straights[0].i;
    const b = straights[Math.min(straights.length - 1, Math.floor(straights.length / 2))].i;
    const bmPlans = timed(`6a. Branch+Merge straight #${a} -> #${b}`, () =>
      planBranchAndMerge(catalog, pieces, open, a, b, HALF_W),
    );
    check(bmPlans.length > 0, `branch+merge: reps=${bmPlans[0]?.replacements.map((r) => r.piece.kind).join("+")}, add=${bmPlans[0]?.additions.map((x) => x.kind).join("+")}`);
    if (bmPlans[0]) {
      const nextPieces = applyPlanToPieces(pieces, bmPlans[0]);
      check(auditPieces(nextPieces, "branch+merge"), "branch+merge geometry clean");
      check(openPorts(catalog, nextPieces).length === 0, `open ports after branch+merge = ${openPorts(catalog, nextPieces).length}`);
      const r = buildRoute(catalog, nextPieces);
      check(r.closed, `route closed=${r.closed}, len=${r.length.toFixed(1)}m`);
    }

    // 6b. まず #a から分岐して外へ1〜2本出し、その後 #b へ合流 (planMergeIntoPiece)
    const pA = pieces[a].position;
    const b1 = timed(`6b. Step1 branch from #${a}`, () =>
      planBranchToPoint(catalog, pieces, open, a, pA.x, pA.z + 10, 0, HALF_W),
    );
    if (b1[0]) {
      const midPieces = applyPlanToPieces(pieces, b1[0]);
      const midOpen = openPorts(catalog, midPieces);
      const midEnd = midOpen[0];
      // midPieces の中で別の直線を探す
      const otherStraight = midPieces.findIndex((p, idx) => p.kind === "Straight" && Math.hypot(p.position.x - pA.x, p.position.z - pA.z) > 8);
      if (midEnd && otherStraight >= 0) {
        const mPlans = timed(`6c. Step2 merge open end into straight #${otherStraight}`, () =>
          planMergeIntoPiece(catalog, midPieces, midOpen, midEnd, otherStraight, HALF_W),
        );
        check(mPlans.length > 0, `merge: rep=${mPlans[0]?.replacements[0]?.piece.kind}, add=${mPlans[0]?.additions.map((x) => x.kind).join("+")}`);
        if (mPlans[0]) {
          const finalPieces = applyPlanToPieces(midPieces, mPlans[0]);
          check(auditPieces(finalPieces, "2-step branch+merge"), "2-step geometry clean");
          check(openPorts(catalog, finalPieces).length === 0, `open ports = ${openPorts(catalog, finalPieces).length}`);
        }
      }
    }
  }
}

// 7. 斜め 1/2直線 を含む U字からの自動閉合（ダイレクト FlexRail 補完の回帰テスト）
{
  let pieces = makeStart();
  for (const [tx, tz] of [[0, -12], [10, -16], [12, -2]]) {
    const open = openPorts(catalog, pieces);
    const plans = planMatTap(catalog, pieces, open, null, tx, tz, 0, 0, HALF_W);
    if (plans[0]) pieces = applyPlanToPieces(pieces, plans[0]);
  }
  const open = openPorts(catalog, pieces);
  const tipEnd = open.find((o) => o.piece === pieces.length - 1) ?? open[0];
  const closePlans = timed("7. Close diagonal U-shape loop", () => planAutoClose(catalog, pieces, open, tipEnd, HALF_W));
  check(closePlans.length > 0, `U-shape close -> ${closePlans[0]?.summary}`);
  if (closePlans[0]) {
    const finalPieces = applyPlanToPieces(pieces, closePlans[0]);
    check(auditPieces(finalPieces, "U-shape close"), "U-shape geometry clean");
    check(openPorts(catalog, finalPieces).length === 0, `U-shape open ports = ${openPorts(catalog, finalPieces).length}`);
    const r = buildRoute(catalog, finalPieces);
    check(r.closed, `U-shape route closed=${r.closed}, len=${r.length.toFixed(1)}m`);
  }
}

console.log(failures === 0 ? "\nALL TESTS PASSED!" : `\nFAILED: ${failures} assertions`);
process.exit(failures === 0 ? 0 : 1);

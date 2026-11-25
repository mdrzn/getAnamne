import { createRequire } from "module";
import assert from "assert";
const require = createRequire(import.meta.url);
const P = require("../parsers.js");

let pass = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log("  ✓", name); } catch (e) { console.error("  ✗", name, "\n   ", e.message); process.exitCode = 1; } };

// An image node shaped like the real Gemini payload:
// [null,1,filename,lh3-url,null,"$tok",null,null,1,[ts],null,mime,null,null,null,[w,h,size]]
const img = (fn, url, mime, w, h, size) =>
  [null, 1, fn, url, null, "$tok", null, null, 1, [1, 2], null, mime, null, null, null, [w, h, size]];

// inner = an upload variant group (png+jpg of one upload) and a generated variant
// group (small png + large png + jpeg of one generation), nested as Gemini nests them.
const inner = ["hdr", [
  [[img("up.png", "https://lh3.googleusercontent.com/gg/UP1", "image/png", 640, 360, 1000)],
   [img("up.jpg", "https://lh3.googleusercontent.com/gg/UP2", "image/jpeg", 640, 360, 800)]],
  [[img("gen_small.png", "https://lh3.googleusercontent.com/gg/G1", "image/png", 1365, 768, 1600)],
   [img("gen_large.png", "https://lh3.googleusercontent.com/gg/G2", "image/png", 2730, 1536, 6000)],
   null,
   [img("gen.jpeg", "https://lh3.googleusercontent.com/gg/G3", "image/jpeg", 1365, 768, 560)]],
]];
const raw = ")]}'\n\n[[\"wrb.fr\",\"hNvQHb\"," + JSON.stringify(JSON.stringify(inner)) + ",null,null,null,\"generic\"]]";

ok("keeps one image per variant group (largest, png preferred)", () => {
  const a = P.geminiImageAssets(raw);
  assert.deepEqual(a.map((x) => x.fileId).sort(), ["gen_large.png", "up.png"]);
});

ok("the generated asset is the full-res png with its lh3 url + dims", () => {
  const g = P.geminiImageAssets(raw).find((x) => x.fileId === "gen_large.png");
  assert.equal(g.url, "https://lh3.googleusercontent.com/gg/G2");
  assert.equal(g.mime, "image/png");
  assert.equal(g.width, 2730); assert.equal(g.height, 1536);
});

ok("drops the smaller png and the jpeg duplicate of the same generation", () => {
  const ids = P.geminiImageAssets(raw).map((x) => x.fileId);
  assert.ok(!ids.includes("gen_small.png") && !ids.includes("gen.jpeg"));
});

ok("returns [] when there's no hNvQHb payload", () => {
  assert.deepEqual(P.geminiImageAssets(")]}'\n\n[[\"wrb.fr\",\"otAQ7b\",\"[]\"]]"), []);
});

console.log(`\n${pass} checks passed.`);

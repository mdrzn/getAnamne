import { createRequire } from "module";
import assert from "assert";
const require = createRequire(import.meta.url);
const P = require("../parsers.js");

let pass = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log("  ✓", name); } catch (e) { console.error("  ✗", name, "\n   ", e.message); process.exitCode = 1; } };

const conv = { id: "conv-123", title: "Test", platform: "chatgpt" };

ok("builds a vault-relative path per asset under _attachments/<shortId>", () => {
  const paths = P.assetVaultPaths(conv, [{ fileId: "f1", filename: "Team photo.png", mime: "image/png" }]);
  assert.equal(paths.length, 1);
  assert.equal(paths[0].vaultName, "Team photo.png");
  assert.equal(paths[0].relPath, "../_attachments/conv123/Team photo.png");
});

ok("uniquifies duplicate filenames, keeping the extension", () => {
  const paths = P.assetVaultPaths(conv, [
    { fileId: "a", filename: "scene.png", mime: "image/png" },
    { fileId: "b", filename: "scene.png", mime: "image/png" },
  ]);
  assert.deepEqual(paths.map((p) => p.vaultName), ["scene.png", "scene-2.png"]);
});

ok("adds an extension from mime when the name has none", () => {
  const paths = P.assetVaultPaths(conv, [{ fileId: "a", filename: "diagram", mime: "image/jpeg" }]);
  assert.ok(/\.jpg$/.test(paths[0].vaultName));
});

ok("attachmentsMarkdown embeds each asset with an angle-bracket relative link", () => {
  const md = P.attachmentsMarkdown(conv, [{ fileId: "a", filename: "Team photo.png", mime: "image/png" }]);
  assert.ok(md.includes("## 🖼 Images"));
  assert.ok(md.includes("![Team photo.png](<../_attachments/conv123/Team photo.png>)"));
});

ok("attachmentsMarkdown is empty when there are no assets", () => {
  assert.equal(P.attachmentsMarkdown(conv, []), "");
  assert.equal(P.attachmentsMarkdown(conv, null), "");
});

console.log(`\n${pass} checks passed.`);

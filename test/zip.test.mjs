import { createRequire } from "module";
import assert from "assert";
import { execFileSync } from "child_process";
import { writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
const require = createRequire(import.meta.url);
const { buildZip, crc32 } = require("../zip.js");

let pass = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ✓", name); }
  catch (e) { console.error("  ✗", name, "\n   ", e.message); process.exitCode = 1; }
};

const enc = (s) => new TextEncoder().encode(s);

// Read a zip back with Python's zipfile (an independent implementation) and
// return {name: text} for every entry, after its CRC check (testzip).
function readBack(bytes) {
  const dir = mkdtempSync(join(tmpdir(), "anamne-zip-"));
  const file = join(dir, "t.zip");
  writeFileSync(file, bytes);
  const py = `import zipfile,json,sys
z=zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
print(json.dumps({i.filename: z.read(i).decode('utf-8','replace') for i in z.infolist()}))`;
  return JSON.parse(execFileSync("python3", ["-I", "-c", py, file]).toString());
}

ok("crc32 matches the standard check value", () => {
  assert.strictEqual(crc32(enc("123456789")), 0xcbf43926);
});

ok("zip with nested paths and UTF-8 names reads back intact", () => {
  const z = buildZip([
    { name: "AI Conversations/ChatGPT/2026-11-21 Café menu ideas, résumé (abc).md", data: enc("# Hello\n\ncafé déjà vu") },
    { name: "AI Conversations/_attachments/abc/img.png", data: new Uint8Array([0, 1, 2, 255]) },
  ]);
  const out = readBack(z);
  assert.deepStrictEqual(Object.keys(out), [
    "AI Conversations/ChatGPT/2026-11-21 Café menu ideas, résumé (abc).md",
    "AI Conversations/_attachments/abc/img.png",
  ]);
  assert.strictEqual(out["AI Conversations/ChatGPT/2026-11-21 Café menu ideas, résumé (abc).md"], "# Hello\n\ncafé déjà vu");
});

ok("empty archive is a valid zip", () => {
  assert.deepStrictEqual(readBack(buildZip([])), {});
});

ok("duplicate names get a numeric suffix", () => {
  const out = readBack(buildZip([
    { name: "a/x.md", data: enc("1") },
    { name: "a/x.md", data: enc("2") },
  ]));
  assert.deepStrictEqual(out, { "a/x.md": "1", "a/x (2).md": "2" });
});

console.log(`zip: ${pass} passed`);

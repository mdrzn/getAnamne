import { createRequire } from "module";
import assert from "assert";
const require = createRequire(import.meta.url);
const P = require("../parsers.js");
const { renderMarkdown } = require("../md.js");

let pass = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ✓", name); }
  catch (e) { console.error("  ✗", name, "\n   ", e.message); process.exitCode = 1; }
};

const RAW = [
  "| Test | 2023 | 2025 |",
  "|---|---:|:---:|",
  "| Total cholesterol | 170 | 161 |",
  "| HDL | 37 | — |",
].join("\n");

ok("alignTables pads every column to the same width, keeping alignment markers", () => {
  assert.equal(P.alignTables(RAW), [
    "| Test              | 2023 | 2025 |",
    "|-------------------|-----:|:----:|",
    "| Total cholesterol |  170 | 161  |",
    "| HDL               |   37 |  —   |",
  ].join("\n"));
});

ok("alignTables leaves text around the table and code blocks alone", () => {
  const src = "Results:\n\n" + RAW + "\n\nDone.\n\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n```";
  const out = P.alignTables(src);
  assert.ok(out.startsWith("Results:\n\n| Test              |"), out);
  assert.ok(out.endsWith("Done.\n\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n```"), out);
});

ok("alignTables handles missing outer pipes, short rows, escaped pipes and inline code", () => {
  const out = P.alignTables("a | b\n--|--\nx \\| y | `p|q`\nz");
  assert.equal(out, [
    "| a      | b     |",
    "|--------|-------|",
    "| x \\| y | `p|q` |",
    "z",
  ].join("\n"));
  assert.equal(P.alignTables("| a | b |\n|---|---|\n| only |"), "| a    | b   |\n|------|-----|\n| only |     |");
});

ok("alignTables counts wide characters as two columns", () => {
  const out = P.alignTables("| k | v |\n|---|---|\n| 日本 | x |\n| ab | y |");
  assert.equal(out, "| k    | v   |\n|------|-----|\n| 日本 | x   |\n| ab   | y   |");
});

ok("alignTables ignores pipes that aren't a table", () => {
  const s = "a | b\nnot a separator\n| x |";
  assert.equal(P.alignTables(s), s);
});

ok("toObsidianMarkdown writes aligned tables", () => {
  const md = P.toObsidianMarkdown({ id: "t1", platform: "chatgpt", title: "T", messages: [{ role: "assistant", text: RAW }] });
  assert.ok(md.includes("| Total cholesterol |  170 | 161  |"), md);
});

ok("reader renders a table with header, body and alignment", () => {
  const h = renderMarkdown("Intro\n\n" + RAW);
  assert.ok(h.includes("<table>"), h);
  assert.ok(/<th>Test<\/th><th class="r">2023<\/th><th class="c">2025<\/th>/.test(h), h);
  assert.ok(/<td>Total cholesterol<\/td><td class="r">170<\/td><td class="c">161<\/td>/.test(h), h);
  assert.ok(h.includes("<p>Intro</p>"), h);
});

ok("reader table cells keep inline formatting and stay escaped", () => {
  const h = renderMarkdown("| a | b |\n|---|---|\n| **bold** | <b>x</b> |");
  assert.ok(h.includes("<td><strong>bold</strong></td>"), h);
  assert.ok(h.includes("<td>&lt;b&gt;x&lt;/b&gt;</td>"), h);
});

console.log(`\n${pass} checks passed.`);

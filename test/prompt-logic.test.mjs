import { createRequire } from "module";
import assert from "assert";
const require = createRequire(import.meta.url);
const { extractVariables, applyVariables, filterPrompts } = require("../prompt-logic.js");

let pass = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ✓", name); }
  catch (e) { console.error("  ✗", name, "\n   ", e.message); process.exitCode = 1; }
};

// --- extractVariables ---
ok("extractVariables: unique, ordered, trimmed names", () => {
  const vars = extractVariables("Summarize {{text}} in {{ n }} points, tone {{text}}.");
  assert.deepEqual(vars, ["text", "n"]);
});
ok("extractVariables: none → empty array", () => {
  assert.deepEqual(extractVariables("Just a plain prompt."), []);
});
ok("extractVariables: ignores empty/whitespace-only tokens", () => {
  assert.deepEqual(extractVariables("a {{}} b {{   }} c {{x}}"), ["x"]);
});

// --- applyVariables ---
ok("applyVariables: substitutes all occurrences by trimmed name", () => {
  const out = applyVariables("Hi {{name}}, bye {{ name }} about {{topic}}", { name: "Sam", topic: "AI" });
  assert.equal(out, "Hi Sam, bye Sam about AI");
});
ok("applyVariables: missing value → empty string", () => {
  assert.equal(applyVariables("X {{a}} Y {{b}}", { a: "1" }), "X 1 Y ");
});

// --- filterPrompts ---
const prompts = [
  { id: "1", title: "Code review", body: "Review this {{code}} for bugs", tags: ["dev"], useCount: 2, updatedAt: 100 },
  { id: "2", title: "Email draft", body: "Write a friendly email about {{topic}}", tags: ["writing"], useCount: 9, updatedAt: 50 },
  { id: "3", title: "Bug repro", body: "Steps to reproduce", tags: ["dev", "qa"], useCount: 2, updatedAt: 200 },
];
ok("filterPrompts: empty query → all, most-used then newest", () => {
  const r = filterPrompts(prompts, "");
  assert.deepEqual(r.map((p) => p.id), ["2", "3", "1"]);
});
ok("filterPrompts: query matches title/body/tags, case-insensitive", () => {
  assert.deepEqual(filterPrompts(prompts, "EMAIL").map((p) => p.id), ["2"]);
  assert.deepEqual(filterPrompts(prompts, "dev").map((p) => p.id).sort(), ["1", "3"]);
});
ok("filterPrompts: multi-token AND across haystack", () => {
  assert.deepEqual(filterPrompts(prompts, "reproduce steps").map((p) => p.id), ["3"]);
});

console.log(`\n${pass} checks passed.`);

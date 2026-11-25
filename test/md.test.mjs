import { createRequire } from "module";
import assert from "assert";
const require = createRequire(import.meta.url);
const { renderMarkdown } = require("../md.js");

let pass = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ✓", name); }
  catch (e) { console.error("  ✗", name, "\n   ", e.message); process.exitCode = 1; }
};

ok("escapes HTML to prevent injection", () => {
  const h = renderMarkdown('<img src=x onerror=alert(1)> & <b>hi</b>');
  assert.ok(!h.includes("<img"), "raw tag removed: " + h);
  assert.ok(h.includes("&lt;img"), "angle brackets escaped");
  assert.ok(h.includes("&amp;"), "ampersand escaped");
});

ok("bold and italic", () => {
  assert.ok(renderMarkdown("a **bold** b").includes("<strong>bold</strong>"));
  assert.ok(renderMarkdown("a *it* b").includes("<em>it</em>"));
});

ok("inline code is escaped and wrapped", () => {
  const h = renderMarkdown("use `a < b` here");
  assert.ok(h.includes("<code>a &lt; b</code>"), h);
});

ok("fenced code block preserves content, escaped", () => {
  const h = renderMarkdown("```\nconst x = a < b;\n```");
  assert.ok(h.includes("<pre><code>"), h);
  assert.ok(h.includes("const x = a &lt; b;"), h);
  assert.ok(!/<strong>|<em>/.test(h), "no inline formatting inside code");
});

ok("headings map to h-tags", () => {
  assert.ok(renderMarkdown("## Title").includes("<h2>Title</h2>"));
  assert.ok(renderMarkdown("### Sub").includes("<h3>Sub</h3>"));
});

ok("unordered and ordered lists", () => {
  const u = renderMarkdown("- one\n- two");
  assert.ok(u.includes("<ul>") && u.includes("<li>one</li>") && u.includes("<li>two</li>"), u);
  const o = renderMarkdown("1. a\n2. b");
  assert.ok(o.includes("<ol>") && o.includes("<li>a</li>"), o);
});

ok("safe links only (http/https), others dropped to text", () => {
  const good = renderMarkdown("[site](https://x.com)");
  assert.ok(good.includes('<a href="https://x.com"') && good.includes('rel="noopener noreferrer"'), good);
  const bad = renderMarkdown("[x](javascript:alert(1))");
  assert.ok(!bad.includes("javascript:"), "dangerous scheme dropped: " + bad);
});

ok("inline-code placeholder doesn't collide with plain numbers", () => {
  const h = renderMarkdown("I have 5 cats and `code` here");
  assert.ok(h.includes("I have 5 cats"), "plain number untouched: " + h);
  assert.ok(h.includes("<code>code</code>"), h);
});

ok("paragraphs separated by blank lines", () => {
  const h = renderMarkdown("para one\n\npara two");
  assert.ok((h.match(/<p>/g) || []).length === 2, h);
});

console.log(`\n${pass} checks passed.`);

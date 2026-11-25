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
const clean = P.cleanChatGPTMarkup;

// Shapes taken from real ChatGPT answers (Nov 2026), text replaced.
const WRITING = '<WritingBlock id="58321" variant="chat_message">Hello, could you send me the minutes of the last meetings?\n\nI would also like to know about planned repairs.\n\nThanks!</WritingBlock>';
const CARDS = [
  "Three things to clarify.",
  "",
  "<box gap={3}>",
  '<row align="start" gap={3}>',
  '<icon name="alert-circle" color="secondary" size="lg"/>',
  '<box flex="1" gap={1}>',
  "Third or fourth floor?",
  "",
  "The energy certificate says third floor. The technical report says fourth.",
  "</box>",
  "</row>",
  '<divider color="subtle"/>',
  '<row align="start" gap={3}>',
  '<icon name="alert-circle" color="secondary" size="lg"/>',
  '<box flex="1" gap={1}>',
  "Cadastral reference",
  "</box>",
  "</row>",
  "</box>",
].join("\n");

ok("WritingBlock becomes a blockquote with its paragraphs", () => {
  assert.equal(clean(WRITING),
    "> Hello, could you send me the minutes of the last meetings?\n>\n> I would also like to know about planned repairs.\n>\n> Thanks!");
});

ok("text around a WritingBlock is kept", () => {
  assert.equal(clean("Here's a draft:\n\n" + WRITING + "\n\nSend it today."),
    "Here's a draft:\n\n> Hello, could you send me the minutes of the last meetings?\n>\n> I would also like to know about planned repairs.\n>\n> Thanks!\n\nSend it today.");
});

ok("layout tags and icons disappear, dividers become ---, text stays", () => {
  assert.equal(clean(CARDS), [
    "Three things to clarify.",
    "",
    "Third or fourth floor?",
    "",
    "The energy certificate says third floor. The technical report says fourth.",
    "",
    "---",
    "",
    "Cadastral reference",
  ].join("\n"));
});

ok("indented lines inside layouts are dedented so they don't turn into code", () => {
  assert.equal(clean("<box>\n    <row>\n        Some text\n    </row>\n</box>"), "Some text");
});

ok("inline markup: titles, badges, entities, links, citations", () => {
  assert.equal(clean('<title>Summary</title>'), "**Summary**");
  assert.equal(clean('Price <badge color="green">low</badge> today'), "Price low today");
  assert.equal(clean('Visit <Entity type="place" value="Kyoto"/> in spring.'), "Visit Kyoto in spring.");
  assert.equal(clean('See <Link url="https://example.com" title="the docs"/>.'), "See [the docs](https://example.com).");
  assert.equal(clean('It rained a lot.<Cite id="turn0search3"/> And `<Cite id="turn0search4"/>` again.'), "It rained a lot. And again.");
  assert.equal(clean('Done <icon name="check"/> now'), "Done now");
});

ok("list items become Markdown bullets", () => {
  assert.equal(clean("<list>\n<list-item>First</list-item>\n<list-item>Second</list-item>\n</list>"), "- First\n- Second");
});

ok("CodeBlock becomes a fenced block with its content untouched", () => {
  assert.equal(clean('<CodeBlock language="python">\nif a < b:\n    print("<box>")\n</CodeBlock>'),
    '```python\nif a < b:\n    print("<box>")\n```');
});

ok("charts, images and inputs are dropped", () => {
  assert.equal(clean('Before\n<Chart type="bar" data={rows}/>\n<AsyncImageGroup query="kyoto"/>\n<button label="Go"/>\nAfter'), "Before\n\nAfter");
});

ok("fenced code and ordinary text are never touched", () => {
  const s = "Use `<box>` in JSX.\n\n```html\n<box gap={3}>\n<icon name=\"x\"/>\n</box>\n```\n\na < b and b > c";
  assert.equal(clean(s), s);
});

ok("running it twice changes nothing", () => {
  const once = clean(CARDS + "\n\n" + WRITING);
  assert.equal(clean(once), once);
});

ok("parseChatGPT stores the cleaned text", () => {
  const conv = { conversation_id: "u1", title: "T", mapping: {
    a: { id: "a", message: { id: "a", author: { role: "assistant" }, create_time: 1, content: { content_type: "text", parts: [CARDS] } } } } };
  const c = P.parseChatGPT(JSON.stringify(conv));
  assert.ok(!c.messages[0].text.includes("<"), c.messages[0].text);
});

ok("Obsidian export cleans ChatGPT records saved before this change", () => {
  const md = P.toObsidianMarkdown({ id: "o1", platform: "chatgpt", title: "T", messages: [{ role: "assistant", text: WRITING }] });
  assert.ok(md.includes("> Thanks!") && !md.includes("WritingBlock"), md);
});

ok("reader renders blockquotes and horizontal rules", () => {
  const h = renderMarkdown("> quoted **line**\n>\n> second\n\n---\n\nafter");
  assert.ok(h.includes("<blockquote><p>quoted <strong>line</strong></p><p>second</p></blockquote>"), h);
  assert.ok(h.includes("<hr>"), h);
  assert.ok(h.includes("<p>after</p>"), h);
});

console.log(`\n${pass} checks passed.`);

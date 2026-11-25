import { createRequire } from "module";
import assert from "assert";
const require = createRequire(import.meta.url);
const {
  parseChatGPT,
  parseClaude,
  parseDeepSeek,
  parseGrok,
  parsePerplexity,
  parseGemini,
  toMarkdown,
  toObsidianMarkdown,
  vaultFilename,
  platformFolder,
  sourceUrl,
  mergeMessages,
} = require("../parsers.js");

let pass = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ✓", name); }
  catch (e) { console.error("  ✗", name, "\n   ", e.message); process.exitCode = 1; }
};

// --- ChatGPT: full conversation tree shape (/backend-api/conversation/{uuid}) ---
const chatgptFixture = JSON.stringify({
  title: "Refactoring a Python script",
  conversation_id: "abc-123",
  current_node: "n3",
  mapping: {
    n0: { id: "n0", message: { author: { role: "system" }, content: { content_type: "text", parts: [""] }, create_time: 1 } },
    n1: { id: "n1", message: { author: { role: "user" }, content: { content_type: "text", parts: ["How do I refactor this?"] }, create_time: 2 } },
    n2: { id: "n2", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["Here's a cleaner version..."] }, create_time: 3 } },
    n3: { id: "n3", message: { author: { role: "tool" }, content: { content_type: "text", parts: ["(tool noise)"] }, create_time: 4 } },
  },
});

ok("ChatGPT: extracts user+assistant, drops system/tool", () => {
  const c = parseChatGPT(chatgptFixture);
  assert.equal(c.platform, "chatgpt");
  assert.equal(c.title, "Refactoring a Python script");
  assert.equal(c.id, "abc-123");
  assert.equal(c.messages.length, 2);
  assert.equal(c.messages[0].role, "user");
  assert.equal(c.messages[0].text, "How do I refactor this?");
  assert.equal(c.messages[1].role, "assistant");
});

ok("ChatGPT: strips Private-Use-Area special-content sentinels (image_group/entity/cite)", () => {
  // ChatGPT wraps inline image groups, entities, and citations in U+E200..E206
  // sentinel chars. They must not leak into the captured/exported text. Built
  // here with fromCodePoint so the test source stays free of raw PUA chars.
  const O = String.fromCodePoint(0xe200); // open
  const SEP = String.fromCodePoint(0xe202); // type/payload separator
  const E = String.fromCodePoint(0xe201); // close
  const part =
    "È un tettigonide.\n\n" +
    O + "image_group" + SEP + '{"query":["green cricket"]}' + E +
    "\n\nDalla foto si riconosce. " +
    O + "cite" + SEP + "turn0search1" + E +
    " Fine.";
  const polluted = JSON.stringify({
    title: "T", conversation_id: "p1",
    mapping: { a: { message: { author: { role: "assistant" }, content: { parts: [part] }, create_time: 1 } } },
  });
  const txt = parseChatGPT(polluted).messages[0].text;
  assert.ok(!/image_group|"query"|cite|turn0search/.test(txt), "sentinel payloads removed: " + JSON.stringify(txt));
  assert.ok(!/[-]/.test(txt), "no leftover private-use chars");
  assert.ok(txt.includes("È un tettigonide."), "real text kept");
  assert.ok(txt.includes("Dalla foto si riconosce."), "real text kept");
  assert.ok(txt.includes("Fine."), "trailing real text kept");
});

ok("ChatGPT: orders messages by create_time", () => {
  const scrambled = JSON.stringify({
    title: "T", conversation_id: "x",
    mapping: {
      a: { message: { author: { role: "assistant" }, content: { parts: ["second"] }, create_time: 10 } },
      b: { message: { author: { role: "user" }, content: { parts: ["first"] }, create_time: 5 } },
    },
  });
  const c = parseChatGPT(scrambled);
  assert.equal(c.messages[0].text, "first");
  assert.equal(c.messages[1].text, "second");
});

// --- Claude: chat_messages shape (/api/.../chat_conversations/{uuid}) ---
const claudeFixtureText = JSON.stringify({
  uuid: "claude-uuid-9",
  name: "Designing a database schema",
  chat_messages: [
    { sender: "human", text: "Help me design a schema", created_at: "2026-01-01T00:00:00Z" },
    { sender: "assistant", text: "Sure, start with these tables...", created_at: "2026-01-01T00:01:00Z" },
  ],
});

const claudeFixtureContentBlocks = JSON.stringify({
  uuid: "claude-uuid-10",
  name: "Blocks form",
  chat_messages: [
    { sender: "human", content: [{ type: "text", text: "Question in blocks" }] },
    { sender: "assistant", content: [{ type: "text", text: "Answer " }, { type: "text", text: "in blocks" }] },
  ],
});

ok("Claude: extracts from .text field", () => {
  const c = parseClaude(claudeFixtureText);
  assert.equal(c.platform, "claude");
  assert.equal(c.title, "Designing a database schema");
  assert.equal(c.id, "claude-uuid-9");
  assert.equal(c.messages.length, 2);
  assert.equal(c.messages[0].role, "user");
  assert.equal(c.messages[1].role, "assistant");
});

ok("Claude: falls back to content[].text blocks", () => {
  const c = parseClaude(claudeFixtureContentBlocks);
  assert.equal(c.messages[0].text, "Question in blocks");
  assert.equal(c.messages[1].text, "Answer \nin blocks");
});

ok("toMarkdown: labels speakers per platform", () => {
  const c = parseClaude(claudeFixtureText);
  const md = toMarkdown(c);
  assert.ok(md.includes("# Designing a database schema"));
  assert.ok(md.includes("**You:**"));
  assert.ok(md.includes("**Claude:**"));
});

ok("returns null on unrecognized payloads (so we don't store junk)", () => {
  assert.equal(parseChatGPT(JSON.stringify({ nope: true })), null);
  assert.equal(parseClaude(JSON.stringify({ nope: true })), null);
});

// --- Obsidian note format ---
ok("toObsidianMarkdown: emits frontmatter + heading turns", () => {
  const c = parseClaude(claudeFixtureText);
  c.id = "11111111-2222-4333-8444"; // realistic uuid (not a synthetic fallback)
  c.capturedAt = Date.parse("2026-06-16T10:00:00Z");
  const md = toObsidianMarkdown(c);
  assert.ok(md.startsWith("---\n"), "starts with frontmatter");
  assert.ok(md.includes('title: "Designing a database schema"'));
  assert.ok(md.includes("platform: claude"));
  assert.ok(md.includes("created: 2026-01-01"), "created from earliest message time");
  assert.ok(md.includes("captured: 2026-06-16"), "captured from capturedAt");
  assert.ok(md.includes("source_url: https://claude.ai/chat/11111111-2222-4333-8444"));
  assert.ok(md.includes("message_count: 2"));
  assert.ok(md.includes("tags: [ai, ai/claude]"));
  assert.ok(md.includes("## 🧑 You"));
  assert.ok(md.includes("## 🤖 Claude"));
  assert.ok(!md.includes("**You:**"), "no legacy bold-role markers");
});

ok("toObsidianMarkdown: merges the user's own tags into frontmatter (sanitized)", () => {
  const c = { id: "claude-x", platform: "claude", title: "T", tags: ["my project", "#idea", "code/review"], messages: [] };
  const line = toObsidianMarkdown(c).match(/tags:.*/)[0];
  assert.equal(line, "tags: [ai, ai/claude, my-project, idea, code/review]");
});

ok("toObsidianMarkdown: per-message timestamp on headings when message time is present", () => {
  const c = { id: "claude-y", platform: "claude", title: "T", messages: [
    { role: "user", text: "hi", time: "2026-07-05T16:21:00Z" },
    { role: "assistant", text: "yo" },
  ] };
  const md = toObsidianMarkdown(c);
  assert.ok(md.includes("## 🧑 You · 2026-07-05 16:21"), "timestamped heading");
  assert.ok(md.includes("## 🤖 Claude\n"), "no ' · ' suffix when the message has no time");
});

ok("toObsidianMarkdown: ChatGPT speaker + epoch-seconds created date", () => {
  const c = parseChatGPT(chatgptFixture);
  const md = toObsidianMarkdown(c);
  assert.ok(md.includes("platform: chatgpt"));
  assert.ok(md.includes("## 🤖 ChatGPT"));
  assert.ok(md.includes("source_url: https://chatgpt.com/c/abc-123"));
  assert.ok(md.includes("created: 1970-01-01"), "epoch-seconds create_time → date");
});

ok("toObsidianMarkdown: escapes quotes in title, omits empty fields", () => {
  const c = { id: "claude-fallback", platform: "claude", title: 'A "quoted" title', messages: [] };
  const md = toObsidianMarkdown(c);
  assert.ok(md.includes('title: "A \\"quoted\\" title"'));
  assert.ok(!md.includes("source_url"), "synthetic claude- id => no source_url");
  assert.ok(!md.includes("created:"), "no message times => no created field");
  assert.ok(md.includes("message_count: 0"));
});

ok("vaultFilename: sanitizes illegal chars + appends short id", () => {
  const fn = vaultFilename({ id: "1a2b3c4d-0000-4000", title: "Path/with:illegal*chars?" });
  assert.ok(!/[\\/:*?"<>|]/.test(fn.replace(/\.md$/, "")), "no illegal chars");
  assert.ok(fn.endsWith("(1a2b3c4d).md"), "ends with 8-char short id: " + fn);
});

ok("vaultFilename: prefixes the conversation date (Obsidian convention)", () => {
  const fn = vaultFilename({ id: "abc12345", title: "My chat", messages: [{ time: "2026-06-14T10:00:00Z" }] });
  assert.ok(/^2026-06-14 My chat /.test(fn), "starts with ISO date then title: " + fn);
  assert.ok(fn.endsWith("(abc12345).md"), "still ends with short id: " + fn);
});

ok("vaultFilename: falls back to capturedAt date when no message time", () => {
  const fn = vaultFilename({ id: "x", title: "T", capturedAt: Date.parse("2026-01-02T00:00:00Z") });
  assert.ok(/^2026-01-02 /.test(fn), "uses capturedAt date: " + fn);
});

ok("vaultFilename: no date prefix when no time is available", () => {
  const fn = vaultFilename({ id: "y", title: "T" });
  assert.ok(/^T \(/.test(fn), "no prefix when no date: " + fn);
});

ok("platformFolder + sourceUrl mapping", () => {
  assert.equal(platformFolder("claude"), "Claude");
  assert.equal(platformFolder("chatgpt"), "ChatGPT");
  assert.equal(platformFolder("weird"), "Other");
  assert.equal(sourceUrl({ platform: "chatgpt", id: "chatgpt-123" }), "", "synthetic id => no url");
  assert.equal(sourceUrl({ platform: "claude", id: "real-uuid" }), "https://claude.ai/chat/real-uuid");
});

// --- New platforms (best-effort shapes; refined via the debug-panel verify loop) ---
ok("DeepSeek: extracts from data.biz_data.chat_messages", () => {
  const c = parseDeepSeek(JSON.stringify({
    data: { biz_data: {
      chat_session: { id: "ds1", title: "DeepSeek chat" },
      chat_messages: [
        { role: "USER", content: "hi", inserted_at: 1 },
        { role: "ASSISTANT", content: "hello", inserted_at: 2 },
      ],
    } },
  }));
  assert.equal(c.platform, "deepseek");
  assert.equal(c.title, "DeepSeek chat");
  assert.equal(c.messages.length, 2);
  assert.equal(c.messages[0].role, "user");
  assert.equal(c.messages[1].role, "assistant");
  assert.equal(c.messages[1].text, "hello");
});

ok("DeepSeek: extracts text from fragments[].content (real shape)", () => {
  const c = parseDeepSeek(JSON.stringify({
    code: 0, data: { biz_data: {
      chat_session: { id: "ds000001", title: "Test" },
      chat_messages: [
        { message_id: 3, role: "USER", inserted_at: 1, fragments: [{ type: "REQUEST", content: "test 2?" }] },
        { message_id: 4, role: "ASSISTANT", inserted_at: 2, fragments: [{ type: "RESPONSE", content: "Testing, 1, 2, 3." }] },
      ],
    } },
  }));
  assert.equal(c.platform, "deepseek");
  assert.equal(c.id, "ds000001");
  assert.equal(c.title, "Test");
  assert.equal(c.messages.length, 2);
  assert.equal(c.messages[0].role, "user");
  assert.equal(c.messages[0].text, "test 2?");
  assert.equal(c.messages[1].role, "assistant");
  assert.equal(c.messages[1].text, "Testing, 1, 2, 3.");
});

ok("Grok: extracts responses[].{sender,message}", () => {
  const c = parseGrok(JSON.stringify({
    conversation: { conversation_id: "g1", title: "Grok chat" },
    responses: [
      { sender: "human", message: "hi" },
      { sender: "assistant", message: "yo" },
    ],
  }));
  assert.equal(c.platform, "grok");
  assert.equal(c.title, "Grok chat");
  assert.equal(c.messages[0].role, "user");
  assert.equal(c.messages[1].text, "yo");
});

ok("Perplexity: extracts the answer from blocks[].markdown_block (real shape)", () => {
  const c = parsePerplexity(JSON.stringify({
    thread_metadata: { title: "test 2?" },
    entries: [{
      backend_uuid: "pplx-0001", query_str: "test 2?", thread_title: "test 2?",
      updated_datetime: "2026-06-17T07:56:52Z",
      blocks: [
        { intended_usage: "plan", plan_block: { progress: "DONE" } },
        { intended_usage: "ask_text_0_markdown", markdown_block: { answer: "Test 2 can refer to several things." } },
        { intended_usage: "ask_text", markdown_block: { answer: "Test 2 can refer to several things." } },
        { intended_usage: "web_results", web_result_block: {} },
      ],
    }],
  }));
  assert.equal(c.platform, "perplexity");
  assert.equal(c.id, "pplx-0001");
  assert.equal(c.title, "test 2?");
  assert.equal(c.messages.length, 2, "one user + one assistant (dedup the duplicate ask_text)");
  assert.equal(c.messages[0].role, "user");
  assert.equal(c.messages[0].text, "test 2?");
  assert.equal(c.messages[1].role, "assistant");
  assert.equal(c.messages[1].text, "Test 2 can refer to several things.");
});

ok("speaker labels follow the platform (Grok, not ChatGPT)", () => {
  const c = parseGrok(JSON.stringify({
    conversation: { title: "G" },
    responses: [{ sender: "human", message: "hi" }, { sender: "assistant", message: "yo" }],
  }));
  assert.ok(toMarkdown(c).includes("**Grok:**"), "markdown speaker");
  assert.ok(toObsidianMarkdown(c).includes("## 🤖 Grok"), "obsidian heading");
  assert.ok(!toMarkdown(c).includes("ChatGPT"), "no stray ChatGPT label");
});

ok("title falls back to first user message when none is given", () => {
  const c = parseGrok(JSON.stringify({
    responses: [{ sender: "human", message: "How do I do X?" }, { sender: "assistant", message: "like this" }],
  }));
  assert.equal(c.title, "How do I do X?");
});

ok("Gemini: parses the hNvQHb batchexecute envelope, chronological order", () => {
  // Shape mirrors a real gemini.google.com batchexecute response (turns newest-first).
  const turnNew = [["c_ABC", "r_1"], ["c_ABC", "r_2", "rc_a"], [["Loud and clear"], 1],
    [[["rc_x", ["Excellent. Same page?"]]]], 0, [1781681727, 0]];
  const turnOld = [["c_ABC", "r_2"], null, [["test"], 1],
    [[["rc_y", ["Loud and clear! How can I help?"]]]], 0, [1781681142, 0]];
  const inner = JSON.stringify([[turnNew, turnOld], null, null, []]);
  const body =
    ")]}'\n\n1764\n" +
    JSON.stringify([["wrb.fr", "hNvQHb", inner, null, null, null, "generic"]]) +
    "\n26\n" + JSON.stringify([["e", 4, null, null, 1861]]);
  const c = parseGemini(body);
  assert.equal(c.platform, "gemini");
  assert.equal(c.id, "ABC", "conversation id from c_ABC");
  assert.equal(c.messages.length, 4);
  assert.equal(c.messages[0].text, "test", "oldest turn first");
  assert.equal(c.messages[1].text, "Loud and clear! How can I help?");
  assert.equal(c.messages[1].role, "assistant");
  assert.equal(c.messages[2].text, "Loud and clear");
  assert.equal(c.messages[3].text, "Excellent. Same page?");
});

ok("Gemini ignores non-conversation chunks lacking c_ ids (no junk captures)", () => {
  // A typeahead/suggestion chunk: has a string where a user msg would sit, but no
  // c_ conversation id. Must NOT be mistaken for a conversation.
  const fakeTurn = [["x", "y"], null, [["H"], 1], [[["z", ["I"]]]], 0, [1, 0]];
  const inner = JSON.stringify([[fakeTurn], null, null, []]);
  const body = ")]}'\n\n50\n" + JSON.stringify([["wrb.fr", "ku4Jyf", inner, null, null, null, "generic"]]);
  assert.equal(parseGemini(body), null);
});

ok("parsers return null on unrecognized payloads (no throw)", () => {
  assert.equal(parseDeepSeek("{}"), null);
  assert.equal(parseGrok("{}"), null);
  assert.equal(parsePerplexity("{}"), null);
  assert.equal(parseGemini(")]}'\n\n10\n[[\"wrb.fr\",\"L5adhe\",\"[1]\"]]"), null); // non-conversation chunk → null
});

ok("mergeMessages: a 10-turn page never truncates a longer stored conversation", () => {
  const m = (id, time, text = id) => ({ id, role: "user", text, images: [], time });
  const stored = [m("a", 1), m("b", 2), m("c", 3), m("d", 4)];
  const page = [m("c", 3, "c edited"), m("d", 4), m("e", 5)];
  const out = mergeMessages(stored, page);
  assert.deepEqual(out.map((x) => x.id), ["a", "b", "c", "d", "e"]);
  assert.equal(out[2].text, "c edited");
  // An older page loaded later (scrolling up) slots in by time.
  assert.deepEqual(mergeMessages([m("c", 3), m("d", 4)], [m("a", 1), m("b", 2)]).map((x) => x.id), ["a", "b", "c", "d"]);
  // Nothing stored yet, or messages without ids: plain replace.
  assert.equal(mergeMessages([], page), page);
  assert.equal(mergeMessages([{ text: "x" }], page), page);
});

ok("ChatGPT: reshaped payloads without a top-level mapping still parse", () => {
  const msg = (id, role, text, t) => ({ id, author: { role }, content: { content_type: "text", parts: [text] }, create_time: t });
  const url = "https://chatgpt.com/backend-api/conversations/6a000000-0000-8000-8000-000000000001?num_turns=10";
  // 1) wrapped classic mapping
  const a = parseChatGPT(JSON.stringify({ conversation: { title: "Wrapped", conversation_id: "w-1",
    mapping: { x: { id: "x", message: msg("x", "user", "hi", 1) }, y: { id: "y", message: msg("y", "assistant", "hello", 2) } } } }), url);
  assert.equal(a.id, "w-1"); assert.equal(a.title, "Wrapped"); assert.equal(a.messages.length, 2);
  // 2) turns array, no ids anywhere but the URL
  const b = parseChatGPT(JSON.stringify({ title: "Paged", has_more: true,
    turns: [{ messages: [msg("u1", "user", "q", 10)] }, { messages: [msg("a1", "assistant", "ans", 11), msg("s", "system", "", 9)] }] }), url);
  assert.equal(b.id, "6a000000-0000-8000-8000-000000000001");
  assert.deepEqual(b.messages.map((m) => [m.role, m.text]), [["user", "q"], ["assistant", "ans"]]);
  // 3) nothing message-like → null (logged as PARSE-EMPTY with its shape)
  assert.equal(parseChatGPT(JSON.stringify({ items: [{ id: 1, title: "list" }] }), url), null);
});

ok("Claude: wrapped or reshaped payloads still parse; id falls back to the URL", () => {
  const url = "https://claude.ai/api/organizations/aaaaaaaa-2222-4333-8444-555555555555/chat_conversations/bbbbbbbb-2222-4333-8444-555555555555?tree=True";
  const a = parseClaude(JSON.stringify({ conversation: { name: "Wrapped", chat_messages: [{ sender: "human", text: "hi" }, { sender: "assistant", text: "yo" }] } }), url);
  assert.equal(a.title, "Wrapped"); assert.equal(a.id, "bbbbbbbb-2222-4333-8444-555555555555"); assert.equal(a.messages.length, 2);
  const b = parseClaude(JSON.stringify({ data: { tree: [{ sender: "assistant", created_at: "2026-11-20T10:00:01Z", content: [{ type: "text", text: "second" }] },
    { sender: "human", created_at: "2026-11-20T10:00:00Z", content: [{ type: "text", text: "first" }] }] } }), url);
  assert.deepEqual(b.messages.map((m) => m.text), ["first", "second"]);
});

console.log(`\n${pass} checks passed.`);

import { createRequire } from "module";
import assert from "assert";
const require = createRequire(import.meta.url);
const { classify, PLATFORMS } = require("../platforms.js");
const { claudeChatId, claudeOrgFromCookie, claudeConversationUrl } = require("../claude-rest.js");

let pass = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ✓", name); }
  catch (e) { console.error("  ✗", name, "\n   ", e.message); process.exitCode = 1; }
};

const UUID = "11111111-2222-4333-8444-555555555555";

ok("ChatGPT conversation GET", () => {
  const r = classify(`https://chatgpt.com/backend-api/conversation/${UUID}`);
  assert.deepEqual(r, { platform: "chatgpt", kind: "conversation-json" });
});
ok("Claude conversation GET", () => {
  const r = classify(`https://claude.ai/api/organizations/${UUID}/chat_conversations/${UUID}?tree=True`);
  assert.deepEqual(r, { platform: "claude", kind: "conversation-json" });
});
ok("Gemini batchexecute (any rpcid — not keyed to an obfuscated id)", () => {
  assert.equal(classify("https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb").platform, "gemini");
  assert.equal(classify("https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=ZZZnew99").platform, "gemini");
});
ok("Perplexity thread by UUID; helper endpoints don't match", () => {
  assert.equal(classify(`https://www.perplexity.ai/rest/thread/${UUID}?with_schematized_response=true`).platform, "perplexity");
  assert.equal(classify("https://www.perplexity.ai/rest/thread/mark_viewed?version=2.18"), null);
  assert.equal(classify("https://www.perplexity.ai/rest/thread/list_pinned_ask_threads"), null);
});
ok("Grok load-responses matches; node/bare endpoints don't (avoid empty noise)", () => {
  assert.equal(classify(`https://grok.com/rest/app-chat/conversations/${UUID}/load-responses`).platform, "grok");
  assert.equal(classify(`https://grok.com/rest/app-chat/conversations/${UUID}/response-node`), null);
  assert.equal(classify(`https://grok.com/rest/app-chat/conversations/${UUID}`), null);
});
ok("DeepSeek history messages", () => {
  const r = classify(`https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=${UUID}`);
  assert.equal(r && r.platform, "deepseek");
});
ok("unrelated URL → null", () => {
  assert.equal(classify("https://example.com/api/foo"), null);
  assert.equal(classify("https://chatgpt.com/backend-api/me"), null);
});
ok("ChatGPT Nov-2026 plural endpoint", () => {
  const id = "6a000000-0000-8000-8000-000000000001";
  assert.deepEqual(classify(`https://chatgpt.com/backend-api/conversations/${id}?num_turns=10&include_has_versions=true`), { platform: "chatgpt", kind: "conversation-json" });
  assert.equal(classify("https://chatgpt.com/backend-api/conversations?conversation_origin=tpp&limit=20&offset=0"), null);
  assert.equal(classify("https://chatgpt.com/backend-api/gizmos/g-p-0123456789abcdef0123456789abcdef/conversations?limit=5"), null);
  assert.equal(classify("https://chatgpt.com/backend-api/conversation/init"), null);
});

ok("Claude endpoint variants", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const C = { platform: "claude", kind: "conversation-json" };
  assert.deepEqual(classify(`https://claude.ai/api/organizations/${id}/chat_conversations/${id}?tree=True&rendering_mode=messages`), C);
  assert.deepEqual(classify(`https://claude.ai/api/organizations/${id}/chat_conversations_v2/${id}`), C);
  assert.deepEqual(classify(`https://claude.ai/api/organizations/${id}/conversations/${id}`), C);
  assert.deepEqual(classify(`https://claude.ai/api/chat_conversations/${id}`), C);
  assert.equal(classify(`https://claude.ai/api/organizations/${id}/chat_conversations/${id}/completion`)?.kind, undefined);
  assert.equal(classify(`https://claude.ai/api/organizations/${id}/chat_conversations/${id}/title`), null);
  assert.equal(classify(`https://claude.ai/api/organizations/${id}/chat_conversations?limit=30`), null);
});

ok("non-string → null", () => {
  assert.equal(classify(null), null);
  assert.equal(classify(123), null);
});

ok("every platform is registered", () => {
  assert.deepEqual(PLATFORMS.map((p) => p.id), ["chatgpt", "claude", "gemini", "perplexity", "grok", "deepseek"]);
});

ok("Claude side requests under a conversation are not conversations", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  assert.equal(classify(`/api/organizations/${id}/chat_conversations/${id}/shares`), null);
  assert.equal(classify(`/api/organizations/${id}/chat_conversations/${id}/composer_notices`), null);
  assert.deepEqual(classify(`/api/organizations/${id}/chat_conversations/${id}/`), { platform: "claude", kind: "conversation-json" });
});

ok("Claude active fetch: conversation id from the page path", () => {
  const id = "c49b9c8e-061d-4bf6-b12c-992c88121077";
  assert.equal(claudeChatId(`/chat/${id}`), id);
  assert.equal(claudeChatId(`/chat/${id}/`), id);
  assert.equal(claudeChatId("/new"), null);
  assert.equal(claudeChatId("/project/019b2226-e4f2-7079-b067-971748ed7472"), null);
  assert.equal(claudeChatId("/chat/not-a-uuid"), null);
});

ok("Claude active fetch: organization from the lastActiveOrg cookie", () => {
  assert.equal(claudeOrgFromCookie("a=1; lastActiveOrg=056f177a-c9b2-4eeb-b042-bc4687b6d98b; b=2"), "056f177a-c9b2-4eeb-b042-bc4687b6d98b");
  assert.equal(claudeOrgFromCookie("a=1; b=2"), null);
  assert.equal(claudeOrgFromCookie("lastActiveOrg=../evil"), null);
});

ok("Claude active fetch: REST URL matches the capture rule", () => {
  const u = claudeConversationUrl("aaaaaaaa-2222-4333-8444-555555555555", "bbbbbbbb-2222-4333-8444-555555555555");
  assert.equal(u, "/api/organizations/aaaaaaaa-2222-4333-8444-555555555555/chat_conversations/bbbbbbbb-2222-4333-8444-555555555555?tree=True&rendering_mode=messages&render_all_tools=true");
  assert.deepEqual(classify(u), { platform: "claude", kind: "conversation-json" });
});

console.log(`\n${pass} checks passed.`);

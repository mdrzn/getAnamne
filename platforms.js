// Platform registry — the single source of truth for which AI sites Anamne
// captures and how to recognize their conversation endpoints. Loaded in the page (MAIN world, before inject.js), the service
// worker (importScripts), and the Node tests, so the URL rules never drift.
//
// Adding a platform = add one entry to PLATFORMS. Parsing lives in parsers.js
// (CAMParsers.parse<Platform>), dispatched by background.js via `kind`/platform.
(function (root) {
  "use strict";

  const UUIDISH = "[0-9a-fA-F-]{8,}";

  // Each entry: { id, rules: [{re, kind}] }.
  // kind: "conversation-json" (full clean JSON) | "stream" | "batchexecute".
  const PLATFORMS = [
    {
      id: "chatgpt",
      rules: [
        // Nov 2026: ChatGPT moved from /conversation/{id} to /conversations/{id}?num_turns=…
        // Accept both. The list endpoint (/conversations?…) has no id, so it never matches.
        { re: new RegExp(`/backend-api/conversations?/${UUIDISH}(?:[?#]|$)`), kind: "conversation-json" },
      ],
    },
    {
      id: "claude",
      rules: [
        // Also tolerate likely renames (conversations, chat_conversations_v2, no org segment).
        { re: new RegExp(`/api/(?:organizations/[^/]+/)?(?:chat_)?conversations(?:_v\\d+)?/${UUIDISH}(?:[?#]|/?$)`), kind: "conversation-json" },
      ],
    },
    {
      id: "gemini",
      rules: [
        // Any batchexecute on gemini.google.com. We DON'T key on a specific rpcid
        // (those are obfuscated/rotating) — parseGemini finds the conversation chunk
        // by its structure, so it survives Google changing the id.
        { re: /\/_\/BardChatUi\/data\/batchexecute/, kind: "batchexecute" },
      ],
    },
    {
      id: "perplexity",
      rules: [
        // Require a UUID so /rest/thread/mark_viewed, /list_pinned_ask_threads, etc. don't match.
        { re: new RegExp(`/rest/thread/${UUIDISH}`), kind: "conversation-json" },
      ],
    },
    {
      id: "grok",
      rules: [
        // Full history on load. (The per-turn /response-node stream is ignored.)
        { re: new RegExp(`/rest/app-chat/conversations/${UUIDISH}/load-responses`), kind: "conversation-json" },
      ],
    },
    {
      id: "deepseek",
      rules: [
        { re: /\/api\/v0\/chat\/history_messages/, kind: "conversation-json" },
      ],
    },
  ];

  // Returns { platform, kind } for a recognized conversation endpoint, else null.
  function classify(url) {
    if (typeof url !== "string") return null;
    for (const p of PLATFORMS) {
      for (const rule of p.rules) {
        if (rule.re.test(url) && !(rule.not && rule.not.test(url))) {
          return { platform: p.id, kind: rule.kind };
        }
      }
    }
    return null;
  }

  // Gemini only requests a conversation (hNvQHb) when it is opened, so a chat
  // started in the tab is never sent to the page in full. inject.js replays the
  // same request after each reply; these build it.
  function geminiChatId(pathname) {
    const m = String(pathname || "").match(/^(?:\/u\/\d+)?\/app\/([0-9a-f]{8,})\/?$/);
    return m ? m[1] : null;
  }
  function geminiReadRequest({ id, at, bl, sid, hl, reqid, prefix }) {
    const q = new URLSearchParams({ rpcids: "hNvQHb", "source-path": "/app/" + id, bl, "f.sid": sid, hl, _reqid: String(reqid), rt: "c" });
    const freq = JSON.stringify([[["hNvQHb", JSON.stringify(["c_" + id, 10, null, 1, [1], [4, 12], null, 1]), null, "generic"]]]);
    return {
      url: `${prefix || ""}/_/BardChatUi/data/batchexecute?` + q.toString().replace(/\+/g, "%20"),
      body: "f.req=" + encodeURIComponent(freq) + "&at=" + encodeURIComponent(at) + "&",
    };
  }

  // Match patterns for the manifest / content-script injection, per platform.
  const HOST_PATTERNS = {
    chatgpt: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
    claude: ["https://claude.ai/*"],
    gemini: ["https://gemini.google.com/*"],
    perplexity: ["https://www.perplexity.ai/*", "https://perplexity.ai/*"],
    grok: ["https://grok.com/*"],
    deepseek: ["https://chat.deepseek.com/*"],
  };

  const api = { PLATFORMS, classify, HOST_PATTERNS, geminiChatId, geminiReadRequest };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AnamnePlatforms = api;
})(typeof self !== "undefined" ? self : this);

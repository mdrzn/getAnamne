// Claude, Nov 2026: claude.ai now loads conversations over a protobuf RPC
// (ConversationService/ReadConversation) that Anamne can't read, but the JSON
// endpoint still answers. bridge.js requests it itself when a chat is open.
// Its own file because Chrome injects a given script once per page, so the
// ISOLATED-world bridge can't share platforms.js with the MAIN-world inject.js.
(function (root) {
  "use strict";

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function claudeChatId(pathname) {
    const m = String(pathname || "").match(/^\/chat\/([^/?#]+)\/?$/);
    return m && UUID_RE.test(m[1]) ? m[1] : null;
  }
  function claudeOrgFromCookie(cookie) {
    const m = String(cookie || "").match(/(?:^|;\s*)lastActiveOrg=([^;]+)/);
    return m && UUID_RE.test(m[1]) ? m[1] : null;
  }
  function claudeConversationUrl(org, id) {
    return `/api/organizations/${org}/chat_conversations/${id}?tree=True&rendering_mode=messages&render_all_tools=true`;
  }

  const api = { claudeChatId, claudeOrgFromCookie, claudeConversationUrl };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AnamneClaudeRest = api;
})(typeof self !== "undefined" ? self : this);

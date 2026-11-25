// ISOLATED-world content script. Bridges page-context postMessages from inject.js
// to the extension service worker (the page context can't call chrome.* APIs).
(function () {
  "use strict";
  const forward = (payload) => {
    try {
      chrome.runtime.sendMessage({ from: "cam", payload });
    } catch (_) {
      // service worker may be asleep; messages are best-effort
    }
  };
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== "CAM_CAPTURE" || !d.payload) return;
    forward(d.payload);
    if (claude && d.payload.type === "seen") claude.onSeen(d.payload.url || "");
  });

  // Claude (Nov 2026) loads conversations over a protobuf RPC Anamne can't read,
  // so we request the JSON endpoint ourselves: when a chat opens, after the user
  // sends a message (a few times, while the reply streams), and when the tab is
  // hidden. Same-origin with the live session, so no extra permission.
  const claude = location.hostname === "claude.ai" && self.AnamneClaudeRest ? claudeFetcher(self.AnamneClaudeRest) : null;

  function claudeFetcher(P) {
    let org = null, lastPath = null, lastAt = 0, lastId = null;
    const timers = [];
    async function fetchNow() {
      const id = P.claudeChatId(location.pathname);
      const o = P.claudeOrgFromCookie(document.cookie) || org;
      if (!id || !o) return;
      if (id === lastId && Date.now() - lastAt < 3000) return;
      lastId = id; lastAt = Date.now();
      const url = P.claudeConversationUrl(o, id);
      try {
        const r = await fetch(url, { credentials: "include" });
        forward({ type: "seen", url, ctype: (r.headers.get("content-type") || "") + " (requested by Anamne)", matched: true, kind: "conversation-json", platform: "claude" });
        if (r.ok) forward({ type: "capture", platform: "claude", kind: "json", url, body: await r.text() });
      } catch (err) {
        forward({ type: "error", url, message: String((err && err.message) || err) });
      }
    }
    const at = (...delays) => {
      while (timers.length) clearTimeout(timers.pop());
      for (const d of delays) timers.push(setTimeout(fetchNow, d));
    };
    setInterval(() => {
      if (location.pathname !== lastPath) { lastPath = location.pathname; at(1500); }
    }, 1000);
    document.addEventListener("visibilitychange", () => { if (document.hidden) fetchNow(); });
    return {
      onSeen(url) {
        const m = url.match(/\/api\/organizations\/([0-9a-f-]{36})\//i);
        if (m) org = m[1];
        // Sending, retrying or editing a message: the reply lands over the next minute or so.
        if (/ConversationService\/(PerformAction|SendMessage|Generate)|\/(retry_)?completion\b/.test(url)) at(8000, 30000, 90000);
      },
    };
  }

  // Image capture: the background asks us to fetch image bytes for a captured
  // ChatGPT conversation. We run in the page origin with the live session, so a
  // same-origin fetch is authenticated. Resolve the signed download URL, fetch the
  // bytes, and return them base64-encoded. (chatgpt.com only.)
  const isChatGPT = /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/.test(location.hostname);
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.from !== "anamne-img" || msg.action !== "fetchAssets") return;
    if (!isChatGPT) { sendResponse({ started: false }); return; }
    // Stream results back one-by-one (don't hold the port open for the whole batch —
    // it would outlive the service worker). The content script (this page) drives the
    // loop and stays alive while the tab is open.
    streamChatGPTAssets(msg.conversationId, msg.assets || []);
    sendResponse({ started: true });
    return false;
  });

  function pickDownloadUrl(meta) {
    if (!meta || typeof meta !== "object") return null;
    for (const k of ["download_url", "url", "file_url", "signed_url"]) {
      if (typeof meta[k] === "string" && /^https?:\/\//.test(meta[k])) return meta[k];
    }
    for (const v of Object.values(meta)) {
      if (typeof v === "string" && /^https?:\/\//.test(v)) return v;
    }
    return null;
  }

  // ChatGPT's /backend-api/* needs a Bearer access token (cookies alone aren't
  // enough). The session endpoint hands it back, authenticated by cookie. Cached
  // for the batch.
  let _accessToken;
  async function getAccessToken() {
    if (_accessToken !== undefined) return _accessToken;
    try {
      const s = await fetch("/api/auth/session", { credentials: "include" }).then((r) => (r.ok ? r.json() : null));
      _accessToken = (s && s.accessToken) || null;
    } catch (_) { _accessToken = null; }
    return _accessToken;
  }
  function bufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    return btoa(bin);
  }
  // Fetch one image: resolve the signed URL, then fetch the bytes. Echoes back the
  // asset metadata so the background can store it without keeping its own state.
  async function fetchOneAsset(conversationId, a, authHeaders) {
    const base = { fileId: a.fileId, filename: a.filename, width: a.width, height: a.height };
    try {
      const metaUrl =
        "/backend-api/files/download/" + encodeURIComponent(a.fileId) +
        "?conversation_id=" + encodeURIComponent(conversationId || "") +
        "&inline=false&download_intent=false";
      const r = await fetch(metaUrl, { credentials: "include", headers: authHeaders });
      if (!r.ok) return { ...base, ok: false, error: "meta_http_" + r.status };
      const meta = await r.json().catch(() => null);
      const url = pickDownloadUrl(meta);
      if (!url) return { ...base, ok: false, error: "no_url(" + (meta ? Object.keys(meta).join("|") : "null") + ")" };
      const br = await fetch(url, { credentials: "include" });
      if (!br.ok) return { ...base, ok: false, error: "bytes_http_" + br.status };
      const buf = await br.arrayBuffer();
      return { ...base, ok: true, mime: br.headers.get("content-type") || a.mime || "image/png", b64: bufToBase64(buf) };
    } catch (err) {
      return { ...base, ok: false, error: String((err && err.message) || err) };
    }
  }

  // Fetch the batch with limited concurrency, posting each result to the background
  // as it lands (so storage + UI fill in progressively and survive SW restarts).
  async function streamChatGPTAssets(conversationId, assets) {
    const token = await getAccessToken();
    const authHeaders = token ? { Authorization: "Bearer " + token } : {};
    const CONCURRENCY = 4;
    let i = 0, ok = 0, fail = 0;
    async function worker() {
      while (i < assets.length) {
        const a = assets[i++];
        const r = await fetchOneAsset(conversationId, a, authHeaders);
        r.ok ? ok++ : fail++;
        try { chrome.runtime.sendMessage({ from: "anamne-img-result", conversationId, ...r }); } catch (_) {}
        if (!r.ok) console.warn("[anamne] image fetch failed", a.fileId, r.error);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, assets.length) }, worker));
    try { chrome.runtime.sendMessage({ from: "anamne-img-result", conversationId, done: true, ok, fail }); } catch (_) {}
  }
})();

// MAIN-world script. Runs in the page's own JS context so it can wrap the page's
// fetch / XHR. We TEE response bodies (never block the originals) and post the raw
// payloads out to the ISOLATED-world bridge via window.postMessage.
//
// This is the durability moat: we read the structured API responses, not the DOM,
// so host UI changes don't break us. Endpoint *shapes* can still change — the popup's
// debug panel logs every request URL so we can spot drift and adapt.
(function () {
  "use strict";
  const TAG = "CAM_CAPTURE";
  const send = (payload) => {
    try { window.postMessage({ source: TAG, payload }, "*"); } catch (_) {}
  };

  // Returns {platform, kind} for endpoints we care about, else null.
  // Clean conversation endpoints for ALL platforms come from the shared registry
  // (platforms.js, loaded before this script). Streaming endpoints are handled
  // here — they're logged in the debug panel but not stored as content.
  function classify(url) {
    if (typeof url !== "string") return null;
    if (window.AnamnePlatforms) {
      const r = window.AnamnePlatforms.classify(url);
      if (r) return r;
    }
    if (/\/backend-api\/(f\/)?conversation(\?|$)/.test(url))
      return { platform: "chatgpt", kind: "stream" };
    if (/\/chat_conversations\/[0-9a-fA-F-]{36}\/completion/.test(url))
      return { platform: "claude", kind: "stream" };
    return null;
  }

  // Gemini only sends a conversation (rpc hNvQHb) when it is opened, never after a
  // reply, so a chat started in the tab would be saved only on the next reload.
  // After each reply finishes we send the same hNvQHb request the page sends on
  // load; its response passes through the fetch wrapper below and is captured.
  const isGemini = location.hostname === "gemini.google.com";
  const gemini = { bl: null, sid: null, hl: null, at: null, timer: null };
  function noteGeminiRequest(url, body) {
    if (!isGemini || typeof url !== "string" || !url.includes("/batchexecute")) return;
    try {
      const q = new URL(url, location.href).searchParams;
      gemini.bl = q.get("bl") || gemini.bl;
      gemini.sid = q.get("f.sid") || gemini.sid;
      gemini.hl = q.get("hl") || gemini.hl;
      const at = typeof body === "string" && new URLSearchParams(body).get("at");
      if (at) gemini.at = at;
    } catch (_) {}
  }
  function geminiReplyDone() {
    clearTimeout(gemini.timer);
    gemini.timer = setTimeout(() => { if (!refetchGemini()) gemini.timer = setTimeout(refetchGemini, 6000); }, 2500);
  }
  function refetchGemini() {
    const P = window.AnamnePlatforms;
    const W = window.WIZ_global_data || {};
    const id = P && P.geminiChatId(location.pathname);
    const at = W.SNlM0e || gemini.at, bl = gemini.bl || W.cfb2h, sid = gemini.sid || W.FdrFJe;
    if (!id || !at || !bl || !sid) return false;
    const r = P.geminiReadRequest({
      id, at, bl, sid, hl: gemini.hl || "en",
      reqid: 100000 + Math.floor(Math.random() * 900000),
      prefix: (location.pathname.match(/^\/u\/\d+/) || [""])[0],
    });
    window.fetch(r.url, {
      method: "POST", credentials: "include", body: r.body,
      headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8", "x-same-domain": "1" },
    }).catch(() => {});
    return true;
  }

  async function handle(url, response) {
    const ctype = (response.headers && response.headers.get("content-type")) || "";
    if (isGemini && url.includes("/StreamGenerate")) response.text().then(geminiReplyDone, () => {});
    const meta = classify(url);
    // Always log what we saw, matched or not — this drives the debug panel.
    send({ type: "seen", url, ctype, matched: !!meta, kind: meta && meta.kind, platform: meta && meta.platform });
    if (!meta) return;
    try {
      const looksJson = meta.kind === "conversation-json" || ctype.includes("application/json");
      const looksStream = meta.kind === "stream" || ctype.includes("text/event-stream");
      if (looksJson && !looksStream) {
        const body = await response.text();
        send({ type: "capture", platform: meta.platform, kind: "json", url, body });
      } else if (looksStream && response.body) {
        const reader = response.body.getReader();
        const dec = new TextDecoder();
        let raw = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          raw += dec.decode(value, { stream: true });
          if (raw.length > 2_000_000) break; // safety cap
        }
        send({ type: "capture", platform: meta.platform, kind: "stream", url, body: raw });
      }
    } catch (e) {
      send({ type: "error", url, message: String(e) });
    }
  }

  // --- patch fetch ---
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      p.then((res) => {
        try {
          const url = args[0] instanceof Request ? args[0].url : String(args[0]);
          noteGeminiRequest(url, args[1] && args[1].body);
          handle(url, res.clone());
        } catch (_) {}
      }).catch(() => {});
      return p;
    };
  }

  // --- patch XHR (belt and suspenders; both hosts mostly use fetch) ---
  const OrigXHR = window.XMLHttpRequest;
  if (OrigXHR) {
    const open = OrigXHR.prototype.open;
    const sendM = OrigXHR.prototype.send;
    OrigXHR.prototype.open = function (method, url) {
      this.__cam_url = url;
      return open.apply(this, arguments);
    };
    OrigXHR.prototype.send = function (body) {
      noteGeminiRequest(this.__cam_url, body);
      this.addEventListener("load", function () {
        try {
          const url = this.__cam_url;
          if (isGemini && typeof url === "string" && url.includes("/StreamGenerate")) geminiReplyDone();
          const meta = classify(url);
          const ctype = this.getResponseHeader && this.getResponseHeader("content-type") || "";
          send({ type: "seen", url, ctype, matched: !!meta, kind: meta && meta.kind, platform: meta && meta.platform });
          if (meta && this.responseText) {
            send({ type: "capture", platform: meta.platform, kind: meta.kind === "stream" ? "stream" : "json", url, body: this.responseText });
          }
        } catch (_) {}
      });
      return sendM.apply(this, arguments);
    };
  }

  console.debug("[Cross-AI Memory] network capture installed");
})();

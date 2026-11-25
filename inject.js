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

  async function handle(url, response) {
    const ctype = (response.headers && response.headers.get("content-type")) || "";
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
    OrigXHR.prototype.send = function () {
      this.addEventListener("load", function () {
        try {
          const url = this.__cam_url;
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

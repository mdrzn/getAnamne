// Service worker. Receives capture payloads from the bridge, parses them with the
// shared parsers, stores normalized conversations in IndexedDB (via db.js), and
// keeps a rolling debug log of every endpoint seen (matched or not) in
// chrome.storage so we can diagnose endpoint drift from the popup.
importScripts("config.js", "db.js", "parsers.js", "platforms.js");

// Verbose progress logging — only in DEV builds. Real failures use console.warn so they
// stay visible in store builds for support diagnostics.
const dlog = (...a) => { if (self.ANAMNE_CONFIG && self.ANAMNE_CONFIG.DEV) console.log(...a); };

const SEEN_KEY = "cam_seen";

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.from !== "cam" || !msg.payload) return;
  const p = msg.payload;
  if (p.type === "seen") recordSeen(p);
  else if (p.type === "capture") handleCapture(p, sender);
  else if (p.type === "error") recordSeen({ url: "ERROR " + p.url, ctype: p.message, matched: false });
});

// Prompt-library picker (content script) requests — content scripts run in the
// page origin and can't read the extension's IndexedDB, so we serve it here.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.from !== "anamne-picker") return;
  if (msg.action === "getPrompts") {
    self.AnamneDB.getAllPrompts()
      .then((prompts) => sendResponse({ ok: true, prompts: prompts || [] }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // keep channel open for async sendResponse
  }
  if (msg.action === "recordUse" && msg.id) {
    self.AnamneDB.recordPromptUse(msg.id).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.action === "openManager") {
    chrome.tabs.create({ url: chrome.runtime.getURL("prompts.html") });
  }
});

async function recordSeen(p) {
  const store = await chrome.storage.local.get(SEEN_KEY);
  const seen = store[SEEN_KEY] || [];
  seen.unshift({
    t: Date.now(),
    url: p.url,
    ctype: p.ctype || "",
    matched: !!p.matched,
    kind: p.kind || null,
    platform: p.platform || null,
  });
  await chrome.storage.local.set({ [SEEN_KEY]: seen.slice(0, 200) });
}

// platform id → parser on CAMParsers
const PARSERS = {
  chatgpt: "parseChatGPT", claude: "parseClaude", deepseek: "parseDeepSeek",
  grok: "parseGrok", perplexity: "parsePerplexity", gemini: "parseGemini",
};

// Key names and value types of a payload, two levels deep, never the values. Goes
// into the Diagnostics log when a recognized response can't be parsed, so a user's
// copied log shows how the site reshaped its data without exposing their chats.
function payloadShape(body) {
  const t = (v) => (Array.isArray(v) ? "array(" + v.length + ")" : v === null ? "null" : typeof v);
  try {
    const obj = JSON.parse(body);
    if (!obj || typeof obj !== "object") return t(obj);
    const first = Array.isArray(obj) ? obj[0] : obj;
    const desc = (o) => Object.keys(o || {}).slice(0, 25).map((k) => {
      const v = o[k];
      const inner = v && typeof v === "object" ? Array.isArray(v) ? v[0] : v : null;
      return inner && typeof inner === "object"
        ? `${k}:${t(v)}{${Object.keys(inner).slice(0, 12).join(",")}}`
        : `${k}:${t(v)}`;
    }).join(" ");
    return (Array.isArray(obj) ? `array(${obj.length}) of ` : "") + desc(first);
  } catch (_) {
    return "not JSON, " + String(body || "").length + " chars";
  }
}

async function handleCapture(p, sender) {
  if (p.kind === "stream") {
    // As of 2026, the streaming POST only returns a handoff envelope — the actual
    // reply streams over a separate SSE/WebSocket channel. No content to store; the
    // full-conversation GET (on load/refresh) is the clean source of truth.
    return recordSeen({
      url: p.url, ctype: "stream handoff (not stored — content is on resume-SSE/WS)",
      matched: true, platform: p.platform, kind: "stream",
    });
  }
  let conv = null;
  try {
    const fnName = PARSERS[p.platform];
    if (fnName && self.CAMParsers[fnName]) conv = self.CAMParsers[fnName](p.body, p.url);
  } catch (e) {
    return recordSeen({ url: "PARSE-ERR " + p.url, ctype: String(e), matched: false });
  }
  if (!conv) {
    // Gemini fans out dozens of batchexecute calls; only one carries the
    // conversation. Don't spam the debug log with PARSE-EMPTY for the rest —
    // the request is still visible via the "seen" entry from inject.js.
    if (p.platform === "gemini") return;
    return recordSeen({ url: "PARSE-EMPTY " + p.url, ctype: "shape: " + payloadShape(p.body), matched: false });
  }
  // DEBUG (DEV only): stash the raw body of a successfully-parsed capture per platform
  // so we can copy the exact payload from the popup's Diagnostics view (e.g. to build
  // the Gemini image extractor) without hunting in DevTools.
  if (self.ANAMNE_CONFIG && self.ANAMNE_CONFIG.DEV) {
    try { chrome.storage.local.set({ ["cam_lastbody_" + p.platform]: p.body }); } catch (_) {}
  }
  try {
    await self.AnamneDB.saveCapture({ ...conv, capturedAt: Date.now() });
    await updateBadge();
  } catch (e) {
    recordSeen({ url: "DB-ERR " + p.url, ctype: String(e), matched: false });
  }
  // Also capture images. ChatGPT bytes are fetched by the content script (the
  // download needs the page session); Gemini's image URLs are public, so the
  // background fetches them directly.
  try {
    const tabId = sender && sender.tab && sender.tab.id;
    if (p.platform === "chatgpt" || p.platform === "gemini") {
      if (capturingConvs.has(conv.id)) dlog("[anamne] images already in progress for", conv.id);
      else {
        capturingConvs.add(conv.id);
        setTimeout(() => capturingConvs.delete(conv.id), 120000); // clear after the batch window
        if (p.platform === "chatgpt" && tabId != null) await captureChatGPTImages(p.body, conv.id, tabId);
        else if (p.platform === "gemini") await captureGeminiImages(p.body, conv.id);
      }
    }
  } catch (e) { console.warn("[anamne] image capture failed:", e); }
}

// --- Image capture (ChatGPT) -------------------------------------------------
function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    try { chrome.tabs.sendMessage(tabId, msg, (resp) => { void chrome.runtime.lastError; resolve(resp); }); }
    catch (_) { resolve(null); }
  });
}
function b64ToBlob(b64, mime) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime || "application/octet-stream" });
}
const capturingConvs = new Set(); // guard against the double conversation-GET on load

// Gemini: image URLs are public lh3 links embedded in the captured payload, so we
// fetch the bytes straight from the background (no page session needed).
async function captureGeminiImages(body, convId) {
  const assets = self.CAMParsers.geminiImageAssets(body);
  dlog("[anamne] gemini images: found", assets.length, "for conv", convId);
  if (!assets.length) return;
  const images = assets.map((a) => ({ fileId: a.fileId, filename: a.filename, mime: a.mime, width: a.width, height: a.height }));
  await self.AnamneDB.updateConversation(convId, { images, exportVersion: crypto.randomUUID() });
  for (const a of assets) {
    // Skip only if we already have a *valid* (non-placeholder) image; re-fetch tiny/corrupt ones.
    const existing = await self.AnamneDB.getAsset(a.fileId);
    if (existing && existing.size >= GEMINI_MIN_IMG_BYTES) continue;
    const bytes = await fetchGeminiImage(a);
    if (!bytes) continue;
    try {
      await self.AnamneDB.putAsset({ id: a.fileId, mime: a.mime, bytes, size: bytes.size, filename: a.filename, width: a.width, height: a.height, capturedAt: Date.now() });
      // Bytes now available → new export version so Obsidian re-syncs the note with the image.
      await self.AnamneDB.updateConversation(convId, { exportVersion: crypto.randomUUID() });
      dlog("[anamne] stored gemini image", a.fileId, Math.round(bytes.size / 1024) + "KB");
    } catch (e) { console.warn("[anamne] gemini image fail", a.fileId, e); }
  }
}

// These lh3 URLs need the user's Google cookies — the page's <img> loads carry them, and
// a cookieless fetch only gets whichever images happen to be publicly cached (the rest
// come back as a ~600B placeholder). We fetch WITH credentials: because both lh3 hosts
// (googleusercontent.com AND the redirect target lh3.google.com) are in host_permissions,
// the extension fetch bypasses CORS *and* sends cookies, authorizing every image like the
// page does. We append the Gemini UI's own `=s<size>-rj?alr=yes` form (asking a large size
// first so originals stay full-res, falling back to the proven s1024); bytes come as JPEG.
// A wrong/oversized request can still 200 with a tiny placeholder, so we reject anything
// implausibly small and let the next suffix try.
const GEMINI_IMG_SUFFIXES = ["=s4096-rj?alr=yes", "=s1024-rj?alr=yes"];
const GEMINI_MIN_IMG_BYTES = 2048;
async function fetchGeminiImage(a) {
  let lastInfo = "";
  for (const suf of GEMINI_IMG_SUFFIXES) {
    try {
      const r = await fetchImageOrResolve(a.url + suf, 0);
      if (r && r.blob) return r.blob;
      if (r) lastInfo = r.info;
    } catch (e) { console.warn("[anamne] gemini fetch error", a.fileId, suf, e.message); }
  }
  console.warn("[anamne] gemini image rejected", a.fileId, lastInfo || "(no response)");
  return null;
}

// Fetch a Gemini image URL. The `/gg/...=s..-rj?alr=yes` endpoint usually doesn't return
// bytes directly — it returns a tiny text body carrying the next URL in a redirect CHAIN
// (`/gg/…` → `/rd-gg/…` → `/rd-gg/…` → image bytes), which the page's <img> follows
// transparently. So if the response isn't a real image, we read the small body, extract
// the lh3 URL from it, and follow it — up to a few hops. Returns {blob} on success or
// {info} describing the failure (for logging).
async function fetchImageOrResolve(url, depth) {
  const resp = await fetch(url, { credentials: "include" });
  if (!resp.ok) return { info: "http_" + resp.status };
  const ct = resp.headers.get("content-type") || "";
  const buf = await resp.arrayBuffer();
  if (/^image\//.test(ct) && buf.byteLength >= GEMINI_MIN_IMG_BYTES) {
    return { blob: new Blob([buf], { type: ct }) };
  }
  // Not image bytes — follow the next URL in the redirect chain out of the (small) body.
  const text = buf.byteLength < 16384 ? new TextDecoder().decode(buf) : "";
  if (self.ANAMNE_CONFIG && self.ANAMNE_CONFIG.DEV) {
    console.log(`[anamne] gemini non-image body (depth ${depth}, ${ct}, ${buf.byteLength}B) for ${url.slice(0, 80)}…\n`, text.slice(0, 600));
  }
  if (depth < 3 && text) {
    const m = text.match(/https:\/\/lh3\.google(?:usercontent)?\.com\/[^\s"'<>\\]+/);
    if (m && m[0] !== url) return fetchImageOrResolve(m[0], depth + 1);
    return { info: ct + " " + buf.byteLength + "B, no new url in body: " + text.slice(0, 120) };
  }
  return { info: ct + " " + buf.byteLength + "B (not an image)" };
}

async function captureChatGPTImages(body, convId, tabId) {
  let obj;
  try { obj = JSON.parse(body); } catch (_) { return; }
  const assets = self.CAMParsers.chatGPTImageAssets(obj);
  dlog("[anamne] captureImages: found", assets.length, "image asset(s) for conv", convId);
  if (!assets.length) return;
  // Attach refs immediately so the archive + Obsidian know about the images even
  // before (or if) the bytes arrive.
  const images = assets.map((a) => ({ fileId: a.fileId, filename: a.filename, mime: a.mime, width: a.width, height: a.height }));
  await self.AnamneDB.updateConversation(convId, { images, exportVersion: crypto.randomUUID() });
  // Only fetch ones we don't already have; the page streams results back to the
  // "anamne-img-result" listener, which stores them one-by-one.
  const need = [];
  for (const a of assets) if (!(await self.AnamneDB.hasAsset(a.fileId))) need.push(a);
  dlog("[anamne] captureImages: requesting", need.length, "of", assets.length, "(rest already stored)");
  if (need.length) {
    sendToTab(tabId, {
      from: "anamne-img", action: "fetchAssets", conversationId: convId,
      assets: need.map((a) => ({ fileId: a.fileId, mime: a.mime, filename: a.filename, width: a.width, height: a.height })),
    });
  }
}

// Store each image the content script streams back (it carries its own metadata, so
// no server-worker state is needed across restarts).
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.from !== "anamne-img-result") return;
  if (msg.done) {
    dlog("[anamne] image batch done:", msg.ok, "ok,", msg.fail, "failed");
    return;
  }
  if (!msg.ok || !msg.b64) { console.warn("[anamne] image FAIL", msg.fileId, msg.error); return; }
  const bytes = b64ToBlob(msg.b64, msg.mime);
  self.AnamneDB.putAsset({
    id: msg.fileId, mime: msg.mime, bytes, size: bytes.size,
    filename: msg.filename, width: msg.width, height: msg.height, capturedAt: Date.now(),
  })
    .then(() => {
      dlog("[anamne] stored image", msg.fileId, Math.round(bytes.size / 1024) + "KB");
      // Bytes now available → bump export version so Obsidian re-syncs with the image.
      if (msg.conversationId) return self.AnamneDB.updateConversation(msg.conversationId, { exportVersion: crypto.randomUUID() });
    })
    .catch((e) => console.warn("[anamne] store failed", msg.fileId, e));
});

// Toolbar badge: the captured-conversation count. (Auto-sync to Obsidian runs in
// the popup on open — MV3 can't reliably write to a local folder from the
// background — so there's no background-sync state to surface here.)
async function updateBadge() {
  try {
    const n = await self.AnamneDB.countConversations();
    chrome.action.setBadgeText({ text: n ? (n > 99 ? "99+" : String(n)) : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
  } catch (_) {}
}
chrome.runtime.onStartup.addListener(updateBadge);
chrome.runtime.onInstalled.addListener(updateBadge);

// 1.2.0 removed billing and cloud sync. Drop what those left in local storage on
// earlier installs (sign-in token, wrapped key, sync state, payment-library cache).
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason !== "update") return;
  chrome.storage.local.remove([
    "cloud_token", "cloud_email", "cloud_dek", "cloud_sync_state", "cloud_last_backup", "cloud_pending_id",
    "pro_dev_override", "extensionpay_user", "extensionpay_api_key", "extensionpay_installed_at",
  ]).catch(() => {});
  chrome.storage.sync.remove(["extensionpay_api_key", "extensionpay_installed_at", "extensionpay_user"]).catch(() => {});
});

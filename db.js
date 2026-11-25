// Shared IndexedDB layer for Anamne. Loaded by the service worker
// (importScripts), the popup, and the archive page — so there is exactly one
// database, opened at one version, with no conflicting upgrade races.
//
// Stores:
//   kv            — misc key/value (Obsidian vault handle, etc.)
//   conversations — keyPath "id"; captured + normalized conversations, plus the
//                   user's organization fields (folderId, tags)
//   folders       — keyPath "id"; { id, name, parentId }
(function (root) {
  "use strict";
  const DB_NAME = "anamne";
  const DB_VERSION = 4;
  const KV = "kv";
  const CONV = "conversations";
  const FOLDERS = "folders";
  const PROMPTS = "prompts";
  const ASSETS = "assets"; // captured image bytes, keyed by content hash

  let dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
        if (!db.objectStoreNames.contains(CONV)) db.createObjectStore(CONV, { keyPath: "id" });
        if (!db.objectStoreNames.contains(FOLDERS)) db.createObjectStore(FOLDERS, { keyPath: "id" });
        if (!db.objectStoreNames.contains(PROMPTS)) db.createObjectStore(PROMPTS, { keyPath: "id" });
        if (!db.objectStoreNames.contains(ASSETS)) db.createObjectStore(ASSETS, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function reqP(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  // Single-request helper (one op per transaction — safe from auto-commit gaps).
  async function op(store, mode, run) {
    const db = await openDB();
    const tx = db.transaction(store, mode);
    return reqP(run(tx.objectStore(store)));
  }

  // --- kv ---
  const kvGet = (key) => op(KV, "readonly", (s) => s.get(key));
  const kvSet = (key, val) => op(KV, "readwrite", (s) => s.put(val, key));
  const kvDel = (key) => op(KV, "readwrite", (s) => s.delete(key));

  // --- conversations ---
  const getConversation = (id) => op(CONV, "readonly", (s) => s.get(id));
  const getAllConversations = () => op(CONV, "readonly", (s) => s.getAll());
  const countConversations = () => op(CONV, "readonly", (s) => s.count());
  const deleteConversation = (id) => op(CONV, "readwrite", (s) => s.delete(id));
  const clearConversations = () => op(CONV, "readwrite", (s) => s.clear());

  // Capture path: upsert, but never clobber the user's organization. Re-capturing
  // a grown conversation refreshes its messages while preserving folderId/tags.
  async function saveCapture(conv) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CONV, "readwrite");
      const s = tx.objectStore(CONV);
      const get = s.get(conv.id);
      get.onsuccess = () => {
        const prev = get.result;
        const merged = {
          ...conv,
          messages: prev && (conv.platform === "chatgpt" || conv.platform === "gemini") && root.CAMParsers
            ? root.CAMParsers.mergeMessages(prev.messages, conv.messages)
            : conv.messages,
          capturedAt: conv.capturedAt || Date.now(),
          folderId: prev ? (prev.folderId == null ? null : prev.folderId) : conv.folderId ?? null,
          tags: prev ? prev.tags || [] : conv.tags || [],
          // Image refs are attached asynchronously by the image pipeline (background.js)
          // AFTER the capture that created the record. ChatGPT re-fetches a conversation
          // several times on open, so without this a later re-capture would rebuild the
          // record from the parsed payload — which has no top-level images — and silently
          // drop the refs, orphaning the bytes already stored in the assets store.
          images: conv.images && conv.images.length ? conv.images : (prev ? prev.images || [] : []),
          firstCapturedAt: prev ? prev.firstCapturedAt : Date.now(),
          // New content → new export version (drives Obsidian re-sync).
          exportVersion: crypto.randomUUID(),
        };
        const put = s.put(merged);
        put.onsuccess = () => resolve(merged);
        put.onerror = () => reject(put.error);
      };
      get.onerror = () => reject(get.error);
    });
  }

  // Organization edits from the archive UI (set folderId, tags, …).
  async function updateConversation(id, patch) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CONV, "readwrite");
      const s = tx.objectStore(CONV);
      const get = s.get(id);
      get.onsuccess = () => {
        if (!get.result) return resolve(null);
        const merged = { ...get.result, ...patch };
        const put = s.put(merged);
        put.onsuccess = () => resolve(merged);
        put.onerror = () => reject(put.error);
      };
      get.onerror = () => reject(get.error);
    });
  }

  // --- folders ---
  const getAllFolders = () => op(FOLDERS, "readonly", (s) => s.getAll());
  const putFolder = (folder) => op(FOLDERS, "readwrite", (s) => s.put(folder));
  const deleteFolderRecord = (id) => op(FOLDERS, "readwrite", (s) => s.delete(id));

  // --- prompts ---
  const getAllPrompts = () => op(PROMPTS, "readonly", (s) => s.getAll());
  const getPrompt = (id) => op(PROMPTS, "readonly", (s) => s.get(id));
  const putPrompt = (prompt) => op(PROMPTS, "readwrite", (s) => s.put(prompt));
  const deletePrompt = (id) => op(PROMPTS, "readwrite", (s) => s.delete(id));
  // Increment a prompt's useCount in one transaction (called when inserted).
  async function recordPromptUse(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PROMPTS, "readwrite");
      const s = tx.objectStore(PROMPTS);
      const get = s.get(id);
      get.onsuccess = () => {
        if (!get.result) return resolve(null);
        const merged = { ...get.result, useCount: (get.result.useCount || 0) + 1 };
        const put = s.put(merged);
        put.onsuccess = () => resolve(merged);
        put.onerror = () => reject(put.error);
      };
      get.onerror = () => reject(get.error);
    });
  }

  // --- assets (image bytes) --- keyed by content hash so identical images
  // (reused across messages/conversations) are stored once.
  const getAsset = (id) => op(ASSETS, "readonly", (s) => s.get(id));
  const putAsset = (asset) => op(ASSETS, "readwrite", (s) => s.put(asset));
  const deleteAsset = (id) => op(ASSETS, "readwrite", (s) => s.delete(id));
  const getAllAssetIds = () => op(ASSETS, "readonly", (s) => s.getAllKeys());
  const hasAsset = async (id) => (await op(ASSETS, "readonly", (s) => s.getKey(id))) != null;

  const api = {
    openDB,
    kvGet, kvSet, kvDel,
    getConversation, getAllConversations, countConversations,
    deleteConversation, clearConversations, saveCapture, updateConversation,
    getAllFolders, putFolder, deleteFolderRecord,
    getAllPrompts, getPrompt, putPrompt, deletePrompt, recordPromptUse,
    getAsset, putAsset, deleteAsset, getAllAssetIds, hasAsset,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AnamneDB = api;
})(typeof self !== "undefined" ? self : this);

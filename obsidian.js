// Obsidian sync layer (runs in the popup document — the File System Access API
// needs a window + user gesture, which the service worker can't provide).
//
// - The granted vault directory handle is persisted in IndexedDB via the shared
//   db.js kv store (chrome.storage can't hold FileSystemHandles). It survives
//   across sessions; permission may need re-granting, which we do on the sync
//   button's user gesture.
// - A sync index in chrome.storage.local tracks, per conversation id, the last
//   written filename + the capturedAt it reflects, so we can (a) skip unchanged
//   conversations and (b) overwrite-in-place / rename instead of duplicating.
"use strict";
(function (root) {
  const ROOT_DIR = "AI Conversations";
  const VAULT_KEY = "vault_dir";
  const SYNC_KEY = "cam_synced";

  // Vault handle lives in the shared IndexedDB kv store (db.js / AnamneDB).
  const idbGet = (key) => AnamneDB.kvGet(key);
  const idbSet = (key, val) => AnamneDB.kvSet(key, val);
  const idbDel = (key) => AnamneDB.kvDel(key);

  // --- sync index (chrome.storage.local) ---
  async function getSyncIndex() {
    const s = await chrome.storage.local.get(SYNC_KEY);
    return s[SYNC_KEY] || {};
  }
  async function setSyncRecord(id, rec) {
    const idx = await getSyncIndex();
    idx[id] = rec;
    await chrome.storage.local.set({ [SYNC_KEY]: idx });
  }

  // A conversation needs (re)syncing if we've never written it or it has been
  // recaptured since we last wrote it.
  // Export fingerprint: a fresh UUID is stamped on the conversation whenever
  // anything that affects the exported note changes — capture, tag edits, image
  // references, and when image bytes finish downloading. Legacy records predate it,
  // so fall back to capturedAt; old sync records lack the field entirely, which
  // forces exactly one corrective re-export.
  function exportVersionOf(conv) {
    return conv.exportVersion || ("legacy:" + (conv.capturedAt == null ? "0" : conv.capturedAt));
  }
  function isSynced(idx, conv) {
    const rec = idx[conv.id];
    return !!rec && rec.exportVersion === exportVersionOf(conv);
  }

  // --- vault handle ---
  function supported() {
    return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
  }
  async function getVaultHandle() {
    return idbGet(VAULT_KEY);
  }
  async function pickVaultFolder() {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    await idbSet(VAULT_KEY, handle);
    return handle;
  }
  async function forgetVault() {
    await idbDel(VAULT_KEY);
  }
  // Returns true if we hold readwrite permission (requesting it if needed —
  // must be called from within a user gesture for the request path to work).
  async function ensurePermission(handle) {
    const opts = { mode: "readwrite" };
    if ((await handle.queryPermission(opts)) === "granted") return true;
    return (await handle.requestPermission(opts)) === "granted";
  }
  // Read-only permission check (no prompt) — used to decide whether auto-sync can
  // run silently on popup open (without triggering a permission prompt).
  async function hasPermission(handle) {
    return (await handle.queryPermission({ mode: "readwrite" })) === "granted";
  }

  // --- writing ---
  async function writeConversation(handle, conv) {
    const root = await handle.getDirectoryHandle(ROOT_DIR, { create: true });
    const folderName = root && CAMParsers.platformFolder(conv.platform);
    const sub = await root.getDirectoryHandle(folderName, { create: true });
    const filename = CAMParsers.vaultFilename(conv);

    // If the title changed since last sync the filename changes too — remove the
    // stale file so the vault stays clean and idempotent.
    const idx = await getSyncIndex();
    const prev = idx[conv.id];
    if (prev && prev.filename && prev.filename !== filename) {
      try {
        await sub.removeEntry(prev.filename);
      } catch (_) {
        /* old file already gone / moved by user — fine */
      }
    }

    const md = CAMParsers.toObsidianMarkdown(conv); // images are embedded inline per turn
    const fileHandle = await sub.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(md);
    await writable.close();

    // Write captured image bytes alongside the note, under
    // <root>/_attachments/<shortId>/, matching the embeds in the Markdown.
    // A genuine filesystem write failure must leave the conversation PENDING so the
    // next sync retries — we must NOT record it as synced. (Bytes that simply aren't
    // on this device don't throw; writeAssets skips them, which is correct.)
    let assetsOk = true;
    if (conv.images && conv.images.length) {
      try { await writeAssets(root, conv); }
      catch (_) { assetsOk = false; }
    }

    const path = `${ROOT_DIR}/${folderName}/${filename}`;
    if (assetsOk) {
      await setSyncRecord(conv.id, {
        filename,
        path,
        exportVersion: exportVersionOf(conv),
        capturedAt: conv.capturedAt || null,
        syncedAt: Date.now(),
      });
    }
    return { filename, path, pending: !assetsOk };
  }

  // Write a conversation's captured images into <root>/_attachments/<shortId>/,
  // using the same vault names the Markdown embeds reference (assetVaultPaths).
  async function writeAssets(root, conv) {
    const paths = CAMParsers.assetVaultPaths(conv, conv.images);
    if (!paths.length) return;
    const sid = paths[0].dir.split("/")[1]; // dir = "_attachments/<shortId>"
    const attRoot = await root.getDirectoryHandle("_attachments", { create: true });
    const convDir = await attRoot.getDirectoryHandle(sid, { create: true });
    for (const a of paths) {
      const asset = await AnamneDB.getAsset(a.fileId);
      if (!asset || !asset.bytes) continue; // not captured (e.g., synced from another device)
      const fh = await convDir.getFileHandle(a.vaultName, { create: true });
      const w = await fh.createWritable();
      await w.write(asset.bytes);
      await w.close();
    }
  }

  // Sync a single conversation. Throws on no-vault / denied-permission so the UI
  // can surface a precise message.
  async function syncOne(conv) {
    if (!supported()) throw new Error("This browser doesn't support folder access.");
    const handle = await getVaultHandle();
    if (!handle) throw new Error("No vault folder chosen yet.");
    if (!(await ensurePermission(handle)))
      throw new Error("Permission to write the vault was denied.");
    return writeConversation(handle, conv);
  }

  // Background auto-sync: write WITHOUT prompting. If the vault permission has
  // lapsed (Chrome can reset it across sessions), throw a "needs-permission" error
  // so the caller can ask the user to re-arm from a popup gesture. Skips if already
  // synced at the current capturedAt.
  async function syncOneSilent(conv) {
    const handle = await getVaultHandle();
    if (!handle) { const e = new Error("no-vault"); e.code = "no-vault"; throw e; }
    if (!(await hasPermission(handle))) { const e = new Error("needs-permission"); e.code = "needs-permission"; throw e; }
    const idx = await getSyncIndex();
    if (isSynced(idx, conv)) return { skipped: true };
    return writeConversation(handle, conv);
  }

  // Sync every conversation that's new or changed. Returns a summary.
  async function syncAllNew(convs) {
    if (!supported()) throw new Error("This browser doesn't support folder access.");
    const handle = await getVaultHandle();
    if (!handle) throw new Error("No vault folder chosen yet.");
    if (!(await ensurePermission(handle)))
      throw new Error("Permission to write the vault was denied.");

    const idx = await getSyncIndex();
    const pending = Object.values(convs).filter((c) => !isSynced(idx, c));
    let written = 0;
    const errors = [];
    for (const conv of pending) {
      try {
        await writeConversation(handle, conv);
        written++;
      } catch (e) {
        errors.push({ id: conv.id, message: String(e && e.message ? e.message : e) });
      }
    }
    return { written, total: pending.length, errors };
  }

  root.Obsidian = {
    supported,
    getVaultHandle,
    pickVaultFolder,
    forgetVault,
    getSyncIndex,
    isSynced,
    ensurePermission,
    hasPermission,
    syncOne,
    syncOneSilent,
    syncAllNew,
  };
})(typeof self !== "undefined" ? self : this);

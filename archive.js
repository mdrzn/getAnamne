// Archive page controller. Reads conversations + folders from IndexedDB (db.js),
// uses the pure logic in archive-logic.js for search/filtering/tree-building, and
// renders a three-pane UI: sidebar (search + views + platforms + folder tree +
// tags), conversation list, and a reading pane with per-conversation actions.
"use strict";

const state = {
  convs: [],
  folders: [],
  query: "",
  platform: "all",
  // folderSel: "all" | "unfiled" | <folderId>
  folderSel: "all",
  tag: null,
  selectedId: null,
  checked: new Set(), // multi-select for bulk actions
};

const $ = (id) => document.getElementById(id);
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

async function load() {
  [state.convs, state.folders] = await Promise.all([
    AnamneDB.getAllConversations(),
    AnamneDB.getAllFolders(),
  ]);
  renderAll();
}

function currentFolderIds() {
  if (state.folderSel === "all") return null;
  if (state.folderSel === "unfiled") return [null];
  return ArchiveLogic.descendantFolderIds(state.folders, state.folderSel);
}
function filtered() {
  return ArchiveLogic.filterConversations(state.convs, {
    query: state.query,
    platform: state.platform,
    folderIds: currentFolderIds(),
    tag: state.tag,
  });
}
function folderName(id) {
  const f = state.folders.find((x) => x.id === id);
  return f ? f.name : null;
}

function renderAll() {
  renderSidebar();
  renderList();
  renderReader();
  $("count").textContent =
    `${state.convs.length} conversation${state.convs.length === 1 ? "" : "s"}`;
}

// ---------- sidebar ----------
function renderSidebar() {
  // Views
  const unfiled = state.convs.filter((c) => c.folderId == null).length;
  $("views").innerHTML =
    navRow("all", "🗂️ All conversations", state.convs.length, state.folderSel === "all") +
    navRow("unfiled", "📥 Unfiled", unfiled, state.folderSel === "unfiled");

  // Platforms
  const counts = { chatgpt: 0, claude: 0 };
  state.convs.forEach((c) => (counts[c.platform] = (counts[c.platform] || 0) + 1));
  // ChatGPT and Claude always show; other platforms appear once something is captured.
  $("platforms").innerHTML =
    plat("all", "All platforms", state.convs.length) +
    Object.keys(counts).map((k) => plat(k, CAMParsers.assistantName(k), counts[k])).join("");

  // Folder tree
  const tree = ArchiveLogic.buildFolderTree(state.folders);
  $("folders").innerHTML = tree.length
    ? folderTreeHtml(tree, 0)
    : `<div style="color:var(--muted);font-size:12px;padding:4px 8px">No folders yet.</div>`;

  // Tags
  const tags = ArchiveLogic.allTags(state.convs);
  $("tags").innerHTML = tags.length
    ? tags
        .map(
          (t) =>
            `<span class="tagchip${state.tag === t.tag ? " active" : ""}" data-tag="${esc(t.tag)}">#${esc(t.tag)} <span style="opacity:.6">${t.count}</span></span>`
        )
        .join("")
    : `<div style="color:var(--muted);font-size:12px;padding:4px 8px">No tags yet.</div>`;

  wireSidebar();
}
function navRow(key, label, count, active) {
  return `<div class="navrow${active ? " active" : ""}" data-view="${key}" data-drop="${key === "unfiled" ? "unfiled" : ""}">
    <span>${label}</span><span class="c">${count || ""}</span></div>`;
}
function plat(key, label, count) {
  return `<div class="navrow${state.platform === key ? " active" : ""}" data-plat="${key}">
    <span>${label}</span><span class="c">${count || ""}</span></div>`;
}
function folderTreeHtml(nodes, depth) {
  return nodes
    .map((n) => {
      const count = state.convs.filter((c) => c.folderId === n.id).length;
      return (
        `<div class="frow${state.folderSel === n.id ? " active" : ""}" data-folder="${esc(n.id)}" style="padding-left:${8 + depth * 14}px">
          <span class="fname">📁 ${esc(n.name)}</span>
          <span class="c">${count || ""}</span>
          <span class="acts">
            <button class="tiny" data-act="rename" data-id="${esc(n.id)}" title="Rename">✎</button>
            <button class="tiny" data-act="del" data-id="${esc(n.id)}" title="Delete">×</button>
          </span>
        </div>` + folderTreeHtml(n.children, depth + 1)
      );
    })
    .join("");
}

function wireSidebar() {
  $("views").querySelectorAll("[data-view]").forEach((el) => {
    el.onclick = () => {
      state.folderSel = el.dataset.view;
      renderAll();
    };
    if (el.dataset.drop === "unfiled") makeDropTarget(el, null);
  });
  $("platforms").querySelectorAll("[data-plat]").forEach((el) => {
    el.onclick = () => {
      state.platform = el.dataset.plat;
      renderAll();
    };
  });
  $("folders").querySelectorAll(".frow").forEach((el) => {
    const id = el.dataset.folder;
    el.onclick = (e) => {
      if (e.target.closest("[data-act]")) return;
      state.folderSel = id;
      renderAll();
    };
    makeDropTarget(el, id);
    el.querySelectorAll("[data-act]").forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        if (b.dataset.act === "rename") renameFolder(b.dataset.id);
        else deleteFolder(b.dataset.id);
      };
    });
  });
  $("tags").querySelectorAll("[data-tag]").forEach((el) => {
    el.onclick = () => {
      state.tag = state.tag === el.dataset.tag ? null : el.dataset.tag;
      renderAll();
    };
  });
}

function makeDropTarget(el, folderId) {
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    el.classList.add("drop");
  });
  el.addEventListener("dragleave", () => el.classList.remove("drop"));
  el.addEventListener("drop", async (e) => {
    e.preventDefault();
    el.classList.remove("drop");
    const id = e.dataTransfer.getData("text/plain");
    if (id) await moveConv(id, folderId);
  });
}

// Escape text, then wrap query-token matches in <mark> (escaped text + escaped
// tokens, so this stays injection-safe).
function highlight(text, query) {
  const escd = esc(text);
  const tokens = (query || "").trim().split(/\s+/).filter(Boolean)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!tokens.length) return escd;
  return escd.replace(new RegExp("(" + tokens.join("|") + ")", "gi"), "<mark>$1</mark>");
}

// ---------- list ----------
function renderList() {
  const list = filtered();
  // prune checked ids no longer in the filtered set isn't needed; keep selection
  if (!list.length) {
    if (!state.convs.length) {
      $("list").innerHTML = `<div class="empty"><div style="font-size:34px;margin-bottom:10px">🗂️</div>
        <b style="font-size:16px">Your archive is empty — for now.</b><br><br>
        Open or refresh any conversation on ChatGPT, Claude, Gemini, Perplexity, Grok or DeepSeek
        and Anamne captures it here automatically.<br><br>
        Then come back to search, organize into folders &amp; tags, and sync to Obsidian.</div>`;
    } else {
      $("list").innerHTML = `<div class="empty">No conversations match.<br><br>Try clearing the search or filters.</div>`;
    }
    renderBulkBar();
    return;
  }
  const listIds = list.map((c) => c.id);
  $("list").innerHTML =
    bulkBarHtml(listIds) +
    list
      .map((c) => {
        const fn = folderName(c.folderId);
        const tags = (c.tags || []).map((t) => `<span class="pill">#${esc(t)}</span>`).join(" ");
        const checked = state.checked.has(c.id);
        return `<div class="card${state.selectedId === c.id ? " sel" : ""}${checked ? " checked" : ""}" data-id="${esc(c.id)}" draggable="true">
        <label class="ck"><input type="checkbox" data-ck="${esc(c.id)}"${checked ? " checked" : ""} /></label>
        <div class="cbody">
          <div class="t">${highlight(c.title, state.query)} <span class="pill ${esc(c.platform)}">${esc(c.platform)}</span></div>
          <div class="sn">${highlight(ArchiveLogic.snippet(c, state.query, 140), state.query)}</div>
          <div class="meta">
            <span>${(c.messages || []).length} msgs</span>
            ${c.images && c.images.length ? `<span title="${c.images.length} image${c.images.length === 1 ? "" : "s"}">🖼 ${c.images.length}</span>` : ""}
            <span>${new Date(c.capturedAt).toLocaleDateString()}</span>
            ${fn ? `<span>📁 ${esc(fn)}</span>` : ""}
            ${tags}
          </div>
        </div>
      </div>`;
      })
      .join("");
  $("list")
    .querySelectorAll(".card")
    .forEach((el) => {
      el.querySelector(".cbody").onclick = () => {
        state.selectedId = el.dataset.id;
        renderList();
        renderReader();
      };
      el.querySelector("[data-ck]").addEventListener("change", (e) => {
        e.target.checked ? state.checked.add(el.dataset.id) : state.checked.delete(el.dataset.id);
        renderList();
      });
      el.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", el.dataset.id));
    });
  wireBulkBar(listIds);
}

// ---------- bulk actions ----------
function bulkBarHtml(listIds) {
  const n = state.checked.size;
  if (!n) {
    return `<div class="bulkbar"><label class="ck"><input type="checkbox" id="ckAll" /></label>
      <span class="bk">Select</span></div>`;
  }
  const folderOpts = `<option value="__none">Move to folder…</option><option value="">— Unfiled —</option>` +
    state.folders.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("");
  return `<div class="bulkbar on">
    <label class="ck"><input type="checkbox" id="ckAll" checked /></label>
    <span class="bk"><b>${n}</b> selected</span>
    <span class="bsp"></span>
    <button class="tiny" id="bSync">Sync</button>
    <select id="bMove">${folderOpts}</select>
    <button class="tiny" id="bTag">Tag…</button>
    <button class="tiny" id="bDel">Delete</button>
    <button class="tiny" id="bClear">✕</button>
  </div>`;
}
function renderBulkBar() {
  // for empty list, still allow clearing selection
  if (state.checked.size) state.checked.clear();
}
function checkedConvs() {
  return state.convs.filter((c) => state.checked.has(c.id));
}
function wireBulkBar(listIds) {
  const all = $("ckAll");
  if (all) all.onchange = (e) => {
    if (e.target.checked) listIds.forEach((id) => state.checked.add(id));
    else state.checked.clear();
    renderList();
  };
  const clear = $("bClear");
  if (clear) clear.onclick = () => { state.checked.clear(); renderList(); };
  const del = $("bDel");
  if (del) del.onclick = async () => {
    const items = checkedConvs();
    if (!items.length || !confirm(`Delete ${items.length} conversation(s) from the archive?`)) return;
    for (const c of items) await AnamneDB.deleteConversation(c.id);
    if (state.checked.has(state.selectedId)) state.selectedId = null;
    state.checked.clear();
    await load();
  };
  const tag = $("bTag");
  if (tag) tag.onclick = async () => {
    const raw = prompt("Add tag to selected conversations:");
    const t = (raw || "").trim().toLowerCase().replace(/\s+/g, "-");
    if (!t) return;
    for (const c of checkedConvs()) {
      const tags = Array.from(new Set([...(c.tags || []), t]));
      await AnamneDB.updateConversation(c.id, { tags, exportVersion: crypto.randomUUID() });
    }
    await load();
  };
  const move = $("bMove");
  if (move) move.onchange = async (e) => {
    const v = e.target.value;
    if (v === "__none") return;
    for (const c of checkedConvs()) await AnamneDB.updateConversation(c.id, { folderId: v || null });
    await load();
  };
  const sync = $("bSync");
  if (sync) sync.onclick = async () => {
    const items = checkedConvs();
    let ok = 0;
    for (const c of items) { try { await Obsidian.syncOne(c); ok++; } catch (_) {} }
    alert(`Synced ${ok}/${items.length} to Obsidian.` + (ok < items.length ? " (Check the vault folder is set.)" : ""));
  };
}

// ---------- reader ----------
function selected() {
  return state.convs.find((c) => c.id === state.selectedId) || null;
}
function setStatus(msg, kind) {
  const el = $("status");
  if (el) {
    el.textContent = msg || "";
    el.className = "status" + (kind ? " " + kind : "");
  }
}
function renderReader() {
  const c = selected();
  if (!c) {
    $("reader").innerHTML = `<div class="empty">Select a conversation to read it here.</div>`;
    return;
  }
  const url = CAMParsers.sourceUrl(c);
  const folderOptions =
    `<option value="">— Unfiled —</option>` +
    state.folders
      .map((f) => `<option value="${esc(f.id)}"${c.folderId === f.id ? " selected" : ""}>${esc(f.name)}</option>`)
      .join("");
  const tagChips = (c.tags || [])
    .map((t) => `<span class="tagchip" data-rmtag="${esc(t)}">#${esc(t)} ×</span>`)
    .join("");
  $("reader").innerHTML = `
    <h2>${esc(c.title)}</h2>
    <div class="rmeta">
      <span class="pill ${esc(c.platform)}">${esc(c.platform)}</span>
      <span>${(c.messages || []).length} messages</span>
      <span>captured ${new Date(c.capturedAt).toLocaleString()}</span>
      ${url ? `<a href="${esc(url)}" target="_blank" rel="noreferrer">open original ↗</a>` : ""}
    </div>
    <div class="rbar">
      <button class="primary" id="sync">Sync to Obsidian</button>
      <button id="export">Export .md</button>
      <label style="color:var(--muted);font-size:12px">Folder:
        <select id="movesel">${folderOptions}</select>
      </label>
      <button id="del" style="margin-left:auto">Delete</button>
    </div>
    <div class="status" id="status"></div>
    <div class="tagedit">
      ${tagChips}
      <input class="tagin" id="tagin" placeholder="add tag + Enter" autocomplete="off" />
    </div>
    <div id="imagegallery"></div>
    <div id="messages">${renderMessages(c)}</div>`;
  renderConvImages(c);
  addCodeCopyButtons();

  $("sync").onclick = async () => {
    setStatus("Syncing…");
    try {
      const r = await Obsidian.syncOne(c);
      setStatus("Written to " + r.path, "ok");
    } catch (e) {
      setStatus(e.message, "bad");
    }
  };
  $("export").onclick = () => {
    const md = CAMParsers.toObsidianMarkdown(c);
    const blob = new Blob([md], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = CAMParsers.vaultFilename(c);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  $("del").onclick = () => deleteConv(c.id);
  $("movesel").onchange = (e) => moveConv(c.id, e.target.value || null);
  $("tagin").onkeydown = (e) => {
    if (e.key === "Enter") addTag(c.id, e.target.value);
  };
  $("reader")
    .querySelectorAll("[data-rmtag]")
    .forEach((el) => (el.onclick = () => removeTag(c.id, el.dataset.rmtag)));
}
// Captured images for the open conversation, from the local `assets` store.
// One object URL per image, reused in the top gallery AND inline at each turn.
// Revokes the previous set on each render to avoid leaks.
let galleryUrls = [];
async function renderConvImages(c) {
  galleryUrls.forEach((u) => URL.revokeObjectURL(u));
  galleryUrls = [];
  const urlByFile = new Map();
  const order = [];
  for (const im of c.images || []) {
    if (urlByFile.has(im.fileId)) continue;
    const asset = await AnamneDB.getAsset(im.fileId);
    if (!asset || !asset.bytes) continue;
    const u = URL.createObjectURL(asset.bytes);
    galleryUrls.push(u);
    urlByFile.set(im.fileId, u);
    order.push(im.fileId);
  }
  if (state.selectedId !== c.id) return; // selection changed while loading
  // Images are zoomable (click → lightbox), sized by their parent (.imgstrip thumb
  // vs .msgimgs inline). data-full carries the blob URL for the lightbox.
  const tag = (fid) => `<img data-full="${urlByFile.get(fid)}" src="${urlByFile.get(fid)}" loading="lazy" />`;
  const top = document.getElementById("imagegallery");
  if (top) {
    top.innerHTML = order.length
      ? `<div class="imghd">🖼 Images (${order.length})${order.length > 3 ? ` <button id="dlall">Download all</button>` : ""}</div>
         <div class="imgstrip">${order.map(tag).join("")}</div>`
      : "";
    const dl = document.getElementById("dlall");
    if (dl) dl.onclick = () => downloadAllImages(c);
  }
  document.querySelectorAll(".msgimgs[data-imgs]").forEach((el) => {
    const ids = el.dataset.imgs.split(",").filter((f) => urlByFile.has(f));
    el.innerHTML = ids.map(tag).join("");
  });
}

// Download every captured image for a conversation (staggered so the browser
// doesn't block the burst).
async function downloadAllImages(c) {
  for (const im of c.images || []) {
    const asset = await AnamneDB.getAsset(im.fileId);
    if (!asset || !asset.bytes) continue;
    const u = URL.createObjectURL(asset.bytes);
    const a = document.createElement("a");
    a.href = u;
    a.download = im.filename || im.fileId + ".png";
    a.click();
    await new Promise((r) => setTimeout(r, 350));
    URL.revokeObjectURL(u);
  }
}

// Lightbox: click any archive image to view it full-size; click the overlay to close.
function openLightbox(url) {
  const lb = document.getElementById("lightbox");
  if (!lb) return;
  lb.querySelector("img").src = url;
  lb.classList.add("open");
}
document.addEventListener("click", (e) => {
  const img = e.target.closest && e.target.closest("img[data-full]");
  if (img) { openLightbox(img.dataset.full); return; }
  const lb = document.getElementById("lightbox");
  if (lb && e.target.closest("#lightbox")) lb.classList.remove("open");
});
// Add a hover "Copy" button to each rendered code block.
function addCodeCopyButtons() {
  document.querySelectorAll("#messages .txt.md pre").forEach((pre) => {
    if (pre.querySelector(".copybtn")) return;
    const code = pre.textContent;
    const btn = document.createElement("button");
    btn.className = "copybtn";
    btn.textContent = "Copy";
    btn.onclick = (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(code);
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = "Copy"), 1200);
    };
    pre.appendChild(btn);
  });
}

// Per-message timestamp → short local date+time. Handles ChatGPT epoch-seconds
// (number) and Claude ISO strings; returns "" if unknown.
function msgTime(t) {
  if (t == null) return "";
  const ms = typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : Date.parse(t);
  if (!ms || isNaN(ms)) return "";
  return new Date(ms).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
function renderMessages(c) {
  return (c.messages || [])
    .map((m) => {
      const who = m.role === "assistant" ? CAMParsers.assistantName(c.platform) : "You";
      const t = msgTime(m.time);
      // Markdown-render the message body (renderer escapes HTML internally).
      const body = m.text ? `<div class="bubble"><div class="txt md">${AnamneMD.renderMarkdown(m.text)}</div></div>` : "";
      const fids = (m.images || []).join(",");
      const imgs = fids ? `<div class="msgimgs" data-imgs="${esc(fids)}"></div>` : "";
      return `<div class="msg ${esc(m.role)}"><div class="who">${who}${t ? ` <span class="wt">· ${t}</span>` : ""}</div>${body}${imgs}</div>`;
    })
    .join("");
}

// ---------- mutations ----------
async function moveConv(convId, folderId) {
  await AnamneDB.updateConversation(convId, { folderId: folderId || null });
  await load();
}
async function deleteConv(convId) {
  if (!confirm("Delete this conversation from the archive? (Your synced Obsidian file is not touched.)")) return;
  await AnamneDB.deleteConversation(convId);
  if (state.selectedId === convId) state.selectedId = null;
  await load();
}
async function addTag(convId, raw) {
  const tag = (raw || "").trim().toLowerCase().replace(/\s+/g, "-");
  if (!tag) return;
  const c = state.convs.find((x) => x.id === convId);
  const tags = Array.from(new Set([...(c.tags || []), tag]));
  await AnamneDB.updateConversation(convId, { tags, exportVersion: crypto.randomUUID() });
  await load();
}
async function removeTag(convId, tag) {
  const c = state.convs.find((x) => x.id === convId);
  const tags = (c.tags || []).filter((t) => t !== tag);
  await AnamneDB.updateConversation(convId, { tags, exportVersion: crypto.randomUUID() });
  await load();
}
async function createFolder() {
  const name = prompt("Folder name:");
  if (!name || !name.trim()) return;
  const parentId =
    state.folderSel !== "all" && state.folderSel !== "unfiled" ? state.folderSel : null;
  await AnamneDB.putFolder({ id: crypto.randomUUID(), name: name.trim(), parentId });
  await load();
}
async function renameFolder(id) {
  const f = state.folders.find((x) => x.id === id);
  if (!f) return;
  const name = prompt("Rename folder:", f.name);
  if (!name || !name.trim()) return;
  await AnamneDB.putFolder({ ...f, name: name.trim() });
  await load();
}
async function deleteFolder(id) {
  const f = state.folders.find((x) => x.id === id);
  if (!f) return;
  if (!confirm(`Delete folder "${f.name}"? Its conversations and subfolders move up to its parent.`)) return;
  const parent = f.parentId || null;
  for (const child of state.folders.filter((x) => x.parentId === id))
    await AnamneDB.putFolder({ ...child, parentId: parent });
  for (const c of state.convs.filter((c) => c.folderId === id))
    await AnamneDB.updateConversation(c.id, { folderId: parent });
  await AnamneDB.deleteFolderRecord(id);
  if (state.folderSel === id) state.folderSel = parent || "all";
  await load();
}

// ---------- boot ----------
$("newFolder").onclick = createFolder;
$("search").addEventListener("input", (e) => {
  state.query = e.target.value;
  renderList();
});

// Keyboard nav: "/" focus search, ↑/↓ move selection, Enter open, Esc clear.
document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
  if (e.key === "/" && !typing) { e.preventDefault(); $("search").focus(); return; }
  if (e.key === "Escape") {
    if (typing) { document.activeElement.blur(); return; }
    if (state.checked.size) { state.checked.clear(); renderList(); }
    return;
  }
  if (typing) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const list = filtered();
    if (!list.length) return;
    e.preventDefault();
    const idx = list.findIndex((c) => c.id === state.selectedId);
    const next = e.key === "ArrowDown"
      ? Math.min(list.length - 1, idx + 1)
      : Math.max(0, idx < 0 ? 0 : idx - 1);
    state.selectedId = list[next].id;
    renderList();
    renderReader();
    const sel = document.querySelector(".card.sel");
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }
});

load();

// Export all: every conversation as Markdown, in the same layout Obsidian sync
// writes (AI Conversations/<Platform>/<file>.md, images under _attachments/),
// packed into one .zip download.
async function exportAll() {
  const btn = document.getElementById("exportAll");
  const label = btn.textContent;
  btn.disabled = true;
  try {
    const convs = await AnamneDB.getAllConversations();
    const enc = new TextEncoder();
    const entries = [];
    const ROOT = "AI Conversations";
    for (let i = 0; i < convs.length; i++) {
      const c = convs[i];
      btn.textContent = `Exporting ${i + 1}/${convs.length}…`;
      entries.push({
        name: `${ROOT}/${CAMParsers.platformFolder(c.platform)}/${CAMParsers.vaultFilename(c)}`,
        data: enc.encode(CAMParsers.toObsidianMarkdown(c)),
      });
      for (const a of CAMParsers.assetVaultPaths(c, c.images || [])) {
        const asset = await AnamneDB.getAsset(a.fileId);
        if (!asset || !asset.bytes) continue;
        entries.push({ name: `${ROOT}/${a.dir}/${a.vaultName}`, data: new Uint8Array(await asset.bytes.arrayBuffer()) });
      }
    }
    const blob = new Blob([AnamneZip.buildZip(entries)], { type: "application/zip" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `anamne-export-${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (e) {
    console.error("[Anamne] export all failed", e);
    alert("Export failed: " + e.message);
  } finally {
    btn.textContent = label;
    btn.disabled = false;
  }
}
document.getElementById("exportAll").onclick = exportAll;

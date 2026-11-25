// Pure, side-effect-free archive logic — folder-tree building, folder descendant
// resolution, conversation search/filtering, tag aggregation, and snippets.
// Shared by the archive page (window.ArchiveLogic) and the Node tests
// (module.exports). No IndexedDB or DOM here, so it stays unit-testable.
(function (root) {
  "use strict";

  // Flat [{id, name, parentId}] -> nested [{...f, children:[...]}], each level
  // sorted case-insensitively by name. A parentId pointing nowhere is a root.
  function buildFolderTree(folders) {
    const byId = new Map((folders || []).map((f) => [f.id, { ...f, children: [] }]));
    const roots = [];
    for (const node of byId.values()) {
      const parent =
        node.parentId != null && byId.has(node.parentId) ? byId.get(node.parentId) : null;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    const sortRec = (nodes) => {
      nodes.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      nodes.forEach((n) => sortRec(n.children));
      return nodes;
    };
    return sortRec(roots);
  }

  // A folder id plus every id beneath it (for "this folder and its subfolders").
  function descendantFolderIds(folders, folderId) {
    const childrenOf = new Map();
    for (const f of folders || []) {
      if (!childrenOf.has(f.parentId)) childrenOf.set(f.parentId, []);
      childrenOf.get(f.parentId).push(f.id);
    }
    const out = [];
    const stack = [folderId];
    while (stack.length) {
      const id = stack.pop();
      out.push(id);
      for (const kid of childrenOf.get(id) || []) stack.push(kid);
    }
    return out;
  }

  function haystack(conv) {
    const parts = [conv.title || ""];
    for (const m of conv.messages || []) parts.push(m.text || "");
    if (Array.isArray(conv.tags)) parts.push(conv.tags.join(" "));
    return parts.join("\n").toLowerCase();
  }

  // Filter by free-text query (AND across whitespace tokens), platform, folder
  // set (pass descendantFolderIds; include null for unfiled), and a single tag.
  // Always returned newest-first.
  function filterConversations(conversations, opts) {
    opts = opts || {};
    const { query, platform, folderIds, tag } = opts;
    const tokens = query ? String(query).toLowerCase().split(/\s+/).filter(Boolean) : [];
    const result = (conversations || []).filter((c) => {
      if (platform && platform !== "all" && c.platform !== platform) return false;
      if (tag && !(Array.isArray(c.tags) && c.tags.includes(tag))) return false;
      if (folderIds != null) {
        const fid = c.folderId == null ? null : c.folderId;
        if (!folderIds.includes(fid)) return false;
      }
      if (tokens.length) {
        const hay = haystack(c);
        if (!tokens.every((t) => hay.includes(t))) return false;
      }
      return true;
    });
    result.sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0));
    return result;
  }

  // [{tag, count}] across all conversations, sorted alphabetically.
  function allTags(conversations) {
    const counts = new Map();
    for (const c of conversations || [])
      for (const t of c.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => a.tag.toLowerCase().localeCompare(b.tag.toLowerCase()));
  }

  // A short, whitespace-collapsed excerpt — centered on the first query match if
  // there is one, else the start of the body. Ellipsis where text is clipped.
  function snippet(conv, query, maxLen) {
    maxLen = maxLen || 120;
    const body = (conv.messages || [])
      .map((m) => m.text || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const tokens = query ? String(query).toLowerCase().split(/\s+/).filter(Boolean) : [];
    let start = 0;
    if (tokens.length) {
      const idx = body.toLowerCase().indexOf(tokens[0]);
      if (idx > 30) start = idx - 30;
    }
    const end = start + maxLen;
    let s = body.slice(start, end);
    if (start > 0) s = "…" + s;
    if (end < body.length) s = s + "…";
    return s;
  }

  const api = { buildFolderTree, descendantFolderIds, filterConversations, allTags, snippet };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ArchiveLogic = api;
})(typeof self !== "undefined" ? self : this);

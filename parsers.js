// Pure parsing logic, shared by the service worker (via importScripts) and the
// Node test (via require). Turns raw host API payloads into a normalized shape:
//   { id, platform, title, messages: [{ role: "user"|"assistant", text, time }] }
(function (root) {
  "use strict";

  // Display name for the assistant, per platform (used in Markdown/headings).
  const DISPLAY = {
    chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini",
    perplexity: "Perplexity", grok: "Grok", deepseek: "DeepSeek",
  };
  function assistantName(platform) {
    return DISPLAY[platform] || (platform ? platform[0].toUpperCase() + platform.slice(1) : "Assistant");
  }
  // A short title derived from the first user message, for platforms whose
  // conversation payload carries no title of its own.
  function titleFromMessages(messages) {
    const first = (messages || []).find((m) => m.role === "user") || (messages || [])[0];
    if (!first) return null;
    const t = String(first.text || "").replace(/\s+/g, " ").trim();
    return t ? t.slice(0, 60) : null;
  }

  // ChatGPT embeds inline image groups, entities, citations, and navlists as
  // spans wrapped in Private-Use-Area sentinel chars (U+E200 open … U+E201 close,
  // U+E202 separator). Strip the whole spans, then any stray PUA chars, so this
  // markup never leaks into the captured text or the Obsidian export.
  function cleanChatGPTText(s) {
    if (typeof s !== "string") return "";
    return s
      .replace(/[\s\S]*?/g, "")
      .replace(/[-]/g, "")
      .replace(/\n{3,}/g, "\n\n");
  }

  // Pulls the conversation UUID out of the request URL, the fallback when a
  // payload no longer carries its own id.
  const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
  function idFromUrl(url) {
    const all = String(url || "").match(UUID_RE);
    return all ? all[all.length - 1] : null; // Claude URLs carry the org id first
  }
  // Depth-first walk collecting every object `pick` accepts (bounded, cycle-safe).
  // Used as a fallback when a site reshapes its payload around the same message
  // objects, so capture keeps working instead of silently stopping.
  function collect(root, pick, max = 5000) {
    const out = [], seen = new Set(), stack = [root];
    while (stack.length && out.length < max) {
      const v = stack.pop();
      if (!v || typeof v !== "object" || seen.has(v)) continue;
      seen.add(v);
      if (pick(v)) { out.push(v); continue; }
      for (const k in v) if (v[k] && typeof v[k] === "object") stack.push(v[k]);
    }
    return out;
  }

  function parseChatGPT(text, url) {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== "object") return null;
    // Classic shape: { mapping: { id: { message } } }. Otherwise (the paged Nov-2026
    // endpoint, or any wrapper) find the message objects wherever they sit.
    const isMsg = (v) => v.author && v.author.role && v.content && typeof v.content === "object";
    let nodes;
    const mapping = obj.mapping || (obj.conversation && obj.conversation.mapping);
    if (mapping) {
      nodes = Object.values(mapping).filter((n) => n && n.message && isMsg(n.message));
    } else {
      const byId = new Map();
      for (const m of collect(obj, isMsg)) byId.set(m.id || byId.size, m);
      nodes = [...byId.values()].map((message) => ({ message }));
    }
    const meta = obj.conversation && typeof obj.conversation === "object" ? obj.conversation : obj;
    nodes.sort(
      (a, b) => (a.message.create_time || 0) - (b.message.create_time || 0)
    );
    const messages = [];
    const seenImg = new Set(); // a generated image repeats across final+commentary nodes
    for (const n of nodes) {
      const m = n.message;
      const role = m.author.role;
      if (role === "system") continue;
      if (m.metadata && m.metadata.is_visually_hidden_from_conversation) continue;
      const c = m.content;
      // Collect text + image asset pointers from the parts (file id is the tail of
      // the pointer). Images are deduped across the whole conversation so the same
      // generated image isn't placed twice.
      const imgs = [];
      const textParts = [];
      if (Array.isArray(c.parts)) {
        for (const p of c.parts) {
          if (typeof p === "string") textParts.push(p);
          else if (p && p.content_type === "image_asset_pointer" && p.asset_pointer) {
            const fid = String(p.asset_pointer).replace(/^[a-z-]+:\/\//, "");
            if (fid && !seenImg.has(fid)) { seenImg.add(fid); imgs.push(fid); }
          } else if (p && typeof p.text === "string") textParts.push(p.text);
        }
      } else if (typeof c.text === "string") {
        textParts.push(c.text);
      }
      // Tool turns carry images only (their text is tool-call / caption plumbing);
      // everything else keeps its text exactly as before.
      let txt = role === "tool" ? "" : textParts.join("\n");
      txt = cleanChatGPTText(txt).trim();
      if (!txt && !imgs.length) continue;
      messages.push({
        id: m.id,
        role: role === "user" ? "user" : "assistant",
        text: txt,
        images: imgs,
        time: m.create_time || null,
      });
    }
    if (!messages.length) return null;
    const title = obj.title || meta.title;
    return {
      id: obj.conversation_id || meta.conversation_id || idFromUrl(url) || "chatgpt-" + (title || Date.now()),
      platform: "chatgpt",
      title: title || "Untitled ChatGPT conversation",
      messages,
    };
  }

  function parseClaude(text, url) {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== "object") return null;
    const meta = obj.conversation && typeof obj.conversation === "object" ? obj.conversation : obj;
    let arr = meta.chat_messages || meta.messages || obj.chat_messages || obj.messages || null;
    if (!Array.isArray(arr)) {
      // Fallback for a reshaped payload: any objects that look like Claude messages.
      const isMsg = (v) => !Array.isArray(v) && /^(human|assistant|user)$/.test(v.sender || v.role || "") &&
        (typeof v.text === "string" || Array.isArray(v.content));
      arr = collect(obj, isMsg);
      arr.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
    }
    if (!arr.length) return null;
    const messages = [];
    for (const m of arr) {
      let txt = m.text;
      if ((!txt || !txt.trim()) && Array.isArray(m.content)) {
        txt = m.content
          .map((b) => (typeof b === "string" ? b : (b && b.text) || ""))
          .join("\n");
      }
      if (!txt || !txt.trim()) continue;
      const sender = m.sender || m.role;
      messages.push({
        role: sender === "assistant" ? "assistant" : "user",
        text: txt,
        time: m.created_at || null,
      });
    }
    if (!messages.length) return null;
    return {
      id: meta.uuid || obj.uuid || idFromUrl(url) || "claude-" + (meta.name || Date.now()),
      platform: "claude",
      title: meta.name || obj.name || "Untitled Claude conversation",
      messages,
    };
  }

  // --- Shared helpers for the additional platforms ----------------------------
  // Roles vary by platform ("USER"/"human"/"user" → user; everything else with
  // content → assistant). Returns null if no usable messages.
  function isUserRole(v) {
    return /^(user|human)$/i.test(String(v || ""));
  }
  function blockText(c) {
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map(blockText).join("\n");
    if (c && typeof c === "object") return c.text || c.content || "";
    return "";
  }
  function buildConv(platform, id, title, rawMessages, getRole, getText, getTime) {
    const messages = [];
    for (const m of rawMessages || []) {
      const txt = String(getText(m) || "").trim();
      if (!txt) continue;
      messages.push({ role: isUserRole(getRole(m)) ? "user" : "assistant", text: txt, time: getTime ? getTime(m) || null : null });
    }
    if (!messages.length) return null;
    return { id: id || platform + "-" + Date.now(), platform, title: title || titleFromMessages(messages) || ("Untitled " + platform + " conversation"), messages };
  }

  // DeepSeek (chat.deepseek.com): GET /api/v0/chat/history_messages →
  // data.biz_data.chat_messages[]. Text lives in fragments[].content (REQUEST/
  // RESPONSE), not a plain field.
  function deepseekText(m) {
    if (Array.isArray(m.fragments)) {
      return m.fragments
        .map((f) => (f && typeof f.content === "string" ? f.content : ""))
        .filter(Boolean)
        .join("\n\n");
    }
    if (m.content != null) return blockText(m.content);
    return m.text || "";
  }
  function parseDeepSeek(text) {
    const obj = JSON.parse(text);
    const biz = obj && obj.data && obj.data.biz_data;
    const arr = biz && (biz.chat_messages || biz.messages);
    if (!Array.isArray(arr)) return null;
    const sess = (biz && biz.chat_session) || {};
    return buildConv("deepseek", sess.id, sess.title, arr,
      (m) => m.role || m.sender, deepseekText, (m) => m.inserted_at || m.created_at);
  }

  // Grok (grok.com): /rest/app-chat/conversations/{id}/load-responses → responses[].
  function parseGrok(text) {
    const obj = JSON.parse(text);
    const arr = obj && (obj.responses || obj.messages);
    if (!Array.isArray(arr)) return null;
    const conv = (obj && obj.conversation) || {};
    return buildConv("grok", conv.conversation_id || conv.id || obj.conversation_id, conv.title || obj.title, arr,
      (m) => m.sender || m.role, (m) => m.message != null ? m.message : blockText(m.content || m.text), (m) => m.create_time || m.created_at);
  }

  // Perplexity (perplexity.ai): /rest/thread/{uuid}?with_schematized_response=true.
  // Each entry = a user query (query_str) + the answer, which lives in blocks[]
  // where intended_usage starts with "ask_text" → markdown_block.answer. (Note:
  // Perplexity follow-ups are separate thread nodes, so each is its own capture.)
  function perplexityAnswer(entry) {
    const blocks = (entry && entry.blocks) || [];
    // Prefer the canonical answer block; fall back to any markdown_block.answer.
    for (const b of blocks) {
      if (b && b.markdown_block && typeof b.markdown_block.answer === "string" &&
          b.markdown_block.answer.trim() && String(b.intended_usage || "").indexOf("ask_text") === 0) {
        return b.markdown_block.answer;
      }
    }
    for (const b of blocks) {
      if (b && b.markdown_block && typeof b.markdown_block.answer === "string" && b.markdown_block.answer.trim())
        return b.markdown_block.answer;
    }
    // older/simpler shapes
    if (typeof entry.answer === "string") return entry.answer;
    if (typeof entry.text === "string") return entry.text;
    return "";
  }
  function parsePerplexity(text) {
    const obj = JSON.parse(text);
    const entries = obj && (obj.entries || obj.thread || obj.steps);
    if (!Array.isArray(entries) || !entries.length) return null;
    const messages = [];
    let id = null, title = null;
    for (const e of entries) {
      const q = (e.query_str || e.query || "").trim();
      if (q) messages.push({ role: "user", text: q, time: e.updated_datetime || null });
      const a = perplexityAnswer(e).trim();
      if (a) messages.push({ role: "assistant", text: a, time: e.updated_datetime || null });
      if (!id) id = e.backend_uuid || e.uuid;
      if (!title) title = e.thread_title;
    }
    if (!messages.length) return null;
    title = title || obj.title || (obj.thread_metadata && obj.thread_metadata.title) || titleFromMessages(messages);
    return {
      id: id || obj.uuid || obj.thread_uuid || "perplexity-" + Date.now(),
      platform: "perplexity",
      title: title || "Untitled Perplexity thread",
      messages,
    };
  }

  // Gemini (gemini.google.com): the conversation arrives in a `batchexecute` RPC
  // envelope — a `)]}'` prefix, length-prefixed chunks, and a `wrb.fr` entry whose
  // 3rd element is a JSON *string* of the conversation. Within it, turns are
  // newest-first; each turn ≈ [ids, ids, [[userText],…], [[[rcId,[asstText],…]]], …, [sec,nanos]].
  // Fragile by nature (Google rotates this format) — verified 2026-06-17.
  function geminiTurnUser(turn) {
    const v = turn && turn[2] && turn[2][0] && turn[2][0][0];
    return typeof v === "string" ? v : "";
  }
  function geminiTurnAssistant(turn) {
    const v = turn && turn[3] && turn[3][0] && turn[3][0][0] && turn[3][0][0][1] && turn[3][0][0][1][0];
    return typeof v === "string" ? v : "";
  }
  // A real conversation turn is tagged with a `c_…` conversation id at turn[0][0].
  // Typeahead/suggestion chunks have user-like strings but no such id — requiring
  // it stops them being captured as junk conversations.
  function geminiIsRealTurn(t) {
    return Array.isArray(t) && Array.isArray(t[0]) &&
      typeof t[0][0] === "string" && t[0][0].startsWith("c_") &&
      (geminiTurnUser(t) || geminiTurnAssistant(t));
  }
  function geminiLooksLikeConversation(data) {
    return Array.isArray(data) && Array.isArray(data[0]) && data[0].some(geminiIsRealTurn);
  }
  // Extract generated/uploaded images from a Gemini conversation payload (the
  // hNvQHb batchexecute). Images are nodes [null,1,filename,lh3-url,…,mime,…,[w,h,size]]
  // and arrive in variant groups (png+jpg of an upload; small/large/jpeg of a
  // generation) — we keep the largest per group, png preferred. The lh3 URLs are
  // public, so the background can fetch the bytes directly (no page session needed).
  function geminiImageAssets(text) {
    const body = String(text || "").replace(/^\)\]\}'/, "");
    let inner = null;
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (t[0] !== "[") continue;
      let arr;
      try { arr = JSON.parse(t); } catch (_) { continue; }
      if (!Array.isArray(arr)) continue;
      for (const el of arr) {
        if (Array.isArray(el) && el[0] === "wrb.fr" && el[1] === "hNvQHb" && typeof el[2] === "string") {
          try { inner = JSON.parse(el[2]); } catch (_) {}
        }
      }
      if (inner) break;
    }
    if (!inner) return [];

    const isImg = (a) => Array.isArray(a) && typeof a[3] === "string" && /^https:\/\/lh3\.googleusercontent\.com\//.test(a[3]);
    const toAsset = (n) => {
      const dims = n[n.length - 1];
      const w = Array.isArray(dims) ? dims[0] : null;
      const h = Array.isArray(dims) ? dims[1] : null;
      const mime = typeof n[11] === "string" && /^image\//.test(n[11]) ? n[11] : "image/png";
      const filename = String(n[2] || "") || "gemini-image" + extForMime(mime);
      return { fileId: filename, url: n[3], filename, mime, width: w, height: h, area: w && h ? w * h : 0 };
    };
    const byFile = new Map();
    const walk = (node) => {
      if (!Array.isArray(node)) return;
      const variants = [];
      const consumed = new Set();
      node.forEach((c, i) => {
        if (isImg(c)) { variants.push(toAsset(c)); consumed.add(i); }
        else if (Array.isArray(c) && isImg(c[0])) { variants.push(toAsset(c[0])); consumed.add(i); }
      });
      if (variants.length) {
        variants.sort((a, b) => b.area - a.area || (a.mime === "image/png" ? -1 : 1) - (b.mime === "image/png" ? -1 : 1));
        const best = variants[0];
        if (!byFile.has(best.fileId)) byFile.set(best.fileId, best);
      }
      node.forEach((c, i) => { if (!consumed.has(i)) walk(c); });
    };
    walk(inner);
    return [...byFile.values()].map(({ area, ...rest }) => rest);
  }

  function parseGemini(text) {
    const body = String(text || "").replace(/^\)\]\}'/, "");
    let inner = null;
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (t[0] !== "[") continue;
      let arr;
      try { arr = JSON.parse(t); } catch (_) { continue; }
      if (!Array.isArray(arr)) continue;
      for (const el of arr) {
        if (Array.isArray(el) && el[0] === "wrb.fr" && typeof el[2] === "string") {
          let data;
          try { data = JSON.parse(el[2]); } catch (_) { continue; }
          if (geminiLooksLikeConversation(data)) { inner = data; break; }
        }
      }
      if (inner) break;
    }
    if (!inner) return null;

    const turns = inner[0];
    let convId = null;
    const items = [];
    for (const turn of turns) {
      if (!geminiIsRealTurn(turn)) continue;
      const cid = turn[0][0];
      if (!convId) convId = cid.slice(2);
      const last = turn[turn.length - 1];
      const ts = Array.isArray(last) && typeof last[0] === "number" ? last[0] : 0;
      items.push({ user: geminiTurnUser(turn), asst: geminiTurnAssistant(turn), ts });
    }
    items.sort((a, b) => a.ts - b.ts); // newest-first in payload → oldest-first
    // Gemini embeds generated images as placeholder tokens
    // (http://googleusercontent.com/image_generation_content/N); the real image is
    // fetched separately. We don't capture Gemini images yet, so strip the tokens
    // rather than leaking junk URLs into the transcript.
    const clean = (s) => String(s || "")
      .replace(/https?:\/\/googleusercontent\.com\/image_generation_content\/\d+/g, "")
      .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    const messages = [];
    for (const it of items) {
      const u = clean(it.user), a = clean(it.asst);
      if (u) messages.push({ role: "user", text: u, time: it.ts || null });
      if (a) messages.push({ role: "assistant", text: a, time: it.ts || null });
    }
    if (!messages.length) return null;
    return {
      id: convId || "gemini-" + Date.now(),
      platform: "gemini",
      title: titleFromMessages(messages) || "Untitled Gemini conversation",
      messages,
    };
  }

  function toMarkdown(conv) {
    const speaker = (role) => (role === "assistant" ? assistantName(conv.platform) : "You");
    let md = `# ${conv.title}\n\n_Platform: ${conv.platform}_\n\n`;
    for (const m of conv.messages) {
      md += `**${speaker(m.role)}:**\n\n${m.text}\n\n---\n\n`;
    }
    return md;
  }

  // --- Obsidian helpers -----------------------------------------------------
  // Normalize the assorted time shapes we store: ChatGPT gives epoch *seconds*
  // (float), Claude gives an ISO string, and capturedAt is epoch *ms*.
  function toDate(t) {
    if (t == null) return null;
    let d;
    if (typeof t === "number") d = new Date(t < 1e12 ? t * 1000 : t);
    else d = new Date(t);
    return isNaN(d.getTime()) ? null : d;
  }
  function isoDate(t) {
    const d = toDate(t);
    return d ? d.toISOString().slice(0, 10) : "";
  }
  function isoDateTime(t) {
    const d = toDate(t);
    return d ? d.toISOString().slice(0, 16).replace("T", " ") : "";
  }
  function earliestTime(conv) {
    for (const m of conv.messages || []) if (m.time != null) return m.time;
    return conv.capturedAt || null;
  }

  // Best-effort link back to the live conversation. Skip when the id is one of
  // our synthetic fallbacks (no real conversation id was present).
  function sourceUrl(conv) {
    const id = String(conv.id || "");
    if (conv.platform === "chatgpt" && !id.startsWith("chatgpt-"))
      return "https://chatgpt.com/c/" + id;
    if (conv.platform === "claude" && !id.startsWith("claude-"))
      return "https://claude.ai/chat/" + id;
    if (conv.platform === "gemini" && !id.startsWith("gemini-"))
      return "https://gemini.google.com/app/" + id;
    if (conv.platform === "perplexity" && !id.startsWith("perplexity-"))
      return "https://www.perplexity.ai/search/" + id;
    if (conv.platform === "deepseek" && !id.startsWith("deepseek-"))
      return "https://chat.deepseek.com/a/chat/s/" + id;
    return "";
  }

  function platformFolder(p) {
    return p === "claude" ? "Claude" : p === "chatgpt" ? "ChatGPT" : "Other";
  }

  // Strip characters illegal in file names across Windows/macOS/Linux, plus a
  // couple Obsidian treats specially in wikilinks (# ^ [ ]). Stable per title.
  function sanitizeName(name) {
    return (
      String(name)
        .replace(/[\\/:*?"<>|#^[\]]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80) || "Untitled"
    );
  }
  function shortId(conv) {
    return String(conv.id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "noid";
  }
  // Date-first naming (the common Obsidian convention: files sort chronologically
  // in the explorer). Uses the conversation's own date — the same one in the note's
  // `created:` frontmatter — falling back to capture date, then no prefix.
  function vaultFilename(conv) {
    const date = isoDate(earliestTime(conv));
    const prefix = date ? date + " " : "";
    return `${prefix}${sanitizeName(conv.title)} (${shortId(conv)}).md`;
  }

  // Map an image mime type to a file extension (for generated images, which have
  // no upload filename of their own).
  function extForMime(mime) {
    return { "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" }[mime] || ".png";
  }

  // Pull every image out of a raw ChatGPT conversation object (the /conversation/{id}
  // JSON). Images are parts with content_type "image_asset_pointer"; the file id is
  // the tail of the asset_pointer (sediment:// or file-service://). Uploaded images
  // carry a filename + mime in the owning message's metadata.attachments[] (matched
  // by id); generated images carry dalle/generation metadata and an image_gen_title.
  // Deduped by file id, in order of first appearance. Bytes are fetched later via
  // /backend-api/files/download/{id}?conversation_id=… → signed estuary URL.
  function chatGPTImageAssets(obj) {
    if (!obj || typeof obj !== "object") return [];
    const mapping = obj.mapping || (obj.conversation && obj.conversation.mapping);
    const raw = mapping
      ? Object.values(mapping)
      : collect(obj, (v) => v.author && v.content && typeof v.content === "object").map((message) => ({ message }));
    const nodes = raw
      .filter((n) => n && n.message && n.message.content && Array.isArray(n.message.content.parts))
      .sort((a, b) => (a.message.create_time || 0) - (b.message.create_time || 0));
    const seen = new Map();
    for (const n of nodes) {
      const m = n.message;
      const attById = {};
      for (const a of (m.metadata && m.metadata.attachments) || []) if (a && a.id) attById[a.id] = a;
      const genTitle = m.metadata && m.metadata.image_gen_title;
      for (const p of m.content.parts) {
        if (!p || typeof p !== "object" || p.content_type !== "image_asset_pointer") continue;
        const fileId = String(p.asset_pointer || "").replace(/^[a-z-]+:\/\//, "");
        if (!fileId || seen.has(fileId)) continue;
        const att = attById[fileId];
        let kind, mime, filename;
        if (att) {
          kind = "uploaded";
          mime = att.mime_type || "image/png";
          filename = att.name || fileId + extForMime(mime);
        } else {
          kind = "generated";
          mime = "image/png";
          filename = (genTitle ? sanitizeName(genTitle) : fileId) + extForMime(mime);
        }
        seen.set(fileId, {
          fileId, kind, mime, filename,
          width: p.width || null, height: p.height || null, sizeBytes: p.size_bytes || null,
          messageId: m.id,
        });
      }
    }
    return [...seen.values()];
  }

  function yamlString(s) {
    return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  }

  function toObsidianMarkdown(conv) {
    const created = isoDate(earliestTime(conv));
    const captured = isoDate(conv.capturedAt || null);
    const url = sourceUrl(conv);
    let fm = "---\n";
    fm += "title: " + yamlString(conv.title || "Untitled") + "\n";
    fm += "platform: " + (conv.platform || "unknown") + "\n";
    if (created) fm += "created: " + created + "\n";
    if (captured) fm += "captured: " + captured + "\n";
    if (url) fm += "source_url: " + url + "\n";
    fm += "message_count: " + (conv.messages ? conv.messages.length : 0) + "\n";
    // Base tags + the user's own tags (sanitized to Obsidian/YAML-safe tokens), deduped.
    const baseTags = ["ai", "ai/" + (conv.platform || "unknown")];
    const userTags = (conv.tags || [])
      .map((t) => String(t).replace(/^#/, "").trim().replace(/\s+/g, "-").replace(/[^a-zA-Z0-9/_-]/g, ""))
      .filter(Boolean);
    fm += "tags: [" + [...new Set([...baseTags, ...userTags])].join(", ") + "]\n";
    fm += "---\n\n";

    const speaker = (role) => (role === "assistant" ? "🤖 " + assistantName(conv.platform) : "🧑 You");
    // Vault paths for the images (must match what obsidian.js writeAssets writes).
    const paths = assetVaultPaths(conv, conv.images || []);
    const pathByFile = {};
    for (const p of paths) pathByFile[p.fileId] = p;
    // A gallery of all images up top, then each image inline at its own turn.
    let top = "";
    if (paths.length) {
      top = "## 🖼 Images\n\n" + paths.map((p) => `![${p.vaultName}](<${p.relPath}>)`).join("\n") + "\n\n";
    }
    let body = "";
    for (const m of conv.messages || []) {
      const ts = isoDateTime(m.time);
      body += `## ${speaker(m.role)}${ts ? " · " + ts : ""}\n\n`;
      if (m.text) body += `${String(m.text).trim()}\n\n`;
      for (const fid of m.images || []) {
        const p = pathByFile[fid];
        if (p) body += `![${p.vaultName}](<${p.relPath}>)\n\n`;
      }
    }
    return fm + top + body.trimEnd() + "\n";
  }

  // Stable vault paths for a conversation's image assets. Files live under
  // <root>/_attachments/<shortId>/, so a note at <root>/<Platform>/<title>.md
  // reaches them via "../_attachments/<shortId>/<name>". Filenames are sanitized and
  // de-duplicated within the conversation so two same-named images don't collide.
  function assetVaultPaths(conv, assets) {
    const sid = shortId(conv);
    const dir = "_attachments/" + sid;
    const used = new Set();
    const out = [];
    for (const a of assets || []) {
      let name = sanitizeName(a.filename || a.fileId || "image");
      if (!/\.[a-z0-9]{1,5}$/i.test(name)) name += extForMime(a.mime);
      const m = name.match(/^(.*?)(\.[a-z0-9]{1,5})?$/i);
      const base = m[1], ext = m[2] || "";
      let candidate = name, i = 2;
      while (used.has(candidate.toLowerCase())) { candidate = base + "-" + i + ext; i++; }
      used.add(candidate.toLowerCase());
      out.push({ ...a, vaultName: candidate, dir, relPath: "../" + dir + "/" + candidate });
    }
    return out;
  }

  // Markdown block embedding a conversation's images (appended to the note). Uses
  // angle-bracket relative links so filenames with spaces resolve in Obsidian.
  function attachmentsMarkdown(conv, assets) {
    const paths = assetVaultPaths(conv, assets);
    if (!paths.length) return "";
    let s = "## 🖼 Images\n\n";
    for (const a of paths) s += "![" + a.vaultName + "](<" + a.relPath + ">)\n\n";
    return s.trimEnd() + "\n";
  }

  // ChatGPT (Nov 2026) loads a conversation in pages (`?num_turns=10`), so one
  // capture can hold only the latest turns. Union the stored and captured messages
  // by id instead of replacing, so a partial payload never truncates the archive.
  // Captured copies win (they carry the latest text); order follows create time.
  function mergeMessages(prev, next) {
    if (!Array.isArray(prev) || !prev.length) return next;
    if (!Array.isArray(next) || ![...prev, ...next].every((m) => m && m.id)) return next;
    const byId = new Map(prev.map((m) => [m.id, m]));
    for (const m of next) byId.set(m.id, m);
    const all = [...byId.values()];
    if (all.every((m) => typeof m.time === "number")) {
      all.sort((a, b) => a.time - b.time);
    }
    return all;
  }

  const api = {
    mergeMessages,
    parseChatGPT,
    parseClaude,
    parseDeepSeek,
    parseGrok,
    parsePerplexity,
    parseGemini,
    toMarkdown,
    toObsidianMarkdown,
    vaultFilename,
    platformFolder,
    sourceUrl,
    assistantName,
    chatGPTImageAssets,
    geminiImageAssets,
    assetVaultPaths,
    attachmentsMarkdown,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.CAMParsers = api;
  }
})(typeof self !== "undefined" ? self : this);

// Anamne prompt picker — ISOLATED-world content script on ChatGPT/Claude.
// Renders a floating button + overlay inside a Shadow DOM (so the host page's CSS
// can't bleed in or out). Prompts are fetched from the service worker (content
// scripts can't read the extension's IndexedDB). On pick, any {{variables}} are
// filled in, then the result is inserted into the chat composer.
(function () {
  "use strict";
  if (window.__anamnePicker) return; // guard against double-injection
  window.__anamnePicker = true;

  const SVG_MARK =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="2.3" fill="currentColor" stroke="none"/><circle cx="5" cy="6" r="1.8" fill="currentColor" stroke="none"/><circle cx="19" cy="8" r="1.8" fill="currentColor" stroke="none"/><circle cx="16" cy="19" r="1.8" fill="currentColor" stroke="none"/><path d="M12 12 5 6M12 12l7-4M12 12l4 7"/></svg>';

  // ---- composer detection + insertion (browser-verified) ----
  function isEditable(el) {
    return !!el && (el.tagName === "TEXTAREA" || el.isContentEditable || el.getAttribute("contenteditable") === "true");
  }
  function findComposer() {
    const a = document.activeElement;
    if (isEditable(a) && !host.contains(a)) return a;
    return (
      document.querySelector("#prompt-textarea") ||
      document.querySelector('main div[contenteditable="true"]') ||
      document.querySelector('div[contenteditable="true"]') ||
      document.querySelector("main textarea") ||
      document.querySelector("textarea")
    );
  }
  function insertText(text) {
    const el = findComposer();
    if (!el) {
      navigator.clipboard && navigator.clipboard.writeText(text);
      return { ok: false, copied: true };
    }
    el.focus();
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const next = el.value.slice(0, start) + text + el.value.slice(end);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      setter ? setter.call(el, next) : (el.value = next);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      const caret = start + text.length;
      try { el.selectionStart = el.selectionEnd = caret; } catch (_) {}
      return { ok: true };
    }
    // contenteditable (ProseMirror / Lexical)
    let inserted = false;
    try { inserted = document.execCommand("insertText", false, text); } catch (_) {}
    if (!inserted) {
      el.appendChild(document.createTextNode(text));
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    return { ok: true };
  }

  // ---- shadow-DOM UI ----
  const host = document.createElement("div");
  host.id = "anamne-picker-host";
  (document.body || document.documentElement).appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host{ all: initial; }
      *{ box-sizing:border-box; font-family:-apple-system,"SF Pro Text",system-ui,sans-serif; }
      .fab{ position:fixed; right:20px; bottom:96px; z-index:2147483646; width:44px; height:44px; border-radius:50%;
        background:linear-gradient(135deg,#C2643B,#A84E2C); color:#fff; border:none; cursor:pointer;
        box-shadow:0 6px 20px -4px rgba(194,100,59,.6); display:grid; place-items:center; transition:transform .15s; }
      .fab:hover{ transform:translateY(-2px) scale(1.04); }
      .panel{ position:fixed; right:20px; bottom:150px; z-index:2147483647; width:340px; max-height:60vh;
        background:#fff; color:#1d1d1f; border:1px solid rgba(0,0,0,.1); border-radius:16px; overflow:hidden;
        box-shadow:0 12px 40px -8px rgba(0,0,0,.3); display:none; flex-direction:column; }
      .panel.open{ display:flex; }
      .hd{ padding:12px 14px; border-bottom:1px solid rgba(0,0,0,.07); display:flex; align-items:center; gap:8px; }
      .hd b{ font-size:14px; font-weight:650; flex:1; }
      .hd .x{ cursor:pointer; color:#86868b; font-size:18px; line-height:1; border:none; background:none; }
      .search{ margin:10px 14px 0; padding:8px 11px; border:1px solid rgba(0,0,0,.12); border-radius:9px; font-size:13px; width:calc(100% - 28px); }
      .search:focus{ outline:none; border-color:#C2643B; }
      .list{ overflow:auto; padding:8px 14px 14px; }
      .item{ padding:9px 11px; border:1px solid rgba(0,0,0,.07); border-radius:10px; margin-top:8px; cursor:pointer; background:#fbfbfd; }
      .item:hover{ border-color:#C2643B; background:#F6EEE6; }
      .item .t{ font-size:13.5px; font-weight:600; }
      .item .b{ font-size:12px; color:#6e6e73; margin-top:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .item .v{ font-size:10px; color:#C2643B; margin-top:4px; }
      .empty{ color:#86868b; font-size:13px; text-align:center; padding:22px 10px; }
      .empty a{ color:#C2643B; cursor:pointer; }
      .vform label{ display:block; font-size:12px; color:#6e6e73; margin:10px 0 4px; }
      .vform input{ width:100%; padding:8px 11px; border:1px solid rgba(0,0,0,.12); border-radius:9px; font-size:13px; }
      .vform input:focus{ outline:none; border-color:#C2643B; }
      .acts{ display:flex; gap:8px; padding:12px 14px; border-top:1px solid rgba(0,0,0,.07); }
      .btn{ flex:1; padding:9px; border-radius:9px; border:none; font-size:13px; font-weight:600; cursor:pointer; }
      .btn.p{ background:linear-gradient(135deg,#C2643B,#A84E2C); color:#fff; }
      .btn.s{ background:rgba(0,0,0,.06); color:#1d1d1f; }
      .toast{ position:fixed; right:20px; bottom:150px; z-index:2147483647; background:#1d1d1f; color:#fff; font-size:12.5px; padding:9px 13px; border-radius:9px; opacity:0; transition:opacity .2s; }
      .toast.show{ opacity:1; }
    </style>
    <button class="fab" title="Anamne prompts">${SVG_MARK}</button>
    <div class="panel" role="dialog" aria-label="Anamne prompts"></div>
    <div class="toast"></div>`;

  const fab = root.querySelector(".fab");
  const panel = root.querySelector(".panel");
  const toastEl = root.querySelector(".toast");
  let prompts = [];

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    setTimeout(() => toastEl.classList.remove("show"), 1800);
  }
  function fetchPrompts() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ from: "anamne-picker", action: "getPrompts" }, (resp) => {
          resolve(resp && resp.ok ? resp.prompts : []);
        });
      } catch (_) { resolve([]); }
    });
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

  async function openPanel() {
    prompts = await fetchPrompts();
    renderList("");
    panel.classList.add("open");
    const s = panel.querySelector(".search");
    if (s) s.focus();
  }
  function closePanel() { panel.classList.remove("open"); }

  function renderList(query) {
    const list = PromptLogic.filterPrompts(prompts, query);
    panel.innerHTML = `
      <div class="hd"><b>Prompt library</b><button class="x" title="Close">×</button></div>
      <input class="search" placeholder="Search prompts…" value="${esc(query)}" />
      <div class="list"></div>`;
    panel.querySelector(".x").onclick = closePanel;
    const search = panel.querySelector(".search");
    search.oninput = (e) => { const v = e.target.value; renderList(v); panel.querySelector(".search").focus(); };
    if (query) search.setSelectionRange(query.length, query.length);
    const listEl = panel.querySelector(".list");
    if (!list.length) {
      listEl.innerHTML = `<div class="empty">${prompts.length ? "No matches." : "No prompts yet.<br>Open the <a id='mgr'>prompt library</a> to add some."}</div>`;
      const mgr = listEl.querySelector("#mgr");
      if (mgr) mgr.onclick = () => chrome.runtime.sendMessage({ from: "anamne-picker", action: "openManager" });
      return;
    }
    listEl.innerHTML = list
      .map((p) => {
        const vars = PromptLogic.extractVariables(p.body);
        return `<div class="item" data-id="${esc(p.id)}">
          <div class="t">${esc(p.title || "Untitled")}</div>
          <div class="b">${esc(p.body)}</div>
          ${vars.length ? `<div class="v">${vars.length} variable${vars.length > 1 ? "s" : ""}</div>` : ""}
        </div>`;
      })
      .join("");
    listEl.querySelectorAll(".item").forEach((el) =>
      el.addEventListener("click", () => choose(list.find((p) => p.id === el.dataset.id)))
    );
  }

  function choose(p) {
    if (!p) return;
    const vars = PromptLogic.extractVariables(p.body);
    if (!vars.length) return finish(p, p.body);
    panel.innerHTML = `
      <div class="hd"><b>${esc(p.title || "Fill in")}</b><button class="x" title="Close">×</button></div>
      <div class="list vform">${vars
        .map((v, i) => `<label>${esc(v)}</label><input data-v="${esc(v)}" ${i === 0 ? "autofocus" : ""} />`)
        .join("")}</div>
      <div class="acts"><button class="btn s" id="back">← Back</button><button class="btn p" id="ins">Insert</button></div>`;
    panel.querySelector(".x").onclick = closePanel;
    panel.querySelector("#back").onclick = () => renderList("");
    const first = panel.querySelector("input[data-v]");
    if (first) first.focus();
    const doInsert = () => {
      const values = {};
      panel.querySelectorAll("input[data-v]").forEach((inp) => (values[inp.dataset.v] = inp.value));
      finish(p, PromptLogic.applyVariables(p.body, values));
    };
    panel.querySelector("#ins").onclick = doInsert;
    panel.querySelectorAll("input[data-v]").forEach((inp) =>
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") doInsert(); })
    );
  }

  function finish(p, text) {
    const r = insertText(text);
    try { chrome.runtime.sendMessage({ from: "anamne-picker", action: "recordUse", id: p.id }); } catch (_) {}
    closePanel();
    toast(r.ok ? "Inserted ✓" : r.copied ? "Copied (no input found)" : "Couldn't insert");
  }

  fab.addEventListener("click", () => (panel.classList.contains("open") ? closePanel() : openPanel()));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePanel(); });
})();

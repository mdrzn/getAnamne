// Prompt Library manager. Lists prompts from IndexedDB (db.js), provides search,
// and a create/edit/delete editor. Pure parsing/search comes from prompt-logic.js.
"use strict";

const state = { prompts: [], query: "", selectedId: null, editing: null };
const $ = (id) => document.getElementById(id);
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// Curated starter prompts — seeded once on first run so the library isn't empty
// and the {{variable}} feature is immediately discoverable.
const STARTERS = [
  { title: "Explain simply", body: "Explain {{topic}} to me like I'm a smart beginner. Use a concrete analogy and avoid jargon.", tags: ["learning"] },
  { title: "Code review", body: "Review the following code for bugs, edge cases, and readability. List issues by severity.\n\n{{code}}", tags: ["dev"] },
  { title: "Summarize", body: "Summarize the text below in {{n}} bullet points, keeping the key numbers and names.\n\n{{text}}", tags: ["writing"] },
  { title: "Rewrite tone", body: "Rewrite the following in a {{tone}} tone, same meaning, tighter:\n\n{{text}}", tags: ["writing"] },
  { title: "Pros & cons", body: "Give me an honest pros/cons table for: {{decision}}. End with a one-line recommendation.", tags: ["thinking"] },
];

async function seedIfFirstRun() {
  const seeded = await AnamneDB.kvGet("prompts_seeded");
  if (seeded) return;
  const existing = await AnamneDB.getAllPrompts();
  if (!existing.length) {
    const now = Date.now();
    for (let i = 0; i < STARTERS.length; i++) {
      await AnamneDB.putPrompt({
        id: crypto.randomUUID(), ...STARTERS[i], useCount: 0,
        createdAt: now, updatedAt: now - i, // preserve listed order initially
      });
    }
  }
  await AnamneDB.kvSet("prompts_seeded", true);
}

async function load() {
  state.prompts = await AnamneDB.getAllPrompts();
  renderList();
  if (state.editing) return; // keep editor open mid-edit
  const sel = state.prompts.find((p) => p.id === state.selectedId);
  sel ? renderView(sel) : renderEmpty();
}

function renderList() {
  const list = PromptLogic.filterPrompts(state.prompts, state.query);
  const el = $("list");
  if (!list.length) {
    el.innerHTML = `<div class="empty">${state.prompts.length ? "No matches." : "No prompts yet.<br>Click <b>+ New prompt</b> to create one."}</div>`;
    return;
  }
  el.innerHTML = list
    .map((p) => {
      const vars = PromptLogic.extractVariables(p.body);
      const tags = (p.tags || []).map((t) => `<span class="tag">#${esc(t)}</span>`).join("");
      return `<div class="item ${state.selectedId === p.id ? "sel" : ""}" data-id="${esc(p.id)}">
        <div class="t">${esc(p.title || "Untitled")}</div>
        <div class="b">${esc(p.body)}</div>
        <div class="m">${tags}${vars.length ? `<span class="vbadge">${vars.length} var${vars.length > 1 ? "s" : ""}</span>` : ""}${p.useCount ? `<span class="vbadge" style="color:var(--faint)">used ${p.useCount}×</span>` : ""}</div>
      </div>`;
    })
    .join("");
  el.querySelectorAll(".item").forEach((row) =>
    row.addEventListener("click", () => {
      state.selectedId = row.dataset.id;
      state.editing = null;
      renderList();
      renderView(state.prompts.find((p) => p.id === row.dataset.id));
    })
  );
}

function renderEmpty() {
  $("editor").innerHTML = `<div class="empty">Select a prompt, or create a new one.<br><br>
    Use <b>{{variables}}</b> in the body — Anamne will ask you to fill them in when you insert the prompt into a chat.</div>`;
}

function renderView(p) {
  if (!p) return renderEmpty();
  const vars = PromptLogic.extractVariables(p.body);
  $("editor").innerHTML = `
    <h2>${esc(p.title || "Untitled")}</h2>
    <div class="sub">${(p.tags || []).length ? (p.tags || []).map((t) => "#" + esc(t)).join(" ") : "no tags"}${p.useCount ? " · used " + p.useCount + "×" : ""}</div>
    <div class="field"><textarea readonly>${esc(p.body)}</textarea>
      ${vars.length ? `<div class="varchips">${vars.map((v) => `<span class="varchip">{{${esc(v)}}}</span>`).join("")}</div>` : `<div class="hint">No variables — inserts as-is.</div>`}
    </div>
    <div class="rowbtns"><button class="btn p" id="edit">Edit</button><button class="btn s" id="dup">Duplicate</button><span class="sp"></span><button class="btn d" id="del">Delete</button></div>`;
  $("edit").onclick = () => renderForm(p);
  $("dup").onclick = () => renderForm({ title: (p.title || "Untitled") + " copy", body: p.body, tags: p.tags || [] });
  $("del").onclick = async () => {
    if (!confirm(`Delete prompt "${p.title || "Untitled"}"?`)) return;
    await AnamneDB.deletePrompt(p.id);
    if (state.selectedId === p.id) state.selectedId = null;
    state.editing = null;
    await load();
    renderEmpty();
  };
}

function renderForm(p) {
  const editing = p || {};
  state.editing = editing.id || "new";
  $("editor").innerHTML = `
    <h2>${editing.id ? "Edit prompt" : "New prompt"}</h2>
    <div class="sub">Use <b>{{variable}}</b> placeholders for fill-in-the-blank prompts.</div>
    <div class="field"><label>Title</label><input id="f-title" value="${esc(editing.title || "")}" placeholder="e.g. Code review" /></div>
    <div class="field"><label>Prompt</label><textarea id="f-body" placeholder="Review this {{code}} and list bugs by severity.">${esc(editing.body || "")}</textarea>
      <div class="varchips" id="f-vars"></div></div>
    <div class="field"><label>Tags (comma-separated)</label><input id="f-tags" value="${esc((editing.tags || []).join(", "))}" placeholder="dev, writing" /></div>
    <div class="rowbtns"><button class="btn p" id="save">Save</button><button class="btn s" id="cancel">Cancel</button></div>`;
  const body = $("f-body");
  const refreshVars = () => {
    const vars = PromptLogic.extractVariables(body.value);
    $("f-vars").innerHTML = vars.length
      ? vars.map((v) => `<span class="varchip">{{${esc(v)}}}</span>`).join("")
      : `<span class="hint">No variables detected.</span>`;
  };
  body.oninput = refreshVars;
  refreshVars();
  $("f-title").focus();
  $("cancel").onclick = () => { state.editing = null; load(); };
  $("save").onclick = async () => {
    const title = $("f-title").value.trim();
    const bodyVal = body.value.trim();
    if (!bodyVal) { body.focus(); return; }
    const tags = $("f-tags").value.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    const rec = {
      id: editing.id || crypto.randomUUID(),
      title: title || "Untitled",
      body: bodyVal,
      tags,
      useCount: editing.useCount || 0,
      createdAt: editing.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    await AnamneDB.putPrompt(rec);
    state.selectedId = rec.id;
    state.editing = null;
    await load();
    renderView(rec);
  };
}

$("new").onclick = () => { state.selectedId = null; renderList(); renderForm(null); };
$("openArchive").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("archive.html") });
$("search").addEventListener("input", (e) => { state.query = e.target.value; renderList(); });

// --- export: download all prompts as a portable JSON file ---
$("export").onclick = () => {
  const data = {
    type: "anamne-prompts",
    version: 1,
    exportedAt: new Date().toISOString(),
    prompts: state.prompts.map((p) => ({ title: p.title, body: p.body, tags: p.tags || [] })),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "anamne-prompts.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

// --- import: merge prompts from a JSON file (skips exact title+body dupes) ---
$("import").onclick = () => $("importFile").click();
$("importFile").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  let parsed;
  try { parsed = JSON.parse(await file.text()); } catch (_) { alert("That file isn't valid JSON."); return; }
  const incoming = Array.isArray(parsed) ? parsed : parsed && parsed.prompts;
  if (!Array.isArray(incoming)) { alert("No prompts found in that file."); return; }
  const existing = new Set(state.prompts.map((p) => (p.title || "") + " " + (p.body || "")));
  let added = 0;
  const now = Date.now();
  for (const p of incoming) {
    const body = (p.body || "").trim();
    if (!body) continue;
    const key = (p.title || "Untitled") + " " + body;
    if (existing.has(key)) continue;
    existing.add(key);
    await AnamneDB.putPrompt({
      id: crypto.randomUUID(),
      title: (p.title || "Untitled").trim(),
      body,
      tags: Array.isArray(p.tags) ? p.tags.map((t) => String(t).toLowerCase()) : [],
      useCount: 0, createdAt: now, updatedAt: now,
    });
    added++;
  }
  await load();
  alert(added ? `Imported ${added} prompt${added === 1 ? "" : "s"}.` : "Nothing new to import (all duplicates).");
});

(async () => { await seedIfFirstRun(); await load(); })();

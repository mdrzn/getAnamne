"use strict";
const SEEN_KEY = "cam_seen";
const main = document.getElementById("main");
let tab = "convs";

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function openArchive() {
  chrome.tabs.create({ url: chrome.runtime.getURL("archive.html") });
}
function openPrompts() {
  chrome.tabs.create({ url: chrome.runtime.getURL("prompts.html") });
}

async function render() {
  if (tab === "convs") return renderConvs(await AnamneDB.getAllConversations());
  if (tab === "report") return renderReport(await AnamneDB.getAllConversations());
  const store = await chrome.storage.local.get(SEEN_KEY);
  return renderDebug(store[SEEN_KEY] || []);
}

// Monochrome icon for the sync header (emoji render full-color and clash with the
// terracotta tile; inline SVG stays crisp and on-brand).
const ICO_OBS = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 2.5l7.5 4.5v9L12 21.5 4.5 16V7z"/></svg>';

// Short relative timestamp for the compact conversation list ("2m ago", "3h ago").
function relTime(ts) {
  if (!ts) return "";
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60); if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24); if (d < 7) return d + "d ago";
  return new Date(ts).toLocaleDateString();
}

// The Obsidian sync header. It states its own status so "synced" is never ambiguous
// and carries the "Sync N new" action. `pendingCount` = conversations not yet in vault.
function syncRowsHtml(handle, pendingCount) {
  let obs;
  if (!Obsidian.supported()) {
    obs = `<div class="srow"><div class="ico obs">${ICO_OBS}</div><span class="nm">Obsidian</span>
      <span class="st">needs a Chromium browser</span></div>`;
  } else if (!handle) {
    obs = `<div class="srow"><div class="ico obs">${ICO_OBS}</div><span class="nm">Obsidian</span>
      <span class="st">not connected</span>
      <span class="act"><button class="primary" id="pickVault">Choose folder</button></span></div>`;
  } else if (pendingCount) {
    obs = `<div class="srow"><div class="ico obs">${ICO_OBS}</div><span class="nm">Obsidian</span>
      <span class="st"><b>${esc(handle.name)}</b> · ${pendingCount} to sync</span>
      <span class="act"><button class="primary" id="syncAll">Sync ${pendingCount} new</button></span></div>`;
  } else {
    obs = `<div class="srow"><div class="ico obs">${ICO_OBS}</div><span class="nm">Obsidian</span>
      <span class="st"><b>${esc(handle.name)}</b> · <span class="ok">all synced</span></span>
      <span class="act"><button id="changeVault">Change</button></span></div>`;
  }

  return `<div class="sync2">${obs}</div>`;
}

function setStatus(msg, kind) {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "status" + (kind ? " " + kind : "");
}

async function renderConvs(list) {
  list = (list || []).sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0));
  const byId = new Map(list.map((c) => [c.id, c]));
  const handle = Obsidian.supported() ? await Obsidian.getVaultHandle() : null;
  const idx = await Obsidian.getSyncIndex();
  const pendingCount = list.filter((c) => !Obsidian.isSynced(idx, c)).length;
  // Obsidian writes are button-only (Chrome ties folder writes to a fresh user
  // gesture; a silent write on popup open isn't possible, and the page-origin
  // picker can't reach the vault handle).
  const syncRows = syncRowsHtml(handle, pendingCount);
  const foot = `<div class="footlinks">
    <a id="openPrompts">Prompt library</a>
    ${list.length ? `<a id="clearAll" class="danger">Clear all</a>` : ""}
    <a id="openDiag">Diagnostics</a>
    <a id="openReport">Report a problem</a>
  </div>`;

  if (!list.length) {
    main.innerHTML =
      syncRows +
      `<div class="empty">No conversations captured yet.<br><br>
      Open or refresh a chat on ChatGPT, Claude, Gemini, Perplexity, Grok or DeepSeek, then reopen this popup.</div>` +
      foot;
    wireVaultBar();
    wireFooter();
    return;
  }
  // Launcher view: the few most recent captures (instant "it's working"
  // confirmation); browsing lives in the full-page archive.
  const recent = list.slice(0, 3);
  main.innerHTML =
    syncRows +
    `<div class="status" id="status"></div>` +
    `<div class="sechd"><span class="l">Recently captured</span><a id="openArchive2">Open archive (${list.length}) →</a></div>` +
    recent
      .map((c) => `<div class="row" data-id="${esc(c.id)}">
        <div class="t"><span class="title">${esc(c.title)}</span><span class="pill ${esc(c.platform)}">${esc(c.platform)}</span><span class="time">${relTime(c.capturedAt)}</span></div>
      </div>`)
      .join("") +
    foot;
  const oa = document.getElementById("openArchive2");
  if (oa) oa.onclick = openArchive;
  main.querySelectorAll(".row").forEach((r) =>
    r.addEventListener("click", () => viewConv(byId.get(r.dataset.id)))
  );
  wireVaultBar(list);
  wireFooter();
}

// Footer text links: Prompt library, Clear all (confirm), Diagnostics.
function wireFooter() {
  const p = document.getElementById("openPrompts");
  if (p) p.onclick = openPrompts;
  const d = document.getElementById("openDiag");
  if (d) d.onclick = () => { tab = "debug"; render(); };
  const r = document.getElementById("openReport");
  if (r) r.onclick = () => { tab = "report"; render(); };
  const c = document.getElementById("clearAll");
  if (c) c.onclick = async () => {
    if (!confirm("Remove all conversations from this device? Files already written to your Obsidian folder stay where they are.")) return;
    await AnamneDB.clearConversations();
    chrome.action.setBadgeText({ text: "" });
    render();
  };
}

function wireVaultBar(convs) {
  const pick = document.getElementById("pickVault");
  if (pick)
    pick.onclick = async () => {
      try {
        await Obsidian.pickVaultFolder();
        render();
      } catch (e) {
        if (e && e.name !== "AbortError") setStatus("Couldn't open folder: " + e.message, "bad");
      }
    };
  const change = document.getElementById("changeVault");
  if (change)
    change.onclick = async () => {
      try {
        await Obsidian.pickVaultFolder();
        render();
      } catch (e) {
        if (e && e.name !== "AbortError") setStatus("Couldn't change folder: " + e.message, "bad");
      }
    };
  const syncAll = document.getElementById("syncAll");
  if (syncAll && convs)
    syncAll.onclick = async () => {
      setStatus("Syncing…");
      try {
        const r = await Obsidian.syncAllNew(convs);
        if (r.errors.length)
          setStatus(`Synced ${r.written}/${r.total}, ${r.errors.length} failed.`, "bad");
        else setStatus(`Synced ${r.written} conversation${r.written === 1 ? "" : "s"} to your vault.`, "ok");
        render();
      } catch (e) {
        setStatus(e.message, "bad");
      }
    };
}

function viewConv(c) {
  const md = c.rawStream
    ? `# ${c.title}\n\n_Raw streamed payload (first 50k chars) — for inspection:_\n\n${c.rawStream}`
    : CAMParsers.toMarkdown(c);
  main.innerHTML = `
    <span class="back" id="back">← back</span>
    <div class="btns">
      <button class="primary" id="obsidian">Sync to Obsidian</button>
      <button id="dl">Export .md</button>
      <button id="copy">Copy Markdown</button>
    </div>
    <div class="status" id="status"></div>
    <pre>${esc(md)}</pre>`;
  document.getElementById("back").onclick = render;
  document.getElementById("copy").onclick = () => navigator.clipboard.writeText(md);
  document.getElementById("dl").onclick = () => {
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (c.title || "conversation").replace(/[^\w-]+/g, "_").slice(0, 60) + ".md";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  document.getElementById("obsidian").onclick = async () => {
    setStatus("Syncing…");
    try {
      const r = await Obsidian.syncOne(c);
      setStatus("Written to " + r.path, "ok");
    } catch (e) {
      setStatus(e.message, "bad");
    }
  };
}

function backToConvsLink() {
  return `<span class="back" id="toConvs">← Back to conversations</span>`;
}
function wireBackToConvs() {
  const b = document.getElementById("toConvs");
  if (b) b.onclick = () => { tab = "convs"; render(); };
}
function renderDebug(seen) {
  if (!seen.length) {
    main.innerHTML = backToConvsLink() + `<div class="empty">Nothing captured yet.<br><br>
      Open a chat on a supported site, then reopen this.</div>`;
    wireBackToConvs();
    return;
  }
  const matched = seen.filter((s) => s.matched).length;
  main.innerHTML =
    backToConvsLink() +
    `<div class="hint">If capture isn't working, copy this log and send it to <b>hello@getanamne.com</b> — it shows which requests the page made (<b>${matched}</b> matched) so we can fix it fast.</div>
     <div class="btns"><button class="primary" id="copylog">Copy log</button><button id="clearlog">Clear</button>${self.ANAMNE_CONFIG && self.ANAMNE_CONFIG.DEV ? `<button id="copygemini">Copy last Gemini body</button><button id="copychatgpt">Copy last ChatGPT body</button>` : ""}</div>` +
    seen
      .map(
        (s) => `<div class="seen">
          <span class="${s.matched ? "ok" : "no"}">${s.matched ? "✓ " + (s.platform || "") : "—"}</span>
          <span class="u">${esc(s.url)}</span>
          <span class="no">${esc((s.ctype || "").split(";")[0])}</span>
        </div>`
      )
      .join("");
  document.getElementById("copylog").onclick = () =>
    navigator.clipboard.writeText(seen.map((s) => `${s.matched ? "MATCH" : "     "} ${s.url} [${s.ctype}]`).join("\n"));
  document.getElementById("clearlog").onclick = async () => {
    await chrome.storage.local.set({ [SEEN_KEY]: [] });
    render();
  };
  const copyBody = (platform, btnId) => {
    const b = document.getElementById(btnId);
    if (!b) return;
    b.onclick = async () => {
      const k = "cam_lastbody_" + platform;
      const s = await chrome.storage.local.get(k);
      if (!s[k]) { b.textContent = "none captured yet"; return; }
      await navigator.clipboard.writeText(s[k]);
      b.textContent = "Copied " + Math.round(s[k].length / 1024) + "KB ✓";
      setTimeout(() => (b.textContent = "Copy last " + platform + " body"), 1500);
    };
  };
  copyBody("gemini", "copygemini");
  copyBody("chatgpt", "copychatgpt");
  wireBackToConvs();
}

// "Report a problem": a short, fixed-choice report sent to the developer only when
// the user clicks Send. No conversation content and no request log is included.
const REPORT_URL = "https://getanamne.com/report.php";
const REPORT_SITES = { ChatGPT: "chatgpt", Claude: "claude", Gemini: "gemini", Perplexity: "perplexity", Grok: "grok", DeepSeek: "deepseek", "All sites": null };
const REPORT_PROBLEMS = ["Conversations aren't saved", "Some messages are missing", "Images aren't saved", "Obsidian sync doesn't work", "Something else"];

function browserLabel() {
  const ua = navigator.userAgent;
  const m = ua.match(/(Edg|OPR|Chrome)\/(\d+)/);
  const name = m ? { Edg: "Edge", OPR: "Opera", Chrome: "Chrome" }[m[1]] + " " + m[2] : "Unknown browser";
  const os = /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? name + " · " + os : name;
}

function renderReport(list) {
  const lastSaved = (site) => {
    const key = REPORT_SITES[site];
    const ts = Math.max(0, ...list.filter((c) => !key || c.platform === key).map((c) => c.capturedAt || 0));
    return ts ? new Date(ts).toISOString().slice(0, 10) : "never";
  };
  const opts = (xs) => xs.map((x) => `<option>${esc(x)}</option>`).join("");
  main.innerHTML =
    backToConvsLink() +
    `<form class="report" id="reportForm">
      <label>Site<select id="rSite">${opts(Object.keys(REPORT_SITES))}</select></label>
      <label>Problem<select id="rProblem">${opts(REPORT_PROBLEMS)}</select></label>
      <label>Details <span class="opt">(optional)</span><textarea id="rNote" maxlength="600" rows="3" placeholder="What did you expect, and what happened?"></textarea></label>
      <label>Your email <span class="opt">(optional, if you'd like a reply)</span><input id="rEmail" type="email" maxlength="120"></label>
      <div class="hint" id="rAlso"></div>
      <div class="btns"><button class="primary" id="rSend" type="submit">Send report</button></div>
      <div class="status" id="status"></div>
    </form>`;
  const site = document.getElementById("rSite");
  const also = () => {
    document.getElementById("rAlso").textContent =
      `Also sent: Anamne v${chrome.runtime.getManifest().version}, ${browserLabel()}, last save from ${site.value}: ${lastSaved(site.value)}. ` +
      `Nothing from your conversations is included.`;
  };
  site.onchange = also;
  also();
  document.getElementById("reportForm").onsubmit = async (e) => {
    e.preventDefault();
    const send = document.getElementById("rSend");
    send.disabled = true;
    setStatus("Sending…");
    try {
      const resp = await fetch(REPORT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          site: site.value,
          problem: document.getElementById("rProblem").value,
          note: document.getElementById("rNote").value,
          email: document.getElementById("rEmail").value,
          version: chrome.runtime.getManifest().version,
          browser: browserLabel(),
          lastSaved: lastSaved(site.value),
        }),
      });
      if (resp.ok) {
        main.innerHTML = backToConvsLink() + `<div class="empty"><b>Thanks, report sent.</b><br>I'll look into it.</div>`;
        wireBackToConvs();
        return;
      }
      setStatus(resp.status === 429 ? "Too many reports right now. Try again later." : "Couldn't send the report. Try again later.", "bad");
    } catch (_) {
      setStatus("Couldn't send the report. Check your connection.", "bad");
    }
    send.disabled = false;
  };
  wireBackToConvs();
}

// Version label — read from the manifest so it can never drift from the real build.
(function showVersion() {
  const el = document.getElementById("verTag");
  if (el) el.textContent = "v" + chrome.runtime.getManifest().version;
})();

// Theme toggle. The head script already set data-theme (saved choice or OS default);
// this wires the header button to flip + persist it. The choice is shared across all
// extension pages via localStorage (same origin), so the archive/prompts pages follow it.
(function initThemeToggle() {
  const ICON_MOON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`;
  const ICON_SUN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;
  const btn = document.getElementById("themebtn");
  if (!btn) return;
  const isDark = () => document.documentElement.getAttribute("data-theme") === "dark";
  const paint = () => {
    btn.innerHTML = isDark() ? ICON_SUN : ICON_MOON; // show what a click switches TO
    btn.title = isDark() ? "Switch to light mode" : "Switch to dark mode";
  };
  btn.addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("anamne-theme", next); } catch (e) {}
    paint();
  });
  paint();
})();

render();

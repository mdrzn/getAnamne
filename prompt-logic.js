// Pure, testable logic for the prompt library: {{variable}} parsing/substitution
// and prompt search. Shared by the manager page, the in-page picker, and the Node
// tests. No DOM or IndexedDB here.
(function (root) {
  "use strict";
  const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;

  // Ordered, de-duplicated list of variable names in a prompt body.
  function extractVariables(body) {
    const seen = new Set();
    const out = [];
    let m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(String(body || ""))) !== null) {
      const name = m[1].trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
    return out;
  }

  // Replace every {{name}} with values[name] (missing → empty string).
  function applyVariables(body, values) {
    values = values || {};
    return String(body || "").replace(TOKEN, (_, raw) => {
      const name = raw.trim();
      const v = values[name];
      return v == null ? "" : String(v);
    });
  }

  // Search title + body + tags (AND across whitespace tokens, case-insensitive).
  // Ordered most-used first, then most-recently-updated.
  function filterPrompts(prompts, query) {
    const tokens = query ? String(query).toLowerCase().split(/\s+/).filter(Boolean) : [];
    const out = (prompts || []).filter((p) => {
      if (!tokens.length) return true;
      const hay = [p.title || "", p.body || "", (p.tags || []).join(" ")].join("\n").toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
    out.sort((a, b) => (b.useCount || 0) - (a.useCount || 0) || (b.updatedAt || 0) - (a.updatedAt || 0));
    return out;
  }

  const api = { extractVariables, applyVariables, filterPrompts };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PromptLogic = api;
})(typeof self !== "undefined" ? self : this);

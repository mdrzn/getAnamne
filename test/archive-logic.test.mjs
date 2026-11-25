import { createRequire } from "module";
import assert from "assert";
const require = createRequire(import.meta.url);
const {
  buildFolderTree,
  descendantFolderIds,
  filterConversations,
  allTags,
  snippet,
} = require("../archive-logic.js");

let pass = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ✓", name); }
  catch (e) { console.error("  ✗", name, "\n   ", e.message); process.exitCode = 1; }
};

const folders = [
  { id: "a", name: "Work", parentId: null },
  { id: "b", name: "Clients", parentId: "a" },
  { id: "c", name: "Personal", parentId: null },
  { id: "d", name: "Acme", parentId: "b" },
];

// --- buildFolderTree ---
ok("buildFolderTree: nests children and sorts each level alphabetically", () => {
  const tree = buildFolderTree(folders);
  assert.equal(tree.length, 2);
  assert.equal(tree[0].name, "Personal"); // P < W, case-insensitive sort
  assert.equal(tree[1].name, "Work");
  assert.equal(tree[1].children.length, 1);
  assert.equal(tree[1].children[0].name, "Clients");
  assert.equal(tree[1].children[0].children[0].name, "Acme");
  assert.deepEqual(tree[0].children, []);
});

ok("buildFolderTree: treats a folder with a missing parent as a root", () => {
  const tree = buildFolderTree([{ id: "x", name: "Orphan", parentId: "ghost" }]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].name, "Orphan");
});

// --- descendantFolderIds ---
ok("descendantFolderIds: includes the folder itself plus all nested descendants", () => {
  const ids = descendantFolderIds(folders, "a").sort();
  assert.deepEqual(ids, ["a", "b", "d"]);
});

ok("descendantFolderIds: leaf folder returns just itself", () => {
  assert.deepEqual(descendantFolderIds(folders, "d"), ["d"]);
});

// --- filterConversations ---
const convs = [
  { id: "1", platform: "claude", title: "Database schema design", capturedAt: 30,
    folderId: "a", tags: ["work"], messages: [{ role: "user", text: "Help me design a schema" }] },
  { id: "2", platform: "chatgpt", title: "Dinner recipe", capturedAt: 20,
    folderId: null, tags: ["cooking"], messages: [{ role: "assistant", text: "Try a risotto tonight" }] },
  { id: "3", platform: "claude", title: "Schema migration plan", capturedAt: 10,
    folderId: "b", tags: ["work", "db"], messages: [{ role: "user", text: "How do I migrate the database safely" }] },
];

ok("filterConversations: empty opts returns all, sorted by capturedAt desc", () => {
  const r = filterConversations(convs, {});
  assert.deepEqual(r.map((c) => c.id), ["1", "2", "3"]);
});

ok("filterConversations: single query token matches title or message body", () => {
  const r = filterConversations(convs, { query: "risotto" });
  assert.deepEqual(r.map((c) => c.id), ["2"]);
});

ok("filterConversations: multi-token query is AND-matched across haystack", () => {
  const r = filterConversations(convs, { query: "migrate database" });
  assert.deepEqual(r.map((c) => c.id), ["3"]);
});

ok("filterConversations: query is case-insensitive and searches tags", () => {
  const r = filterConversations(convs, { query: "COOKING" });
  assert.deepEqual(r.map((c) => c.id), ["2"]);
});

ok("filterConversations: platform filter", () => {
  const r = filterConversations(convs, { platform: "claude" });
  assert.deepEqual(r.map((c) => c.id), ["1", "3"]);
});

ok("filterConversations: folderIds filter (folder + subfolders)", () => {
  const r = filterConversations(convs, { folderIds: descendantFolderIds(folders, "a") });
  assert.deepEqual(r.map((c) => c.id).sort(), ["1", "3"]);
});

ok("filterConversations: folderIds including null matches unfiled conversations", () => {
  const r = filterConversations(convs, { folderIds: [null] });
  assert.deepEqual(r.map((c) => c.id), ["2"]);
});

ok("filterConversations: tag filter", () => {
  const r = filterConversations(convs, { tag: "db" });
  assert.deepEqual(r.map((c) => c.id), ["3"]);
});

ok("filterConversations: combined query + platform + tag", () => {
  const r = filterConversations(convs, { query: "schema", platform: "claude", tag: "work" });
  assert.deepEqual(r.map((c) => c.id), ["1", "3"]);
});

// --- allTags ---
ok("allTags: unique tags with counts, sorted alphabetically", () => {
  assert.deepEqual(allTags(convs), [
    { tag: "cooking", count: 1 },
    { tag: "db", count: 1 },
    { tag: "work", count: 2 },
  ]);
});

// --- snippet ---
ok("snippet: returns an excerpt around the query match", () => {
  const s = snippet(convs[1], "risotto", 120);
  assert.ok(s.toLowerCase().includes("risotto"));
});

ok("snippet: no query returns the start of the body, whitespace-collapsed", () => {
  const c = { messages: [{ text: "line one\n\nline   two" }] };
  assert.equal(snippet(c, "", 120), "line one line two");
});

ok("snippet: long body is truncated with an ellipsis", () => {
  const c = { messages: [{ text: "x".repeat(300) }] };
  const s = snippet(c, "", 120);
  assert.ok(s.length <= 121 && s.endsWith("…"));
});

console.log(`\n${pass} checks passed.`);

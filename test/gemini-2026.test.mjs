import { createRequire } from "module";
import assert from "assert";
const require = createRequire(import.meta.url);
const P = require("../parsers.js");
const { geminiChatId, geminiReadRequest } = require("../platforms.js");

let pass = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ✓", name); }
  catch (e) { console.error("  ✗", name, "\n   ", e.message); process.exitCode = 1; }
};

// Shape of a real hNvQHb response (Nov 2026), text replaced: the turn timestamp is
// now turn[4] and the turn ends with a request UUID instead of the timestamp.
const turn = (rid, rcid, user, asst, sec) => [["c_0aa18f36f9e19c35", rid], null,
  [[user, null, null, null, []], 1, null, 0, "56fdd199312815e2", null, null, null, null, null, []],
  [[[rcid, [asst], null, null, null, null, null, null, [2], "en"]], null, "56fdd199312815e2"],
  [sec, 623075000], null, null, null, "DB16030C-B141-4115-8597-0B4D1DA2C606"];
const envelope = (turns) => ")]}'\n\n59869\n" +
  JSON.stringify([["wrb.fr", "hNvQHb", JSON.stringify([turns, null, null, []]), null, null, null, "generic"]]) +
  "\n56\n" + JSON.stringify([["di", 296]]);

ok("Nov 2026 shape: turns come out oldest first, with times", () => {
  const c = P.parseGemini(envelope([
    turn("r_2", "rc_2", "And the map page?", "Here is the map page.", 1786537300),
    turn("r_1", "rc_1", "Redesign my site", "Here is a redesign.", 1786537128),
  ]));
  assert.deepEqual(c.messages.map((m) => m.text), ["Redesign my site", "Here is a redesign.", "And the map page?", "Here is the map page."]);
  assert.equal(c.messages[0].time, 1786537128);
  assert.equal(c.id, "0aa18f36f9e19c35");
});

ok("messages carry stable ids so partial loads can be merged", () => {
  const c = P.parseGemini(envelope([turn("r_1", "rc_1", "Q", "A", 1786537128)]));
  assert.deepEqual(c.messages.map((m) => m.id), ["r_1:user", "rc_1"]);
});

ok("a 10-turn reload never deletes older stored turns", () => {
  const older = P.parseGemini(envelope([turn("r_2", "rc_2", "Q2", "A2", 200), turn("r_1", "rc_1", "Q1", "A1", 100)])).messages;
  const latest = P.parseGemini(envelope([turn("r_3", "rc_3", "Q3", "A3", 300), turn("r_2", "rc_2", "Q2", "A2 edited", 200)])).messages;
  const merged = P.mergeMessages(older, latest);
  assert.deepEqual(merged.map((m) => m.text), ["Q1", "A1", "Q2", "A2 edited", "Q3", "A3"]);
});

ok("conversation id from the Gemini page path", () => {
  assert.equal(geminiChatId("/app/0aa18f36f9e19c35"), "0aa18f36f9e19c35");
  assert.equal(geminiChatId("/u/1/app/0aa18f36f9e19c35"), "0aa18f36f9e19c35");
  assert.equal(geminiChatId("/app"), null);
  assert.equal(geminiChatId("/gem/abc"), null);
});

ok("hNvQHb request matches what gemini.google.com sends", () => {
  const r = geminiReadRequest({ id: "0aa18f36f9e19c35", at: "AFk0:123", bl: "boq_x", sid: "-305", hl: "en", reqid: 4169230, prefix: "" });
  assert.equal(r.url, "/_/BardChatUi/data/batchexecute?rpcids=hNvQHb&source-path=%2Fapp%2F0aa18f36f9e19c35&bl=boq_x&f.sid=-305&hl=en&_reqid=4169230&rt=c");
  assert.equal(decodeURIComponent(r.body),
    'f.req=[[["hNvQHb","[\\"c_0aa18f36f9e19c35\\",10,null,1,[1],[4,12],null,1]",null,"generic"]]]&at=AFk0:123&');
  assert.ok(geminiReadRequest({ id: "x", at: "a", bl: "b", sid: "s", hl: "en", reqid: 1, prefix: "/u/1" }).url.startsWith("/u/1/_/BardChatUi/"));
});

console.log(`\n${pass} checks passed.`);

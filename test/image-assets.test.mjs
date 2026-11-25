import { createRequire } from "module";
import assert from "assert";
const require = createRequire(import.meta.url);
const P = require("../parsers.js");

let pass = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log("  ✓", name); } catch (e) { console.error("  ✗", name, "\n   ", e.message); process.exitCode = 1; } };

// Trimmed but structurally-real ChatGPT conversation (from a live capture): a user
// turn with two uploaded images (+ attachments metadata), and a tool turn with a
// generated image (dalle/generation metadata + image_gen_title), repeated to test dedup.
const CONV = {
  conversation_id: "conv-123",
  mapping: {
    u1: { id: "u1", parent: "root", children: ["t1"], message: {
      id: "u1", author: { role: "user" }, create_time: 100,
      content: { content_type: "multimodal_text", parts: [
        { content_type: "image_asset_pointer", asset_pointer: "sediment://file_AAA", size_bytes: 1486050, width: 1278, height: 829, metadata: { dalle: null, generation: null, sanitized: true } },
        { content_type: "image_asset_pointer", asset_pointer: "file-service://file_BBB", size_bytes: 1139960, width: 2000, height: 1000, metadata: { sanitized: true } },
        "put these two people on that sofa",
      ] },
      metadata: { attachments: [
        { id: "file_AAA", size: 1486050, name: "photo-1.png", mime_type: "image/png", source: "local" },
        { id: "file_BBB", size: 1139960, name: "Team photo.png", mime_type: "image/png", source: "local" },
      ] },
    } },
    t1: { id: "t1", parent: "u1", children: ["t2"], message: {
      id: "t1", author: { role: "tool", name: "t2uay3k.sj1i4kz" }, create_time: 200,
      content: { content_type: "multimodal_text", parts: [
        { content_type: "image_asset_pointer", asset_pointer: "sediment://file_GEN", size_bytes: 2712763, width: 1558, height: 1010, metadata: { dalle: { gen_id: "x" }, generation: { gen_id: "x" } } },
      ] },
      metadata: { image_gen_title: "Minimal office with two people" },
    } },
    t2: { id: "t2", parent: "t1", children: [], message: {
      id: "t2", author: { role: "tool", name: "t2uay3k.sj1i4kz" }, create_time: 300,
      content: { content_type: "multimodal_text", parts: [
        { content_type: "image_asset_pointer", asset_pointer: "sediment://file_GEN", size_bytes: 2712763, width: 1558, height: 1010, metadata: { dalle: { gen_id: "x" }, generation: { gen_id: "x" } } },
      ] },
      metadata: { image_gen_title: "Minimal office with two people" },
    } },
  },
};

ok("extracts every unique image asset, deduped by file id", () => {
  const a = P.chatGPTImageAssets(CONV);
  assert.deepEqual(a.map((x) => x.fileId).sort(), ["file_AAA", "file_BBB", "file_GEN"]);
});

ok("strips both sediment:// and file-service:// prefixes", () => {
  const a = P.chatGPTImageAssets(CONV);
  assert.ok(a.find((x) => x.fileId === "file_BBB")); // came from file-service://
});

ok("uploaded images use the attachment name + mime", () => {
  const a = P.chatGPTImageAssets(CONV);
  const up = a.find((x) => x.fileId === "file_BBB");
  assert.equal(up.kind, "uploaded");
  assert.equal(up.mime, "image/png");
  assert.equal(up.filename, "Team photo.png");
});

ok("generated images are tagged generated, named from image_gen_title, default png", () => {
  const a = P.chatGPTImageAssets(CONV);
  const g = a.find((x) => x.fileId === "file_GEN");
  assert.equal(g.kind, "generated");
  assert.equal(g.mime, "image/png");
  assert.ok(/Minimal office/.test(g.filename));
  assert.ok(/\.png$/.test(g.filename));
});

ok("carries dimensions + size and the source message id", () => {
  const a = P.chatGPTImageAssets(CONV);
  const up = a.find((x) => x.fileId === "file_AAA");
  assert.equal(up.width, 1278); assert.equal(up.height, 829);
  assert.equal(up.sizeBytes, 1486050);
  assert.equal(up.messageId, "u1");
});

ok("returns [] for a conversation with no images", () => {
  assert.deepEqual(P.chatGPTImageAssets({ mapping: { x: { message: { id: "x", author: { role: "user" }, content: { content_type: "text", parts: ["hi"] } } } } }), []);
});


// Regression: real ChatGPT payload shape captured 2026-08 (verified against a live
// conversation). Generated images arrive as tool messages with content_type
// "multimodal_text"; uploads come on the user message with metadata.attachments.
// Locks the `sediment://` pointer + both kinds so a future format drift is caught.
ok("2026-08 live shape: finds generated (tool msg) + uploaded (user msg) images", () => {
  const conv = { mapping: {
    t1: { id: "t1", message: { id: "t1", author: { role: "tool", name: "t2uay3k.sj1i4kz" }, create_time: 1784000000,
      content: { content_type: "multimodal_text", parts: [
        { content_type: "image_asset_pointer", asset_pointer: "sediment://file_00000000aaaa40008000aaaaaaaaaaaa",
          mime_type: "image/png", size_bytes: 2521563, width: 1122, height: 1402,
          metadata: { dalle: { gen_id: "adcc" }, generation: { gen_id: "adcc" } } } ] },
      metadata: { image_gen_title: "Caf\u00e9 terrace in the rain" }, recipient: "all", channel: "final" } },
    u2: { id: "u2", message: { id: "u2", author: { role: "user" }, create_time: 1785000000,
      content: { content_type: "multimodal_text", parts: [
        { content_type: "image_asset_pointer", asset_pointer: "sediment://file_00000000bbbb40008000bbbbbbbbbbbb",
          mime_type: "image/png", size_bytes: 50277, width: 511, height: 88, metadata: { dalle: null, generation: null } },
        "make a good-morning card with today's forecast" ] },
      metadata: { attachments: [{ name: "forecast.png", id: "file_00000000bbbb40008000bbbbbbbbbbbb", size: 50277, mime_type: "image/png" }] },
      recipient: "all", channel: null } },
  } };
  const a = P.chatGPTImageAssets(conv);
  assert.equal(a.length, 2, "both images found");
  const gen = a.find((x) => x.kind === "generated");
  const up = a.find((x) => x.kind === "uploaded");
  assert.ok(gen && gen.fileId === "file_00000000aaaa40008000aaaaaaaaaaaa", "generated file id from sediment:// pointer");
  assert.equal(gen.filename, "Caf\u00e9 terrace in the rain.png", "generated uses image_gen_title");
  assert.ok(up && up.filename === "forecast.png", "uploaded uses the attachment name");
});

console.log(`\n${pass} checks passed.`);

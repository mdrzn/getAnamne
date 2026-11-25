import { createRequire } from "module";
import assert from "assert";
const require = createRequire(import.meta.url);
const P = require("../parsers.js");

let pass = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log("  ✓", name); } catch (e) { console.error("  ✗", name, "\n   ", e.message); process.exitCode = 1; } };

// Real-shaped ChatGPT image-gen exchange: user uploads an image + prompt; the tool
// emits the generated image (channel "final"); there's commentary/caption noise, a
// tool-call code message, reasoning, and an empty final reply — all of which must be
// dropped, leaving a clean user turn (with its upload) + assistant turn (with the gen).
const CONV = JSON.stringify({
  conversation_id: "c1", title: "Dress",
  mapping: {
    u1: { id: "u1", message: { id: "u1", author: { role: "user" }, create_time: 1, recipient: "all",
      content: { content_type: "multimodal_text", parts: [
        { content_type: "image_asset_pointer", asset_pointer: "sediment://file_UP" }, "make it red" ] },
      metadata: { attachments: [{ id: "file_UP", name: "ref.png", mime_type: "image/png" }] } } },
    code: { id: "code", message: { id: "code", author: { role: "assistant" }, create_time: 2, recipient: "t2.sj", channel: "commentary",
      content: { content_type: "code", text: '{"prompt":"Create a dress..."}' } } },
    th: { id: "th", message: { id: "th", author: { role: "assistant" }, create_time: 3, recipient: "all",
      content: { content_type: "thoughts", thoughts: [{ summary: "thinking" }] } } },
    gen: { id: "gen", message: { id: "gen", author: { role: "tool", name: "t2.sj" }, create_time: 4, recipient: "all", channel: "final",
      content: { content_type: "multimodal_text", parts: [ { content_type: "image_asset_pointer", asset_pointer: "sediment://file_GEN", metadata: { dalle: { gen_id: "x" } } } ] } } },
    cap: { id: "cap", message: { id: "cap", author: { role: "tool", name: "t2.sj" }, create_time: 5, recipient: "all", channel: "commentary",
      content: { content_type: "multimodal_text", parts: [ { content_type: "image_asset_pointer", asset_pointer: "sediment://file_GEN" }, "Model caption: a red dress" ] } } },
    fin: { id: "fin", message: { id: "fin", author: { role: "assistant" }, create_time: 6, recipient: "all", channel: "final",
      content: { content_type: "text", parts: [""] } } },
  },
});

ok("attaches the upload to the user turn and the generation to an assistant turn", () => {
  const c = P.parseChatGPT(CONV);
  const u = c.messages.find((m) => m.role === "user");
  assert.deepEqual(u.images, ["file_UP"]);
  assert.equal(u.text, "make it red");
  const withGen = c.messages.find((m) => (m.images || []).includes("file_GEN"));
  assert.ok(withGen && withGen.role === "assistant", "generated image should sit on an assistant turn");
});

ok("keeps ChatGPT's internal content (does not strip it)", () => {
  const c = P.parseChatGPT(CONV);
  const allText = c.messages.map((m) => m.text).join(" ");
  assert.ok(/Create a dress/.test(allText), "internal tool-call content should be preserved");
});

ok("dedupes a generated image that repeats across final + commentary nodes", () => {
  const c = P.parseChatGPT(CONV);
  const count = c.messages.reduce((n, m) => n + (m.images || []).filter((f) => f === "file_GEN").length, 0);
  assert.equal(count, 1);
});

ok("toObsidianMarkdown shows a top gallery AND inline embeds, in turn order", () => {
  const c = P.parseChatGPT(CONV);
  c.images = [{ fileId: "file_UP", filename: "ref.png", mime: "image/png" }, { fileId: "file_GEN", filename: "gen.png", mime: "image/png" }];
  const md = P.toObsidianMarkdown(c);
  assert.ok(md.includes("## 🖼 Images"), "top gallery missing");
  assert.ok(md.includes("![ref.png](<../_attachments/c1/ref.png>)"), "upload embed missing");
  assert.ok(md.includes("![gen.png](<../_attachments/c1/gen.png>)"), "generated embed missing");
  // each image appears at least twice (once in the top gallery, once inline)
  assert.ok((md.match(/ref\.png\]\(/g) || []).length >= 2, "upload should be in gallery + inline");
});

console.log(`\n${pass} checks passed.`);

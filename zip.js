// Minimal ZIP writer for "Export all". Entries are STORED (no compression):
// Markdown is small and images are already compressed, so deflate would buy
// little. Names are UTF-8 (general-purpose flag bit 11).
(function (root) {
  "use strict";

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(d) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
  }

  // Two conversations can share a filename (same title, date and short id is
  // unlikely but possible), and a zip with duplicate names loses one on extract.
  function uniqueName(name, seen) {
    if (!seen.has(name)) return name;
    const dot = name.lastIndexOf(".");
    const slash = name.lastIndexOf("/");
    const [base, ext] = dot > slash ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    let i = 2;
    while (seen.has(`${base} (${i})${ext}`)) i++;
    return `${base} (${i})${ext}`;
  }

  // entries: [{ name: "dir/file.md", data: Uint8Array }] → Uint8Array (.zip bytes)
  function buildZip(entries, now = new Date()) {
    const enc = new TextEncoder();
    const { time, date } = dosDateTime(now);
    const seen = new Set();
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const e of entries) {
      const name = uniqueName(e.name, seen);
      seen.add(name);
      const nameBytes = enc.encode(name);
      const data = e.data;
      const crc = crc32(data);

      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true); // version needed
      lh.setUint16(6, 0x0800, true); // UTF-8 names
      lh.setUint16(8, 0, true); // stored
      lh.setUint16(10, time, true);
      lh.setUint16(12, date, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true);
      lh.setUint32(22, data.length, true);
      lh.setUint16(26, nameBytes.length, true);
      lh.setUint16(28, 0, true);
      locals.push(new Uint8Array(lh.buffer), nameBytes, data);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true); // version made by
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, time, true);
      ch.setUint16(14, date, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true);
      ch.setUint32(24, data.length, true);
      ch.setUint16(28, nameBytes.length, true);
      ch.setUint32(42, offset, true);
      centrals.push(new Uint8Array(ch.buffer), nameBytes);

      offset += 30 + nameBytes.length + data.length;
    }

    const cdSize = centrals.reduce((n, b) => n + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);

    const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
    const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
    let p = 0;
    for (const b of parts) { out.set(b, p); p += b.length; }
    return out;
  }

  const api = { buildZip, crc32 };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AnamneZip = api;
})(typeof self !== "undefined" ? self : this);

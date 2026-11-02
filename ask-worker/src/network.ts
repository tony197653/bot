/**
 * 計數用網路鍵（雜湊前）：
 * - IPv4：完整位址
 * - IPv6：展開後取 /64 前綴（前 4 個 hextet）
 * - IPv4-mapped IPv6（::ffff:a.b.c.d）當 IPv4 處理
 */
export function networkKey(ip: string): string {
  const raw = (ip || "").trim().toLowerCase().split("%")[0];
  if (!raw) return "0.0.0.0";

  // IPv4
  if (raw.includes(".") && !raw.includes(":")) {
    return raw;
  }

  // IPv4-mapped：::ffff:192.0.2.1 或 ::ffff:c000:0201
  const mapped = parseIpv4Mapped(raw);
  if (mapped) return mapped;

  if (raw.includes(":")) {
    const hextets = expandIpv6(raw);
    return hextets.slice(0, 4).join(":");
  }

  return raw;
}

function parseIpv4Mapped(ip: string): string | null {
  const m = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (m) return m[1];
  const m2 = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m2) {
    const a = parseInt(m2[1], 16);
    const b = parseInt(m2[2], 16);
    return `${(a >> 8) & 255}.${a & 255}.${(b >> 8) & 255}.${b & 255}`;
  }
  return null;
}

/** 展開成 8 個零補齊、小寫 hextet。 */
export function expandIpv6(ip: string): string[] {
  const bare = ip.trim().toLowerCase().split("%")[0];
  const sides = bare.split("::");
  if (sides.length > 2) {
    throw new Error("invalid ipv6");
  }

  const toParts = (s: string): string[] => {
    if (!s) return [];
    const parts = s.split(":");
    // 尾端若是 IPv4 點分，轉成兩個 hextet
    if (parts.length && /^\d+\.\d+\.\d+\.\d+$/.test(parts[parts.length - 1])) {
      const v4 = parts.pop()!.split(".").map((n) => Number(n));
      parts.push(((v4[0] << 8) | v4[1]).toString(16));
      parts.push(((v4[2] << 8) | v4[3]).toString(16));
    }
    return parts.filter((p) => p.length > 0);
  };

  let head: string[];
  let tail: string[];
  if (sides.length === 1) {
    head = toParts(sides[0]);
    tail = [];
  } else {
    head = toParts(sides[0]);
    tail = toParts(sides[1]);
  }

  const missing = 8 - head.length - tail.length;
  const full = [...head, ...Array(Math.max(0, missing)).fill("0"), ...tail];
  while (full.length < 8) full.push("0");
  return full.slice(0, 8).map((h) => h.padStart(4, "0"));
}

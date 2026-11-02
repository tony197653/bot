/**
 * 計數用網路鍵（雜湊前）：
 * - IPv4：完整位址
 * - IPv6：先完整展開，再判斷是否 IPv4-mapped；否則取 /64（前 4 個 hextet）
 * - 任一 hextet 超過 4 字元 → invalid
 */
export function networkKey(ip: string): string {
  const raw = (ip || "").trim().toLowerCase().split("%")[0];
  if (!raw) return "0.0.0.0";

  // 純 IPv4
  if (raw.includes(".") && !raw.includes(":")) {
    return raw;
  }

  if (raw.includes(":")) {
    const hextets = expandIpv6(raw);
    const mapped = ipv4MappedFromHextets(hextets);
    if (mapped) return mapped;
    return hextets.slice(0, 4).join(":");
  }

  return raw;
}

/** 展開成 8 個零補齊、小寫 hextet。hextet > 4 字元則 throw。 */
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
      if (v4.some((n) => n < 0 || n > 255 || Number.isNaN(n))) {
        throw new Error("invalid ipv6");
      }
      parts.push(((v4[0] << 8) | v4[1]).toString(16));
      parts.push(((v4[2] << 8) | v4[3]).toString(16));
    }
    for (const p of parts) {
      if (!p) continue;
      if (p.length > 4) throw new Error("invalid ipv6");
      if (!/^[0-9a-f]{1,4}$/.test(p)) throw new Error("invalid ipv6");
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
  if (missing < 0) throw new Error("invalid ipv6");
  const full = [...head, ...Array(missing).fill("0"), ...tail];
  if (full.length !== 8) throw new Error("invalid ipv6");
  return full.map((h) => h.padStart(4, "0"));
}

/** 展開後的 ::ffff:a.b.c.d（hextets[5]==ffff 且前五段為 0）。 */
function ipv4MappedFromHextets(hextets: string[]): string | null {
  if (hextets.length !== 8) return null;
  if (hextets[5] !== "ffff") return null;
  for (let i = 0; i < 5; i++) {
    if (hextets[i] !== "0000") return null;
  }
  const a = parseInt(hextets[6], 16);
  const b = parseInt(hextets[7], 16);
  return `${(a >> 8) & 255}.${a & 255}.${(b >> 8) & 255}.${b & 255}`;
}

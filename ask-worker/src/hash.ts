import { networkKey } from "./network";

/** 對「網路鍵」加鹽 SHA-256（先經 networkKey：IPv4 全址／IPv6 /64）。
 * 無效 IPv6 解析失敗時改雜湊原始字串，避免 Worker 500。 */
export async function hashIp(ip: string, salt: string): Promise<string> {
  let key: string;
  try {
    key = networkKey(ip);
  } catch {
    key = (ip || "").trim().toLowerCase() || "0.0.0.0";
  }
  const data = new TextEncoder().encode(salt + key);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function shortHash(full: string): string {
  return full.slice(0, 8);
}

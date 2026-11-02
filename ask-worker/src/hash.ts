import { networkKey } from "./network";

/** 對「網路鍵」加鹽 SHA-256（先經 networkKey：IPv4 全址／IPv6 /64）。 */
export async function hashIp(ip: string, salt: string): Promise<string> {
  const key = networkKey(ip);
  const data = new TextEncoder().encode(salt + key);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function shortHash(full: string): string {
  return full.slice(0, 8);
}

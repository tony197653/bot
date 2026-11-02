export async function hashIp(ip: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(salt + ip);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function shortHash(full: string): string {
  return full.slice(0, 8);
}

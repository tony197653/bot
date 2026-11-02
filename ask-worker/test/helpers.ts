import { env, SELF } from "cloudflare:test";

export const ORIGIN = "https://tony197653.github.io";
export const PREVIEW_ORIGIN = "http://127.0.0.1:4173";
export const BAD_ORIGIN = "https://evil.example";

/** Turnstile 測試 token（搭配 secret 1x…0AA 會通過） */
export const TS_OK = "XXXX.DUMMY.TOKEN.XXXX";

let ipSeq = 0;
/** 每個測試用不同 IP，避免 isolatedStorage:false 時互相踩額度／連按 */
export function freshIp(tag = "t"): string {
  ipSeq += 1;
  return `203.0.113.${(ipSeq % 200) + 1}`;
}

export function askHeaders(origin = ORIGIN, ip?: string): HeadersInit {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Origin: origin,
  };
  if (ip) h["CF-Connecting-IP"] = ip;
  return h;
}

export async function ask(
  body: Record<string, unknown>,
  origin = ORIGIN,
  ip?: string,
): Promise<Response> {
  return SELF.fetch("https://example.com/ask", {
    method: "POST",
    headers: askHeaders(origin, ip || freshIp()),
    body: JSON.stringify(body),
  });
}

export async function quota(origin = ORIGIN, now?: string, ip?: string): Promise<Response> {
  const url = new URL("https://example.com/quota");
  if (now) url.searchParams.set("now", now);
  return SELF.fetch(url.toString(), {
    method: "GET",
    headers: {
      Origin: origin,
      ...(ip ? { "CF-Connecting-IP": ip } : { "CF-Connecting-IP": freshIp("q") }),
    },
  });
}

export async function readSse(
  res: Response,
): Promise<Array<{ event: string | null; data: string }>> {
  const text = await res.text();
  const events: Array<{ event: string | null; data: string }> = [];
  let event: string | null = null;
  let data: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).trim());
    } else if (line === "") {
      if (data.length) {
        events.push({ event, data: data.join("\n") });
      }
      event = null;
      data = [];
    }
  }
  if (data.length) events.push({ event, data: data.join("\n") });
  return events;
}

/** 讀完 body，避免 waitUntil 串流被測試結束打斷 */
export async function drain(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    /* ignore */
  }
}

export { env };

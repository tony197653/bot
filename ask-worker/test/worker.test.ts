/**
 * 整合測試集中在單一檔，避免 vitest-pool-workers 在切檔時
 * 使 SQLite Durable Object 失效（index.ts changed / inputGateBroken）。
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hashIp } from "../src/hash";
import { runMockFallbackChain, runWithFallback } from "../src/providers";
import type { Env } from "../src/types";
import {
  BAD_ORIGIN,
  ORIGIN,
  PREVIEW_ORIGIN,
  TS_OK,
  ask,
  drain,
  freshIp,
  quota,
  readSse,
} from "./helpers";

describe("CORS", () => {
  it("allows production origin on OPTIONS", async () => {
    const res = await SELF.fetch("https://example.com/ask", {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("allows EXTRA_ALLOWED_ORIGIN for previews", async () => {
    const res = await SELF.fetch("https://example.com/quota", {
      method: "GET",
      headers: { Origin: PREVIEW_ORIGIN, "CF-Connecting-IP": freshIp() },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(PREVIEW_ORIGIN);
  });

  it("rejects foreign Origin with 403", async () => {
    const res = await ask({ q: "你好", turnstileToken: TS_OK }, BAD_ORIGIN);
    expect(res.status).toBe(403);
  });

  it("rejects OPTIONS from foreign Origin", async () => {
    const res = await SELF.fetch("https://example.com/ask", {
      method: "OPTIONS",
      headers: { Origin: BAD_ORIGIN },
    });
    expect(res.status).toBe(403);
  });
});

describe("input limits + Turnstile", () => {
  it("rejects empty q", async () => {
    const res = await ask({ q: "   ", turnstileToken: TS_OK });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("bad_input");
  });

  it("rejects q over 500 chars", async () => {
    const res = await ask({ q: "啊".repeat(501), turnstileToken: TS_OK });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("bad_input");
  });

  it("accepts q of exactly 500 chars", async () => {
    const res = await ask({
      q: "啊".repeat(500),
      turnstileToken: TS_OK,
      now: "2026-11-02T03:00:00.000Z",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type") || "").toContain("text/event-stream");
    await drain(res);
  });

  it("rejects missing token", async () => {
    const res = await ask({ q: "你好" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("turnstile");
  });

  it("rejects empty token", async () => {
    const res = await ask({ q: "你好", turnstileToken: "" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("turnstile");
  });
});

async function burnViaDo(n: number, now: string, ip: string) {
  const ipHash = await hashIp(ip, env.IP_SALT);
  const stub = env.COUNTER.get(env.COUNTER.idFromName(ipHash));
  for (let i = 0; i < n; i++) {
    const t = new Date(new Date(now).getTime() + i * 11_000).toISOString();
    await stub.fetch(`https://c/consume?now=${encodeURIComponent(t)}`, { method: "POST" });
  }
}

async function fetchAsk(ip: string, q: string, now: string): Promise<Response> {
  return SELF.fetch("https://example.com/ask", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      "CF-Connecting-IP": ip,
    },
    body: JSON.stringify({ q, turnstileToken: TS_OK, now }),
  });
}

describe("daily quota + 08:00 Asia/Taipei reset (UTC day)", () => {
  it("GET /quota returns remaining and resetAt", async () => {
    const res = await quota();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { remaining: number; resetAt: string };
    expect(body.remaining).toBeGreaterThanOrEqual(0);
    expect(body.remaining).toBeLessThanOrEqual(20);
    expect(body.resetAt).toMatch(/T00:00:00/);
  });

  it("blocks the 21st question with daily_limit", async () => {
    const dayStart = "2026-11-02T00:00:01.000Z";
    const ip = "198.51.100.21";
    await burnViaDo(20, dayStart, ip);
    const res = await fetchAsk(ip, "第 21 題", dayStart);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { code: string; remaining: number };
    expect(body.code).toBe("daily_limit");
    expect(body.remaining).toBe(0);
  });

  it("resets at next UTC midnight (= 08:00 Taipei)", async () => {
    const day1 = "2026-11-02T12:00:00.000Z";
    const day2 = "2026-11-03T00:00:01.000Z";
    const ip = "198.51.100.22";
    await burnViaDo(20, day1, ip);
    const blocked = await fetchAsk(ip, "還是第 21", day1);
    expect(blocked.status).toBe(429);
    const ok = await fetchAsk(ip, "新的一天", day2);
    expect(ok.status).toBe(200);
    const events = await readSse(ok);
    const meta = events.find((e) => e.event === "meta");
    expect(meta).toBeTruthy();
    expect(JSON.parse(meta!.data).remaining).toBe(19);
  });

  it("blocks burst: >3 asks within 10 seconds", async () => {
    const now = "2026-11-02T08:00:00.000Z";
    const ip = "198.51.100.23";
    for (let i = 0; i < 3; i++) {
      const res = await fetchAsk(ip, `連按 ${i}`, now);
      expect(res.status).toBe(200);
      await drain(res);
    }
    const tooFast = await fetchAsk(ip, "第四下", now);
    expect(tooFast.status).toBe(429);
    expect(((await tooFast.json()) as { code: string }).code).toBe("too_fast");
  });
});

describe("SSE format", () => {
  it("streams meta, text chunks, and done", async () => {
    const res = await ask({
      q: "用條列說明三點",
      turnstileToken: TS_OK,
      now: "2026-11-02T01:00:00.000Z",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type") || "").toContain("text/event-stream");
    const events = await readSse(res);
    expect(events[0]?.event).toBe("meta");
    expect(JSON.parse(events[0].data)).toHaveProperty("remaining");
    const texts = events.filter((e) => e.event === null).map((e) => JSON.parse(e.data).t);
    expect(texts.join("").length).toBeGreaterThan(0);
    const done = events.find((e) => e.event === "done");
    expect(done).toBeTruthy();
    expect(JSON.parse(done!.data)).toEqual({ truncated: false });
  });

  it("emits mid-stream error event", async () => {
    const res = await ask({
      q: "__MID_ERROR__",
      turnstileToken: TS_OK,
      now: "2026-11-02T01:10:00.000Z",
    });
    expect(res.status).toBe(200);
    const events = await readSse(res);
    const err = events.find((e) => e.event === "error");
    expect(err).toBeTruthy();
    expect(JSON.parse(err!.data).code).toBe("retry");
    const texts = events
      .filter((e) => e.event === null)
      .map((e) => JSON.parse(e.data).t)
      .join("");
    expect(texts).toContain("已經出了一部分");
  });

  it("refunds on all_quota when no text produced", async () => {
    const ip = "198.51.100.90";
    const now = "2026-11-02T02:00:00.000Z";
    const before = await SELF.fetch("https://example.com/quota", {
      headers: { Origin: ORIGIN, "CF-Connecting-IP": ip },
    });
    const beforeBody = (await before.json()) as { remaining: number };

    const res = await SELF.fetch("https://example.com/ask", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        "CF-Connecting-IP": ip,
      },
      body: JSON.stringify({ q: "__FAIL_ALL__", turnstileToken: TS_OK, now }),
    });
    expect(res.status).toBe(200);
    const events = await readSse(res);
    const err = events.find((e) => e.event === "error");
    expect(JSON.parse(err!.data).code).toBe("all_quota");

    const after = await SELF.fetch("https://example.com/quota", {
      headers: { Origin: ORIGIN, "CF-Connecting-IP": ip },
    });
    const afterBody = (await after.json()) as { remaining: number };
    expect(afterBody.remaining).toBe(beforeBody.remaining);
  });
});

describe("provider fallback (mocked)", () => {
  function fakeEnv(overrides: Partial<Env> = {}): Env {
    const flags = new Map<string, string>();
    return {
      AI: {} as Ai,
      COUNTER: {} as DurableObjectNamespace,
      FLAGS: {
        get: async (k: string) => flags.get(k) ?? null,
        put: async (k: string, v: string) => {
          flags.set(k, v);
        },
      } as unknown as KVNamespace,
      ALLOWED_ORIGIN: ORIGIN,
      EXTRA_ALLOWED_ORIGIN: "",
      WORKERS_AI_MODEL: "@cf/openai/gpt-oss-20b",
      WORKERS_AI_FALLBACK_MODEL: "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
      GROQ_MODEL: "openai/gpt-oss-120b",
      GEMINI_MODEL: "gemini-2.0-flash",
      OPENROUTER_MODEL: "google/gemma-2-9b-it:free",
      MOCK_AI: "1",
      TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
      IP_SALT: "x",
      ...overrides,
    };
  }

  it("mock AI returns streamed text", async () => {
    const chunks: string[] = [];
    for await (const c of runWithFallback(fakeEnv(), [
      { role: "system", content: "sys" },
      { role: "user", content: "你好" },
    ])) {
      if (c.type === "text" && c.text) chunks.push(c.text);
    }
    expect(chunks.join("")).toContain("模擬回答");
  });

  it("falls through quota providers then succeeds", async () => {
    const out: string[] = [];
    for await (const c of runMockFallbackChain(["quota", "quota", "ok"])) {
      if (c.type === "text" && c.text) out.push(c.text);
      if (c.type === "done") out.push("DONE:" + (c.provider || ""));
    }
    expect(out.join("")).toContain("備援成功");
    expect(out.join("")).toContain("DONE:gemini");
  });

  it("all quota yields all_quota", async () => {
    let code = "";
    for await (const c of runMockFallbackChain(["quota", "quota", "quota", "quota"])) {
      if (c.type === "error") code = c.code || "";
    }
    expect(code).toBe("all_quota");
  });
});

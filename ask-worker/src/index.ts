import { resolveOrigin, corsHeaders, jsonResponse } from "./cors";
import { MAX_Q_LEN } from "./day";
import { hashIp, shortHash } from "./hash";
import { SYSTEM_PROMPT } from "./prompt";
import { runWithFallback } from "./providers";
import { QuotaCounter } from "./quota";
import { doneChunk, errorChunk, metaChunk, textChunk } from "./sse";
import { verifyTurnstile } from "./turnstile";
import type { Env, QuotaState } from "./types";

export { QuotaCounter };

function clientIp(req: Request): string {
  return (
    req.headers.get("CF-Connecting-IP") ||
    req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "0.0.0.0"
  );
}

async function counterStub(env: Env, ipHash: string) {
  const id = env.COUNTER.idFromName(ipHash);
  return env.COUNTER.get(id);
}

async function callCounter(
  stub: DurableObjectStub,
  path: string,
  method: "GET" | "POST",
  nowIso?: string,
): Promise<unknown> {
  const url = new URL(path, "https://counter.internal");
  if (nowIso) url.searchParams.set("now", nowIso);
  const res = await stub.fetch(url.toString(), { method });
  return res.json();
}

function logSafe(
  kind: string,
  extra: { provider?: string; status?: number; hash8?: string },
): void {
  console.log(
    JSON.stringify({
      kind,
      provider: extra.provider,
      status: extra.status,
      hash8: extra.hash8,
    }),
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = resolveOrigin(request, env);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      if (!origin) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // 同源／無 Origin 的工具呼叫（curl／測試）允許；有 Origin 卻不在白名單 → 403
    if (request.headers.has("Origin") && !origin) {
      return jsonResponse({ code: "forbidden", remaining: 0 }, 403, null);
    }

    try {
      if (url.pathname === "/quota" && request.method === "GET") {
        return await handleQuota(request, env, origin);
      }
      if (url.pathname === "/ask" && request.method === "POST") {
        return await handleAsk(request, env, origin, ctx);
      }
      return jsonResponse({ code: "not_found" }, 404, origin);
    } catch (e) {
      logSafe("unhandled", { hash8: "--------", status: 500 });
      console.error(String(e));
      return jsonResponse({ code: "retry", remaining: 0 }, 500, origin);
    }
  },
};

async function handleQuota(
  request: Request,
  env: Env,
  origin: string | null,
): Promise<Response> {
  const ip = clientIp(request);
  const ipHash = await hashIp(ip, env.IP_SALT || "missing-salt");
  const stub = await counterStub(env, ipHash);
  const nowIso = new URL(request.url).searchParams.get("now") || undefined;
  const state = (await callCounter(stub, "/quota", "GET", nowIso)) as QuotaState;
  return jsonResponse(
    { remaining: state.remaining, resetAt: state.resetAt },
    200,
    origin,
  );
}

async function handleAsk(
  request: Request,
  env: Env,
  origin: string | null,
  ctx: ExecutionContext,
): Promise<Response> {
  const ct = request.headers.get("Content-Type") || "";
  if (!ct.includes("application/json")) {
    return jsonResponse({ code: "bad_input", remaining: 0 }, 400, origin);
  }

  let body: { q?: unknown; turnstileToken?: unknown; now?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ code: "bad_input", remaining: 0 }, 400, origin);
  }

  const q = typeof body.q === "string" ? body.q.trim() : "";
  if (!q || q.length > MAX_Q_LEN) {
    return jsonResponse({ code: "bad_input", remaining: 0 }, 400, origin);
  }

  const token = typeof body.turnstileToken === "string" ? body.turnstileToken : "";
  const ip = clientIp(request);
  const okTs = await verifyTurnstile(token, ip, env);
  if (!okTs) {
    logSafe("turnstile", { status: 403, hash8: "--------" });
    return jsonResponse({ code: "turnstile", remaining: 0 }, 403, origin);
  }

  const ipHash = await hashIp(ip, env.IP_SALT || "missing-salt");
  const hash8 = shortHash(ipHash);
  const stub = await counterStub(env, ipHash);
  const nowIso = typeof body.now === "string" ? body.now : undefined;

  const consumed = (await callCounter(stub, "/consume", "POST", nowIso)) as {
    ok: boolean;
    code?: "daily_limit" | "too_fast";
    state: QuotaState;
  };

  if (!consumed.ok) {
    logSafe(consumed.code || "quota", { hash8, status: 429 });
    return jsonResponse(
      { code: consumed.code, remaining: consumed.state.remaining },
      429,
      origin,
    );
  }

  const remaining = consumed.state.remaining;
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content: q },
  ];

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const streamTask = (async () => {
    let refunded = false;
    let producedText = false;
    try {
      await writer.write(metaChunk(remaining));
      const now = nowIso ? new Date(nowIso) : new Date();
      for await (const chunk of runWithFallback(env, messages, {
        now,
        onLog: (m) => logSafe("provider", { hash8, provider: m }),
      })) {
        if (chunk.type === "text" && chunk.text) {
          producedText = true;
          await writer.write(textChunk(chunk.text));
        } else if (chunk.type === "done") {
          await writer.write(doneChunk(!!chunk.truncated));
        } else if (chunk.type === "error") {
          if (!producedText) {
            await callCounter(stub, "/refund", "POST", nowIso);
            refunded = true;
          }
          logSafe("stream_error", { hash8, provider: chunk.code, status: 502 });
          await writer.write(errorChunk(chunk.code || "retry"));
        }
      }
    } catch (e) {
      logSafe("stream_crash", { hash8, status: 500 });
      console.error(String(e));
      if (!producedText && !refunded) {
        try {
          await callCounter(stub, "/refund", "POST", nowIso);
        } catch {
          /* ignore */
        }
      }
      try {
        await writer.write(errorChunk("retry"));
      } catch {
        /* ignore */
      }
    } finally {
      try {
        await writer.close();
      } catch {
        /* ignore */
      }
    }
  })();

  // 讓串流在背景跑完（含 refund），同時立刻回傳 SSE
  ctx.waitUntil(streamTask);

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(origin),
    },
  });
}

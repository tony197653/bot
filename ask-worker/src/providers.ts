import { FIRST_TOKEN_TIMEOUT_MS, MAX_TOKENS, currentDayKey } from "./day";
import type { ChatMessage, Env, ProviderName, StreamChunk } from "./types";

export type FailKind = "quota" | "busy" | "retry" | "empty";

export class ProviderError extends Error {
  constructor(
    public readonly provider: ProviderName,
    public readonly kind: FailKind,
    public readonly status?: number,
  ) {
    super(`${provider}:${kind}:${status ?? "-"}`);
    this.name = "ProviderError";
  }
}

async function isExhausted(env: Env, name: ProviderName, now = new Date()): Promise<boolean> {
  const key = `exhausted:${name}:${currentDayKey(now)}`;
  return !!(await env.FLAGS.get(key));
}

export async function markExhausted(env: Env, name: ProviderName, now = new Date()): Promise<void> {
  const key = `exhausted:${name}:${currentDayKey(now)}`;
  const reset = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0),
  );
  const ttl = Math.max(60, Math.floor((reset.getTime() - now.getTime()) / 1000));
  await env.FLAGS.put(key, "1", { expirationTtl: ttl });
}

function openaiMessages(messages: ChatMessage[]) {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

/** 把上游 async iterable / ReadableStream 轉成本站 StreamChunk。 */
async function* parseOpenAiSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamChunk> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop() || "";
      for (const raw of parts) {
        const line = raw.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          yield { type: "done", truncated };
          return;
        }
        try {
          const json = JSON.parse(data) as {
            choices?: Array<{
              delta?: { content?: string };
              finish_reason?: string | null;
            }>;
          };
          const choice = json.choices?.[0];
          const t = choice?.delta?.content;
          if (t) yield { type: "text", text: t };
          if (choice?.finish_reason === "length") truncated = true;
        } catch {
          /* ignore partial json */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  yield { type: "done", truncated };
}

async function* parseWorkersAi(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamChunk> {
  // Workers AI 可能回 OpenAI SSE 或 newline JSON
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let truncated = false;
  let sawSse = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes("data:")) sawSse = true;
      if (sawSse) {
        const parts = buf.split("\n");
        buf = parts.pop() || "";
        for (const raw of parts) {
          const line = raw.trim();
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            yield { type: "done", truncated };
            return;
          }
          try {
            const json = JSON.parse(data) as {
              response?: string;
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const t = json.response ?? json.choices?.[0]?.delta?.content;
            if (t) yield { type: "text", text: t };
          } catch {
            /* ignore */
          }
        }
      } else {
        const parts = buf.split("\n");
        buf = parts.pop() || "";
        for (const raw of parts) {
          const line = raw.trim();
          if (!line) continue;
          try {
            const json = JSON.parse(line) as { response?: string };
            if (json.response) yield { type: "text", text: json.response };
          } catch {
            /* ignore */
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  yield { type: "done", truncated };
}

async function* parseGeminiSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamChunk> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop() || "";
      for (const raw of parts) {
        const line = raw.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        try {
          const json = JSON.parse(data) as {
            candidates?: Array<{
              content?: { parts?: Array<{ text?: string }> };
              finishReason?: string;
            }>;
          };
          const c = json.candidates?.[0];
          const t = c?.content?.parts?.map((p) => p.text || "").join("") || "";
          if (t) yield { type: "text", text: t };
          if (c?.finishReason === "MAX_TOKENS") truncated = true;
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  yield { type: "done", truncated };
}

function classifyHttp(status: number): FailKind {
  if (status === 429 || status === 402) return "quota";
  if (status >= 500) return "retry";
  return "retry";
}

async function streamWorkersAi(
  env: Env,
  messages: ChatMessage[],
): Promise<AsyncGenerator<StreamChunk>> {
  const model = env.WORKERS_AI_MODEL || "@cf/openai/gpt-oss-20b";
  try {
    const res = (await env.AI.run(model as keyof AiModels, {
      messages: openaiMessages(messages),
      max_tokens: MAX_TOKENS,
      temperature: 0.5,
      stream: true,
    } as never)) as ReadableStream<Uint8Array> | { response?: string };

    if (res && typeof res === "object" && "getReader" in res) {
      return parseWorkersAi(res);
    }
    // 非串流後援
    const text = (res as { response?: string })?.response || "";
    return (async function* () {
      if (text) yield { type: "text" as const, text };
      yield { type: "done" as const, truncated: false };
    })();
  } catch (e) {
    const msg = String(e);
    if (/429|quota|rate/i.test(msg)) throw new ProviderError("workers-ai", "quota");
    // 試 fallback 模型
    try {
      const fb = env.WORKERS_AI_FALLBACK_MODEL || "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
      const res = (await env.AI.run(fb as keyof AiModels, {
        messages: openaiMessages(messages),
        max_tokens: MAX_TOKENS,
        temperature: 0.5,
        stream: true,
      } as never)) as ReadableStream<Uint8Array>;
      return parseWorkersAi(res);
    } catch (e2) {
      const msg2 = String(e2);
      if (/429|quota|rate/i.test(msg2)) throw new ProviderError("workers-ai", "quota");
      throw new ProviderError("workers-ai", "retry");
    }
  }
}

async function streamGroq(
  env: Env,
  messages: ChatMessage[],
): Promise<AsyncGenerator<StreamChunk>> {
  const key = env.GROQ_API_KEY;
  if (!key) throw new ProviderError("groq", "empty");
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.GROQ_MODEL || "openai/gpt-oss-120b",
      messages: openaiMessages(messages),
      max_tokens: MAX_TOKENS,
      temperature: 0.5,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    throw new ProviderError("groq", classifyHttp(res.status), res.status);
  }
  return parseOpenAiSse(res.body);
}

async function streamGemini(
  env: Env,
  messages: ChatMessage[],
): Promise<AsyncGenerator<StreamChunk>> {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new ProviderError("gemini", "empty");
  const model = env.GEMINI_MODEL || "gemini-2.0-flash";
  const system = messages.find((m) => m.role === "system")?.content || "";
  const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent` +
    `?alt=sse&key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: MAX_TOKENS, temperature: 0.5 },
    }),
  });
  if (!res.ok || !res.body) {
    throw new ProviderError("gemini", classifyHttp(res.status), res.status);
  }
  return parseGeminiSse(res.body);
}

async function streamOpenRouter(
  env: Env,
  messages: ChatMessage[],
): Promise<AsyncGenerator<StreamChunk>> {
  const key = env.OPENROUTER_API_KEY;
  if (!key) throw new ProviderError("openrouter", "empty");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://tony197653.github.io",
      "X-Title": "ask-api",
    },
    body: JSON.stringify({
      model: env.OPENROUTER_MODEL || "google/gemma-2-9b-it:free",
      messages: openaiMessages(messages),
      max_tokens: MAX_TOKENS,
      temperature: 0.5,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    throw new ProviderError("openrouter", classifyHttp(res.status), res.status);
  }
  return parseOpenAiSse(res.body);
}

/** 測試用 mock：依問題前綴決定行為。 */
async function* streamMock(messages: ChatMessage[]): AsyncGenerator<StreamChunk> {
  const q = messages.find((m) => m.role === "user")?.content || "";
  if (q.startsWith("__FAIL_ALL__")) {
    throw new ProviderError("mock", "quota", 429);
  }
  if (q.startsWith("__BUSY__")) {
    throw new ProviderError("mock", "busy", 429);
  }
  if (q.startsWith("__RETRY__")) {
    throw new ProviderError("mock", "retry", 500);
  }
  if (q.startsWith("__EMPTY__")) {
    yield { type: "done", truncated: false };
    return;
  }
  if (q.startsWith("__MID_ERROR__")) {
    yield { type: "text", text: "已經出了一部分。" };
    yield { type: "error", code: "retry" };
    return;
  }
  if (q.startsWith("__SLOW__")) {
    await new Promise((r) => setTimeout(r, FIRST_TOKEN_TIMEOUT_MS + 1000));
  }
  const reply =
    "這是**模擬回答**。\n\n- 第一點\n- 第二點\n\n```js\nconsole.log('ok')\n```\n";
  for (const ch of reply) {
    yield { type: "text", text: ch };
  }
  yield { type: "done", truncated: false };
}

type ProviderFn = (
  env: Env,
  messages: ChatMessage[],
) => Promise<AsyncGenerator<StreamChunk>>;

interface ProviderSlot {
  name: ProviderName;
  available: (env: Env) => boolean;
  run: ProviderFn;
}

const REAL_PROVIDERS: ProviderSlot[] = [
  {
    name: "workers-ai",
    available: () => true,
    run: streamWorkersAi,
  },
  {
    name: "groq",
    available: (env) => !!env.GROQ_API_KEY,
    run: streamGroq,
  },
  {
    name: "gemini",
    available: (env) => !!env.GEMINI_API_KEY,
    run: streamGemini,
  },
  {
    name: "openrouter",
    available: (env) => !!env.OPENROUTER_API_KEY,
    run: streamOpenRouter,
  },
];

export async function* runWithFallback(
  env: Env,
  messages: ChatMessage[],
  opts: { now?: Date; onLog?: (msg: string) => void } = {},
): AsyncGenerator<StreamChunk & { provider?: ProviderName }> {
  const now = opts.now || new Date();
  const log = opts.onLog || (() => {});

  if (env.MOCK_AI === "1") {
    try {
      for await (const chunk of streamMock(messages)) {
        yield { ...chunk, provider: "mock" };
      }
      return;
    } catch (e) {
      if (e instanceof ProviderError) {
        yield { type: "error", code: e.kind === "busy" ? "busy" : e.kind === "quota" ? "all_quota" : "retry" };
        return;
      }
      yield { type: "error", code: "retry" };
      return;
    }
  }

  let sawQuota = false;
  let sawBusy = false;

  for (const slot of REAL_PROVIDERS) {
    if (!slot.available(env)) {
      log(`skip ${slot.name}: no key`);
      continue;
    }
    if (await isExhausted(env, slot.name, now)) {
      log(`skip ${slot.name}: exhausted flag`);
      sawQuota = true;
      continue;
    }

    try {
      const gen = await slot.run(env, messages);
      let first = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const firstToken = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), FIRST_TOKEN_TIMEOUT_MS);
      });

      // 包一層：首字逾時換下一家
      const iter = gen[Symbol.asyncIterator]();
      while (true) {
        const nextPromise = iter.next();
        if (first) {
          const raced = await Promise.race([
            nextPromise.then((r) => ({ kind: "val" as const, r })),
            firstToken.then((t) => ({ kind: t })),
          ]);
          if (raced.kind === "timeout") {
            log(`${slot.name}: first-token timeout`);
            try {
              await iter.return?.(undefined);
            } catch {
              /* ignore */
            }
            throw new ProviderError(slot.name, "retry");
          }
          if (timer) clearTimeout(timer);
          const { r } = raced;
          if (r.done) break;
          first = false;
          if (r.value.type === "text" && r.value.text) {
            yield { ...r.value, provider: slot.name };
          } else if (r.value.type === "done") {
            yield { ...r.value, provider: slot.name };
            return;
          } else if (r.value.type === "error") {
            yield { ...r.value, provider: slot.name };
            return;
          }
          continue;
        }

        const { done, value } = await nextPromise;
        if (done) break;
        if (value.type === "text" && value.text) {
          yield { ...value, provider: slot.name };
        } else if (value.type === "done") {
          yield { ...value, provider: slot.name };
          return;
        } else if (value.type === "error") {
          yield { ...value, provider: slot.name };
          return;
        }
      }
      yield { type: "done", truncated: false, provider: slot.name };
      return;
    } catch (e) {
      if (e instanceof ProviderError) {
        log(`provider fail ${e.message}`);
        if (e.kind === "quota") {
          sawQuota = true;
          await markExhausted(env, slot.name, now);
          continue;
        }
        if (e.kind === "busy") {
          sawBusy = true;
          continue;
        }
        if (e.kind === "empty") continue;
        // retry → try next
        continue;
      }
      log(`provider unexpected ${String(e)}`);
      continue;
    }
  }

  yield {
    type: "error",
    code: sawBusy && !sawQuota ? "busy" : sawQuota ? "all_quota" : "retry",
  };
}

/** 測試用：強制指定供應商順序行為。 */
export async function* runMockFallbackChain(
  sequence: Array<"ok" | "quota" | "busy" | "retry">,
  text = "備援成功",
): AsyncGenerator<StreamChunk & { provider?: ProviderName }> {
  const names: ProviderName[] = ["workers-ai", "groq", "gemini", "openrouter"];
  for (let i = 0; i < sequence.length; i++) {
    const s = sequence[i];
    const name = names[i] || "mock";
    if (s === "ok") {
      yield { type: "text", text, provider: name };
      yield { type: "done", truncated: false, provider: name };
      return;
    }
    if (s === "quota") continue;
    if (s === "busy") continue;
  }
  yield { type: "error", code: sequence.includes("busy") ? "busy" : "all_quota" };
}

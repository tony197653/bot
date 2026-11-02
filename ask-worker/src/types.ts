export interface Env {
  AI: Ai;
  COUNTER: DurableObjectNamespace;
  FLAGS: KVNamespace;
  ALLOWED_ORIGIN: string;
  EXTRA_ALLOWED_ORIGIN: string;
  WORKERS_AI_MODEL: string;
  WORKERS_AI_FALLBACK_MODEL: string;
  GROQ_MODEL: string;
  GEMINI_MODEL: string;
  OPENROUTER_MODEL: string;
  MOCK_AI: string;
  TURNSTILE_SECRET: string;
  IP_SALT: string;
  GROQ_API_KEY?: string;
  GEMINI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
}

export type ErrorCode =
  | "daily_limit"
  | "too_fast"
  | "bad_input"
  | "turnstile"
  | "busy"
  | "retry"
  | "all_quota";

export interface QuotaState {
  remaining: number;
  count: number;
  day: string;
  resetAt: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ProviderName = "workers-ai" | "groq" | "gemini" | "openrouter" | "mock";

export interface ProviderResult {
  stream: ReadableStream<Uint8Array>;
  provider: ProviderName;
}

export interface StreamChunk {
  type: "text" | "done" | "error";
  text?: string;
  truncated?: boolean;
  code?: "busy" | "retry" | "all_quota";
}

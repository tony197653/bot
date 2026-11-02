import type { Env } from "./types";

export function allowedOrigins(env: Env): string[] {
  const list = [env.ALLOWED_ORIGIN || "https://tony197653.github.io"];
  const extra = (env.EXTRA_ALLOWED_ORIGIN || "").trim();
  if (extra) list.push(extra);
  return list;
}

export function resolveOrigin(req: Request, env: Env): string | null {
  const origin = req.headers.get("Origin");
  if (!origin) return null;
  return allowedOrigins(env).includes(origin) ? origin : null;
}

export function corsHeaders(origin: string | null): HeadersInit {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function jsonResponse(
  body: unknown,
  status: number,
  origin: string | null,
  extra: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
      ...extra,
    },
  });
}

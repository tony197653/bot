import type { Env } from "./types";

/**
 * 正式環境忽略客戶端 now（防竄改額度／冷卻）。
 * 僅當 ALLOW_TEST_NOW==="1"（測試用，勿寫進 prod wrangler.toml）才採納。
 * 無效日期一律忽略，不拋錯（避免 500）。
 */
export function resolveClientNow(
  env: Env,
  candidate: unknown,
): string | undefined {
  if (env.ALLOW_TEST_NOW !== "1") return undefined;
  if (typeof candidate !== "string" || !candidate.trim()) return undefined;
  const d = new Date(candidate);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

export function resolveNowFromUrl(env: Env, url: URL): string | undefined {
  return resolveClientNow(env, url.searchParams.get("now"));
}

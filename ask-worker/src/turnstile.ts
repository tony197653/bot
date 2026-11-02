import type { Env } from "./types";

/** Cloudflare 官方測試 secret：永遠通過／永遠失敗（免打外網，單元測試也穩）。 */
const TEST_PASS = "1x0000000000000000000000000000000AA";
const TEST_FAIL = "2x0000000000000000000000000000000AA";

export async function verifyTurnstile(
  token: string,
  ip: string,
  env: Env,
): Promise<boolean> {
  if (!token || !env.TURNSTILE_SECRET) return false;

  if (env.TURNSTILE_SECRET === TEST_PASS) return true;
  if (env.TURNSTILE_SECRET === TEST_FAIL) return false;

  const body = new URLSearchParams();
  body.set("secret", env.TURNSTILE_SECRET);
  body.set("response", token);
  if (ip) body.set("remoteip", ip);

  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return !!data.success;
  } catch {
    return false;
  }
}

const enc = new TextEncoder();

export function sseEvent(event: string | null, data: unknown): Uint8Array {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  let out = "";
  if (event) out += `event: ${event}\n`;
  for (const line of payload.split("\n")) {
    out += `data: ${line}\n`;
  }
  out += "\n";
  return enc.encode(out);
}

export function textChunk(t: string): Uint8Array {
  return sseEvent(null, { t });
}

export function metaChunk(remaining: number): Uint8Array {
  return sseEvent("meta", { remaining });
}

export function doneChunk(truncated: boolean): Uint8Array {
  return sseEvent("done", { truncated });
}

export function errorChunk(code: "busy" | "retry" | "all_quota"): Uint8Array {
  return sseEvent("error", { code });
}

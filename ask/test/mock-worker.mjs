/**
 * 本機 Playwright 用的假 Worker：實作 /quota 與 /ask（SSE），MOCK AI。
 * 用法：node ask/test/mock-worker.mjs  [port=8787]
 */
import http from "node:http";

const PORT = Number(process.argv[2] || 8787);
const ORIGIN_OK = new Set([
  "https://tony197653.github.io",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
  "http://127.0.0.1:5500",
  "http://localhost:5500",
]);

const counts = new Map(); // ip -> { day, count, recent[] }

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function cors(req, res) {
  const o = req.headers.origin;
  if (o && ORIGIN_OK.has(o)) {
    res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Vary", "Origin");
  } else if (o) {
    return false;
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sse(res, event, data) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const server = http.createServer(async (req, res) => {
  if (!cors(req, res) && req.headers.origin) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: "forbidden" }));
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const ip = req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "1";

  if (url.pathname === "/quota" && req.method === "GET") {
    const day = dayKey();
    const st = counts.get(ip) || { day, count: 0, recent: [] };
    if (st.day !== day) {
      st.day = day;
      st.count = 0;
      st.recent = [];
    }
    counts.set(ip, st);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        remaining: Math.max(0, 20 - st.count),
        resetAt: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1)).toISOString(),
      }),
    );
    return;
  }

  if (url.pathname === "/ask" && req.method === "POST") {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "bad_input", remaining: 0 }));
      return;
    }
    const q = typeof body.q === "string" ? body.q.trim() : "";
    if (!q || q.length > 500) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "bad_input", remaining: 0 }));
      return;
    }
    if (!body.turnstileToken) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "turnstile", remaining: 0 }));
      return;
    }

    const day = dayKey();
    const st = counts.get(ip) || { day, count: 0, recent: [] };
    if (st.day !== day) {
      st.day = day;
      st.count = 0;
      st.recent = [];
    }
    if (st.count >= 20) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "daily_limit", remaining: 0 }));
      return;
    }
    st.count += 1;
    counts.set(ip, st);

    if (q === "__DAILY__") {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "daily_limit", remaining: 0 }));
      return;
    }
    if (q === "__BUSY__") {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "too_fast", remaining: 20 - st.count }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    sse(res, "meta", { remaining: 20 - st.count });

    if (q === "__ERR_RETRY__") {
      sse(res, "error", { code: "retry" });
      res.end();
      return;
    }
    if (q === "__ERR_ALL__") {
      st.count -= 1;
      counts.set(ip, st);
      sse(res, "error", { code: "all_quota" });
      res.end();
      return;
    }
    if (q === "__MID__") {
      for (const ch of "已經出了一部分。") {
        sse(res, null, { t: ch });
      }
      sse(res, "error", { code: "retry" });
      res.end();
      return;
    }
    if (q === "__SLOW__") {
      await new Promise((r) => setTimeout(r, 2500));
    }

    const reply =
      q === "__MD__"
        ? "## 標題\n\n- 一\n- 二\n\n**粗體** 與 `code`\n"
        : "這是模擬回答：保持安靜、乾淨。\n\n1. 先給結論\n2. 再列重點\n";

    for (const ch of reply) {
      sse(res, null, { t: ch });
      await new Promise((r) => setTimeout(r, 8));
    }
    sse(res, "done", { truncated: false });
    res.end();
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock-worker on http://127.0.0.1:${PORT}`);
});

# ask-api（跟 AI 提問 · Cloudflare Worker）

Workers Free 相容：Workers AI + SQLite Durable Object 計數 + KV 額度旗標 + Turnstile。

## 部署（需你自己的 Cloudflare 帳號）

```bash
cd ask-worker
npm install

# 建立 KV（把回傳的 id 填進 wrangler.toml 的 FLAGS id / preview_id）
npx wrangler kv namespace create FLAGS
npx wrangler kv namespace create FLAGS --preview

# secrets
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put IP_SALT
# 選填（沒設會自動跳過該供應商）
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put OPENROUTER_API_KEY

# 第一次部署會套用 migrations（new_sqlite_classes = QuotaCounter）
npx wrangler deploy
```

### wrangler.toml 重點

| 項目 | 值 |
|---|---|
| name | `ask-api` |
| ALLOWED_ORIGIN | `https://tony197653.github.io` |
| EXTRA_ALLOWED_ORIGIN | 預覽用來源（例如 `http://127.0.0.1:4173`），正式可留空 |
| MOCK_AI | 正式留空；本機測試可設 `1` |
| DO migration | `[[migrations]] tag = "v1"` → `new_sqlite_classes = ["QuotaCounter"]` |

Turnstile：Cloudflare 後台新增 **Invisible** widget，hostname `tony197653.github.io`；site key 填前端 `ask/app.js` 的 `CONFIG.turnstileSiteKey`，secret 用 `wrangler secret put TURNSTILE_SECRET`。

## 測試

```bash
npm test
```

使用 `@cloudflare/vitest-pool-workers`，涵蓋 CORS、字數、Turnstile、每網路每天 40 題（IPv4 全址／IPv6 /64）、連按、UTC 換日（＝台灣 08:00）、SSE、mock 供應商備援。

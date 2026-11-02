# 跟 AI 提問（前端）

路徑：GitHub Pages → `https://tony197653.github.io/bot/ask/`

## 設定

打開 `app.js` 最上方 `CONFIG`：

```js
const CONFIG = {
  workerUrl: "https://ask-api.<你的帳號>.workers.dev",
  turnstileSiteKey: "<Turnstile Invisible site key>",
};
```

本機預覽也可：`?worker=http://127.0.0.1:8787&sitekey=1x00000000000000000000AA`

## 本機預覽

此 repo 沒有額外的 Pages preview workflow；慣例是資料夾即頁面，合併到 `main` 後由 GitHub Pages 發布。

本機：

```bash
cd ask
# 終端 1：假 Worker（或 wrangler dev）
npm run mock-worker
# 終端 2：靜態服務
npx --yes serve -l 4173 .
# 瀏覽
# http://127.0.0.1:4173/?worker=http://127.0.0.1:8787
```

PR 預覽：可把 PR 分支開成 GitHub Pages 的另一個 source，或用 [htmlpreview.github.io](https://htmlpreview.github.io/)／把 `ask/` 丟上暫時的 Pages；Worker 端請把 `EXTRA_ALLOWED_ORIGIN` 設成預覽 Origin。

## E2E

```bash
npm install
npx playwright install chromium
npm run test:e2e
```

截圖輸出到 `/opt/cursor/artifacts/screenshots/`。

# 功能庫網頁（/bot/features/）

網頁內容全部來自同資料夾的 `features.json`。每月更新只要改這個檔，**不必動 `index.html`**。

## features.json 格式

| 欄位 | 說明 |
|---|---|
| `updated` | 最後更新日期，格式 `YYYY-MM-DD`，會顯示在頁首 |
| `source` | 資料來源說明，顯示在頁尾（可省略） |
| `notes` | 注意事項，陣列；每筆 `{ "title": 標題, "items": [ 一句一行 ] }`。標題含「地雷」或「付款」會用紅字標題 |
| `features` | 功能清單，陣列，網頁照這個順序排 |

`features` 每一筆：

| 欄位 | 說明 |
|---|---|
| `name` | 功能名稱，例如「登入」 |
| `status` | 只能填 `已驗證` 或 `候選` |
| `skill` | 已驗證時填對應技能名（例如 `firebase-record-sync`）；候選填 `""` |
| `extra` | （可省略）`true` 會在名稱旁標「加開」 |
| `primary` | 首選：`{ "name": 名稱, "url": 連結, "note": 一句理由 }` |
| `alternatives` | 備選，陣列，每筆格式同 `primary`；可放一個以上 |

- `url` 盡量放 GitHub repo；網址以 `https://github.com/` 開頭會標「GitHub」，其他網址（沒有公開 repo 的服務）自動標「官方文件」。
- `_說明`：給人看的備註，網頁不讀它。
- JSON 不能寫註解，字串要用雙引號，最後一筆後面不能有逗號。改完可貼到 https://jsonlint.com 檢查。

## 本機預覽

`fetch` 不能直接開檔案（file://），要用簡單伺服器：

```
cd features && python3 -m http.server 8000
```

再開 http://localhost:8000/

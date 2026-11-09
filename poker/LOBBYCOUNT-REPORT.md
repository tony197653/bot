# 入座樣式與大廳人數修正

分支：`pm/buyin-1109`。依本次明確指定的樣式值與行為修正；未提交、推送、合併或部署，未改 markup、Firestore rules 或憑證。

## 根因與修正

- 房主結帳並交棒後，`cashoutSeat` 已把 `room.hostUid` 改成新房主，舊房主的 `refreshLobbySummary` 因權限檢查直接返回，留下舊的房間摘要與列表人數。現行 `roomWriteOk` 禁止帳務事件同批改 `lobby`；列表也要求寫入者為現任房主，因此保留帳務批次，由新房主啟動時偵測摘要與座位數不符，透過既有 writeChain 執行非帳務摘要更新及列表同步，不必等待下一手。
- 非房主離桌後，原房主仍可走既有 cashout 後摘要更新。列表指紋原先在寫入前設定，且 upsert 吞下失敗，造成相同內容無法重送；改為回報 upsert 成敗，僅成功才記錄指紋。失敗後可在後續既有同步時重送，未新增輪詢。
- 完整房間資料可用時，大廳列與「我的牌桌」優先計算 `seatUids`；只有精簡列表時仍使用摘要人數。
- `#mpBuyinPicker` 數字輸入套用指定的既有值與等寬數字，手機 17px；卡片用兩欄 grid 排列既有按鈕。range 沿用全域 100% 寬度與既有軌道，保留 `inputmode="numeric"`。

## 變更檔案

- `css/game.css`
- `js/net/host.js`
- `js/net/room.js`
- `js/ui/lobby.js`
- `js/ui/mp-app.js`
- `test/lobby-count.test.js`
- `LOBBYCOUNT-REPORT.md`

## 實際驗證與限制

- `cd poker && node --test --test-isolation=none test/lobby-count.test.js`：4/4 通過（接管補寫、摘要恢復、即時座位數及列表失敗重送）。對照 HEAD 原始碼，UI 與指紋測試失敗，確認能捕捉修正前問題。
- `cd poker && npm test`：43 個測試檔，42 通過、1 失敗；失敗檔為 `raise-confirm.test.js`。
- `cd poker && node --test --test-isolation=none test/raise-confirm.test.js`：2 通過、1 失敗；瀏覽器測試啟動本機 HTTP server 時得到 `listen EPERM: operation not permitted 127.0.0.1`。環境禁止監聽，完整測試未全綠。
- `git diff --check`：通過。
- 未新增回歸腳本；僅依本次要求新增單元測試。未執行真人桌機／手機端到端回歸、rules emulator 或 QA 驗收，無 preview URL。受影響的房主交棒、一般離桌、旁觀大廳與入座選擇器仍需 PM 手動回歸。
- rules 相容性依原始碼核對，尚無 emulator 實證。補寫需要新房主 loop 啟動且寫入成功；寫入失敗後仍仰賴後續既有同步。

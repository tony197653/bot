# 離桌提示與交棒房主名稱修正

2026-11-09；分支 `pm/buyin-1109`，基底 `364e334`。未 commit、push、合併或部署；未改 UI 元素、依賴或 Firestore rules。

## 修改檔案與行為

- `js/net/client.js`：取消時清除 pending 並使舊非同步作業失效；等待 seq 讀取、初次寫入、重試期間離桌，都不再排入重試。每次寫入與重試檢查是否仍在原桌。已送出的 Firestore 寫入無法撤回。
- `js/ui/mp-app.js`：拆除房間時取消 intent；sender 綁定原 roomId 與 table screen；一般動作、SHOW/MUCK 的失敗與等待提示僅能出現在原桌。
- `js/net/host.js`：queueWrite／refreshLobbySummary 共用新房主身分解析，依 displayNameOf、engine/pub 座位名稱取值；未知時用新房主 UID 短碼，絕不以舊摘要名稱補值。啟動時讀既有 pokerLobby 文件確認摘要擁有者；人數相同但房主 UID／名稱過期也立即刷新。身分未確認或交棒時清除舊照片，同房主則保留照片。每次 host loop 啟動至多增加一次列表文件讀取。
- `test/toast-hostname.test.js`：新增 12 案，涵蓋取消時序、原桌重試、兩組動作回呼、同人數交棒、名稱來源及正常同房主啟動。
- `test/open-speed.test.js`：既有 VM harness 載入實際使用的名稱 helper。
- 本報告。

## 原因與 rules 核對

舊 sender 的 clearResend 只停計時器；等待中的初次讀寫完成後仍能重新排入重試，tearDownRoom 也沒有呼叫取消。輸光後 cashoutSeat 清除座位，host 可能忽略舊動作，造成未清除的 pending 最終提示失敗；離房後失去 members 資格亦可能遭 rules 拒絕。現行 intentOk 並未直接要求座位存在，因此不能將所有情況都歸因於「座位消失導致 rules 拒絕」。

房間 lobby 的 rules 白名單只有 name、hostName、hostPhoto、blinds、seated，不允許 hostUid；pokerLobby 的 lobbyListingOk 已允許 hostUid／hostName／hostPhoto。此次未新增持久欄位；沿用 buildLobbySummary／buildLobbyListing，hostUid 只讀寫既有列表欄位，身分追蹤存在記憶體。

## 實際驗證

- 將三個實作檔暫時換回 HEAD 後執行 `node --test --test-isolation=none test/toast-hostname.test.js`：12 案中 9 失敗、3 通過；隨後還原修正檔。輸出：`/tmp/toast-hostname-before.txt`。
- 修正後 `node --test --test-isolation=none test/toast-hostname.test.js`：12/12 通過。
- `cd poker && npm test`：首輪 42/44 個測試檔通過，修正 harness 後重跑為 43/44 通過。最後唯一失敗為 `raise-confirm.test.js`。輸出：`/tmp/toast-hostname-npm-test.txt`。
- `node --test --test-isolation=none test/open-speed.test.js test/raise-confirm.test.js`：定位出 harness 缺 helper 與瀏覽器測試的 `listen EPERM: operation not permitted 127.0.0.1`；前者已修正，後者是目前環境監聽限制。
- 最後執行 `node --test --test-isolation=none test/toast-hostname.test.js test/open-speed.test.js`：20/20 通過。
- `git diff --check`：通過。

## 回歸與未完成事項

已涵蓋自動化受影響範圍：離桌後重試與提示、仍在桌上的重試、同人數交棒、正常房主啟動、開桌／加入流程。未完成瀏覽器手動端到端（訪客輸光→大廳、舊 host 輸光→新 host→列表）及桌機／手機截圖；不能以 unit 結果代替手動驗收，也未自行 QA 驗收。未執行 rules emulator；只有白名單靜態核對。無新增 preview URL。

目前限制：完整 npm test 未全綠，仍需在允許本機監聽的環境重跑瀏覽器測試及手動回歸。身分讀取失敗時採保守清空照片；新房主名稱尚不可取得時暫用其 UID 短碼，不沿用前房主名稱。

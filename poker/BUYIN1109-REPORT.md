# BUYIN1109 本機實作回報

分支 `pm/buyin-1109`，基底 `fa19374`。本輪僅本機修改，未 commit／push／部署／安裝依賴／連線外部服務，未動憑證。原有未追蹤的 `poker/node_modules` 保留。

## 已實作

1. 大廳清單入桌與開桌遇既有桌，先靜默結算舊關桌綁定、重讀本人帳戶，再按目標桌 50BB 檢查；不足留大廳、顯示既有不足訊息。同桌綁定可重返。新帳戶依既有首次贈送額度判斷；全新開桌仍由入座檢查門檻。
2. 點空位同步建立選額視窗，含數字／slider、取消／入座；最低 50BB、上限 bank，預設依房間設定夾限。確認立即提示，再讀 presence／寫買入／送 SIT。buyinAmount 只扣選定數額，帳本 bankAfter 為剩餘 bank，total 不變；房主依 inPlay 入座。
3. 開桌表單依指定改為「攜入籌碼」、移除前後綴、替換說明及刪除補碼固定規則。
4. 移除補碼 UI、房主處理、事件、意圖允許與 Rules 路徑；保留歷史統計及 topUps／topUpChips 相容欄位。hand_over 結算與手數寫入確認後，0-stack 席進既有 cashoutSeat，金額 0；本人離座回大廳並提示指定文字。排行榜僅移除補碼欄。

## 修改檔案

- 帳務／網路：`js/net/buyin-policy.js`、`ledger.js`、`host.js`、`client.js`。
- UI：`js/ui/mp-app.js`、`lobby.js`、`stats.js`、`fx-mp.js`（刪除未再使用的補碼動畫常數）。
- Rules：`firebase/firestore.rules`。
- Rules 測試：`firebase/fix1109.rules.test.mjs`、`rules.test.mjs`、`stacks-sim.rules.test.mjs`。
- 單元測試：`test/buyin.test.js`、`appendix-m.test.js`、`fix1109-round10.test.js`、`fix1109.test.js`、`leave-confirm.test.js`、`open-speed.test.js`。
- 本回報：`BUYIN1109-REPORT.md`。以上路徑均相對於 `poker/`。

## Rules 變更位置（修改後行號）

- 約 159、178–183：刪除 topupSeatOk 與 moneyOk3 的 topup 分支，保留 buyin／cashout。
- 446–447：intent 類型移除 TOPUP_REQ／TOPUP_CANCEL。
- 580–593：buyinOk 要求 inPlay 為整數、至少 50BB、不超過原 bank，bank 扣除 inPlay，total 不變。
- 625：ledger 類型僅 grant／buyin／cashout；刪除 topupEntryOk 與約 685–687 的補碼 allow 分支。
- 639–645：確認既有 buyinEntryOk 仍要求 amount == p.inPlay、bankAfter == p.bank，未改。
- 596–609：確認 cashoutApplyOk 仍為 bank_after = bank_before + amount、inPlay = 0、total = bank_after，未改。client 的一般 cashout／closeAll／自救／取消買入也均保留此加回餘額方式；輸贏以實際桌上帶走額結算。

## 實際執行與結果

- `cd poker && node --test --test-isolation=none test/*.test.js`（外層 timeout 防止超過本輪限時）：最後完整執行 305 項，304 通過、1 失敗，約 14.7 秒。紀錄 `/tmp/buyin-final2.tap`。
- 唯一失敗為既有 `test/raise-confirm.test.js` 的真瀏覽器測試：環境拒絕建立本機 server，`listen EPERM 127.0.0.1`；未繞過限制，未宣稱瀏覽器回歸通過。
- 最後新增「開桌遇既有桌不足」案例後，執行 `node --test --test-isolation=none test/buyin.test.js test/fix1109-round10.test.js`：24/24 通過。紀錄 `/tmp/buyin-last-target.tap`。完整 305 項結果不含這最後新增的一項。
- `node --check`：`js/ui/mp-app.js`、`js/net/host.js`、`js/net/ledger.js` 與三個修改的 Rules 測試檔，均通過。
- `git diff --check`：通過。
- Rules 案例已加入：自選買入成功、低於 50BB／超過 bank／未扣足餘額／他人代寫拒絕、完整補碼批次與 ledger／room 改寫拒絕、房主對 0-stack 結帳且 bank 與桌上總額不變。依本輪禁止網路限制，未連 emulator，以上 Rules 案例尚未實跑。

## 回歸與剩餘風險

已覆蓋受影響程式的單元與來源契約：入桌順序／阻擋、選額上下限與同步建立、指定額帳務、SIT、輸光自動離座與 toast、補碼移除、表單與排行榜。未完成手動桌機／手機端到端、Rules emulator 驗證或 QA 驗收；不以單元測試取代。無 preview URL。

已在本輪限時內停止；剩餘為有權監聽本機 server 的環境之瀏覽器／手動回歸，以及明確允許連本機 emulator 後的 Rules 實測，估計另需 10–15 分鐘，不含發現問題後的修正。未合併、未部署。

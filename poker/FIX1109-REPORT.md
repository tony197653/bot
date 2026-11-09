# fix1109 本機修正報告

分支 pm/fix-1109-trial；依本輪使用者授權處理 a–d。未 commit/push、未部署、未修改 Rules、未安裝依賴、未啟動 emulator、未使用網路。沿用既有樣式，未加依賴。

## 已重現的根因與修正

- 入座競態：原 host.js:647 起的 seatPlayer 在 getPlayer await 前取得舊 room，兩筆並行入座都送相同 rev。Rules firestore.rules:170 要求 rev == resource.rev + 1，後送者遭拒。原程式已先 SEAT 本機引擎、增加 actionSeq/seatedAt，卻不回復；重試別席會留下同一人的幽靈座位。結果 queueWrite 的籌碼合計檢查（host.js:260、281）失敗，prepareClose 的 cashoutStateReady（host.js:38）也可能失敗。修正為 seatPlayer 加入既有 writeChain、讀取最新 room、驗證房主／成員／座位範圍；寫入失敗回復引擎、序號與 seatedAt。
- 收桌與入座競態：原 seatPlayer 不在 writeChain，prepareClose 等待該鏈無法等待正在入座的工作；await 帳戶讀取返回後仍能繼續寫入。現在入座納入同一鏈，且帳戶讀取返回後重新檢查 closing/running/closed，阻止收桌期間插入座位。單元測試先重現收桌結果多出 2000，再修正通過。
- closeAll 漏寫：ledger.js:233 的 builder 原本遇到仍佔座但 player.tableRoomId == null 就略過該人的帳本；Rules:199–206、221–223 對每個舊非空席都要求同批固定 cashout 帳本，不能略過。改為 ledger.js:248 提交前明確回報帳戶與座位帳不同步，不送出必然不完整的 batch。
- 進桌回應：原一般 enterRoom 在第一筆房間 getDoc 後才有畫面回應，只有分享畫面入口先畫 shell。現在所有新的 enterRoom 都在第一筆 await 前呼叫既有 paintEnterShell（mp-app.js:1644 附近）；已有房間的「開桌」查詢前用既有 toast 回饋。建立房間後移除阻塞分享畫面的帳戶重讀；首次 grant 直接使用回傳 player，省一次 getPlayer。

PM 新增的 ../PROD-EVIDENCE-930.md 與入座競態吻合：seat0 的 seatedAt 曾更新但 seatUids 空白，房主後來坐 seat1；第三人已有 buyin 並持續送 SIT，收桌逐席 fallback 之間才入座。這是與重現結果一致的推論，不代表已拿到正式 Firestore 拒絕紀錄。PM 證據也記錄第二次收桌成功、三人 bank 均 2000，沒有餘額卡住。

## a 開桌／進桌等待路徑

下列為原始碼可確認的 SDK 操作，不是 Safari 網路封包實測；快取可能使 getDoc 不發出網路請求。Firestore transaction 內部重試由 SDK 控制，沒有本機量測。

| 順序／位置 | Firestore 與序列等待 | 是否阻塞畫面 |
|---|---|---|
| lobby.js:594 → mp-app.js:1409 onCreateTable | 已有 hostRoomId：讀房間；若已關閉再 update player 清指標、getPlayer | 修正後先 toast；一般開桌直接同步畫既有表單 |
| lobby.js:925 表單 → mp-app.js:1453 doCreate | 同步 creating=true、paint，既有 spinner／「開房中…」 | 原本已有立即載入回饋 |
| room.js:194 createRoom | 先 get player；有舊 hostRoomId 再 get room、maybeAutoCloseIdleRoom、再 get room | 完成前停留載入表單，建立成功前不能假造房間 |
| room.js:240–265 | 最多 10 次房號碰撞嘗試；每次 transaction：tx.get player，必要時 tx.get 舊房，codeIsFree 讀 code，必要時讀 code 指向房間；寫 room/code/lobby/player，新帳號另寫 grant | 必要原子建立；SDK transaction 重試不影響已顯示的載入回饋 |
| mp-app.js doCreate 成功 | 原本再 await getPlayer 才顯示分享畫面 | 已移除該阻塞；已有帳戶本機更新 hostRoomId，新帳戶背景讀取 |
| lobby.js:994 分享畫面進入 | 既有 onEnter 立即 paintEnterShell，再 enterRoom | 無網路等待；保留分享流程 |
| mp-app.js enterRoom | tearDown → 現在先 paintEnterShell → get room；若讀取被拒，必要時 joinByCode | 所有入口都先畫 shell |
| room.js:397 joinByCode／:471 joinByRoomId | 房號加入：讀 code→讀 room→必要時 arrayUnion members→再讀 room；清單加入：讀 room→必要時寫 membership | 房號 UI 原有加入中；清單按鈕原有加入中；doJoin 另有 3000ms Promise.race，逾時不會取消底層 SDK |
| mp-app.js 首次 room snapshot | room=r → 立即 paintTableChrome；ensurePlayerGrant：讀 player，若新玩家 batch 寫 player+grant | shell 已出現；未入座立即使用既有操作列提示選位；grant 回傳 player 省一次重讀 |
| 首次初始化 | startPresence、createIntentSender、listenHole、cachePlayerName、hostLoop.start | presence 首次 setDoc 非 await；intent 序號預讀、姓名快取非畫面阻塞 |
| 房主自動入座 mp-app.js:1826 附近 | 最低 50BB 檢查 → buyinAll（讀 player→batch player+buyin；拒絕時另讀帳本及 player 做冪等判斷）→ getPlayer → seatPlayer | 牌桌 shell 已出現，沿用原房主入座狀態 |
| host.js:647 seatPlayer | 等既有 writeChain→讀最新 room→讀 player→room 金錢寫入→非金錢 lobby 摘要寫入→pokerLobby 寫入 | 僅等待合法座位提交，不阻塞顯示牌桌；金錢寫入不混入 lobby 變更 |
| host.js:231 queueWrite | 每件依序等待 250ms→room update→lobby listing；prepareClose 會等待此鏈 | 已在背景；非入桌顯示門檻 |
| stats/host-runtime.js:39–55 | start 的 recovery.wake 為 void；syncChips 內等 recovery，但呼叫端 host.js:311 使用 void | stats／chips 不在進桌 await 鏈；未更動啟用狀態 |
| net/presence.js:9–69 | host idle 門檻 10s，10s tick／約20s heartbeat；一般玩家30s；setDoc 為背景 | 不阻塞進桌；不是開桌慢的 await 根因 |

0.2 秒目標：單元測試證明在任何網路讀取返回前同步呼叫 paintEnterShell；未量測 Safari 實際繪製時間或網路延遲，不宣稱實機 200ms 已驗收。

## b closeAll 每個文件／欄位與 Rules

ledger.js:233–309：兩人零手數正常資料會先平行讀兩個 player＋兩個 nights，提交一個 7 文件 batch；無自訂 timeout。

| 文件／用戶端位置 | 欄位 | 現有規則 |
|---|---|---|
| room，ledger.js:254–261 | status=closed、rev+1、updatedAt=serverTimestamp、六席空字串、六 stacks=0、chipTotal=0、六 sess=null、deadlineAt=null、lastMoneyEvent={type:closeAll}；不改 pub/lobby | Rules:210–223 isHostCloseAll，特別是 :219–220 affectedKeys 白名單；:380 分流直接走 closeAll，不走 moneyOk |
| 各 ledger，:268–282 | type=cashout、amount=2000、roomId、sessionNo=1、seat、buyIn=2000、topUps=0、topUpChips=0、hands=0、nightKey、bankAfter=2000、by=host、at=serverTimestamp | :199–206 固定帳本 ID 與 amount/seat/by/at；:565–571 entryKeys；:608–635 seatRowOk/cashoutEntryOk 核對舊 room 的 sess/stack 與新 player；:640–642 create-only |
| 各 player，:283–292 | bank=2000、inPlay=0、total=2000、tableRoomId=null、topUps/topUpChips/handsPlayed 加零、updatedAt | :539–554 cashoutApplyOk 核對同批新帳本；hostRoomId 保留 |
| 各 nights，:295–307 | nightKey/uid/name、buyIn=2000、cashOut=2000、net=0、topUps=0、hands=0、lastEntry=固定 cashout ID、updatedAt | :648–666 nightAddOk 核對帳本與先前累計 |

正常「兩人各2000、尚未開手」資料看不出必然違反的值條件；新單元測試確認七文件 payload。不能將正常 closeAll 說成一定被 moneyOk 拒絕。真正拿到的正式證據只有 closeAll 拒絕後走逐席 fallback 的時間序；首次 closeAll permission-denied 的精確伺服器判定（如實際文件狀態或 Rules expression/access budget）仍須 PM 跑 emulator／提供拒絕 trace，尚未確定。已修復的是可重現的入座競態、幽靈引擎與不完整 batch。

## c 買入、第二／第三人、presence

- 新帳號 ensurePlayerGrant 預設房間設定 2000；10/20 的 50BB=1000，2000 可入座。餘額不足時既有 assertMinimumBuyin 在網路操作前同步提示，沒有降低門檻或額外贈送。
- buyinAll：Rules:525–535 核對本人、成員、bank 全部轉 inPlay、sessionNo+1、同批 buyin ledger；Rules:581–588 帳本核對新 player。帶入但未排到座位時 wholeBalance 使用 inPlay，不會再扣款。
- host 座位寫入：Rules:109–124 buyinSeatOk 核對成員、空席、不得重複 uid、amount 與帳戶相等、session、nightKey、startAt ±10 分鐘；Rules:170 rev+1，:185–194 限事件以外席位／sess 不變、moneyOk:151–162 對帳。並無「禁止第三人」條件。
- 同時入座的舊 rev 與未回復引擎可使第二人看不到入座，並阻擋第三人／後續 leave；已用 fake adapter 重現並修復。presence 為背景心跳，不是入座前置授權。
- intents 尚未建立時原本 optional send 靜默成功；現在明確提示連線準備中，避免把沒有送出的 SIT 當成功。

## d 觀戰移除位置

- lobby.js:236、264–274、285–302：移除「已滿，可觀戰」與「觀戰」入口；滿桌按鈕 disabled，patch 更新時同步 disabled。
- room.js:436、479：房號／清單加入滿桌時阻擋未在座者；原在座玩家可重連。mp-app room snapshot 再防滿桌競態，回大廳提示。
- mp-app：移除牌桌 meta 觀戰人數；本人未入座名稱改「請選位子」；操作列沿用 mp-spec 提示點空位入座；成員面板改「尚未入座」。保留既有空位按鈕與房主自動入座流程，未增加對話框、按鈕或 CSS。

## 檔案、驗證、剩餘

修改：js/net/{host,ledger,room}.js、js/ui/{lobby,mp-app}.js、test/host-deadline.test.js。新增：test/fix1109.test.js、firebase/fix1109.rules.test.mjs、本報告。路徑均在 poker/。PM 的 PROD-EVIDENCE-930.md 與原有未追蹤 node_modules 未修改。

Rules 是否改動：**否**。`git diff -- poker/firebase/firestore.rules` 為空，沒有規則 diff 或部署。

實際命令與結果：
- 新增單元測試先紅後綠；`cd poker && node --test --test-isolation=none test/fix1109.test.js`：8/8 通過（含載入順序、寫入失敗還原、同時入座、滿桌入口、closeAll 缺綁定、滿桌房號、七文件正常 payload、收桌中 SIT）。
- 最終 `cd poker && node --test test/*.test.js`：35 個測試檔通過、1 個檔案失敗（runner 以檔案彙整）。
- 最終 `node --test --test-isolation=none test/*.test.js`（poker/）：255 項，254 通過、1 失敗。既有 test/raise-confirm.test.js:87 建本機 HTTP listener 遭 `listen EPERM 127.0.0.1`；未修改該測試，沒有宣稱全綠。相同環境錯誤已重複確認，停止重試。
- `node --check poker/firebase/fix1109.rules.test.mjs`、`git diff --check`：通過。
- Rules 測試未執行；固定 projectId=demo-fix1109，只接受 FIRESTORE_EMULATOR_HOST=localhost/127.0.0.1:port，載入正式原檔不替換規則。包含兩人零手數 closeAll 成功、第三人完整 grant/buyin/seat 成功、房主任意移動別人的錢拒絕。

回歸範圍：M，受影響為大廳開桌／加入、買入入座、房主寫入鏈、收桌、未入座提示；單元已執行，手機 Safari／桌機手動端到端與 Rules emulator 尚未執行，留 PM／QA，並非自行驗收通過。無 preview URL。剩餘估計：PM emulator＋雙裝置重現驗證約15–25分鐘，若正常兩人 closeAll 仍遭拒，需伺服器 trace 才能估算後續修正。

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

## 單桌＋0.2秒（第二輪）

本輪只在 pm/fix-1109-trial 本機修改；未 commit、push、部署、安裝依賴、修改任何 Rules 或 PROD-EVIDENCE-930.md。使用者本輪需求為行為授權，沿用既有 UI／選位提示。

設計：開新牌桌先同步 toast，再用既有 pokerLobby 查詢（status in lobby/playing、createdAt 升冪、limit 20）找最早一桌。有桌就經既有 joinByRoomId 加成員，再進桌，不開表單；沒桌才開表單。表單提交再查一次；建立完成後再查一次，若有更早一桌，以交易確認自己新桌仍無座位才關閉，再清理清單／房號／hostRoomId，加入較早一桌。若已有入座則保留原桌，避免中斷帳務。大廳只顯示首桌入口，有桌不顯示開新牌桌；移除房號輸入與其死碼，分享、網址及訂閱拒絕後的房號加入保留。收桌確認原本已有同步 disabled＋「收桌中…」，未改其行為。

**限制：這是盡力收斂，不是站台嚴格單桌保證，TASK 1 的嚴格要求尚未完成。** 兩個建立者若各自在對方提交前完成事後查詢，仍可能留下兩桌；查詢只涵蓋既有 lobby/playing 公開清單，無法發現沒有清單的舊 open 桌。並行單元測試只證明指定交錯順序能收斂。沒有證明所有現行規則相容鎖定設計均不可能，不將以下限制冒稱為完整不可能性證明；嚴格方案仍須另輪研究／PM 決策。

Rules 行號（正式檔案未改）：
- 294–324 createLobbyRoomOk：新房需空席、零籌碼、本人 host、同批 code 指向 room、player.hostRoomId 指向 room；沿用 createRoom 原交易及 grant。
- 225–234 isJoin：僅增加本人至 members；既有 joinByRoomId arrayUnion 沿用。
- 371–385：非成員只能 get lobby/playing，不能 get 已關閉文件／不存在文件；delete=false。這阻擋直接 tx.get 永久固定房間 ID 後重新 create 的方案，已關閉文件也不能重建。
- 432–462 pokerCodes：signedIn 可 get；更新須過期／房間不存在／已關閉，或房主僅延長 expiresAt；固定房號可重用，但其開桌到期後也可被覆蓋，不能單靠這條規則宣稱全站唯一。
- 468–494 player create：同批 grant 與 room 成員關係；本輪沿用既有寫入。
- 693–716 pokerLobby：登入可 get；list 限 20 且 lobby/playing；create 須同批房間 host，update 僅房主且保留 createdAt；close 清理可由房主 delete。新查詢與空桌收斂沿用這些合法操作。規則沒有全站只能建立一桌的條件，各自 host/code/room 的交易仍可各自合法。

檔案：js/net/room.js、js/ui/mp-app.js、js/ui/lobby.js、test/open-speed.test.js、test/fix1109.test.js、test/appendix-m.test.js、新增 test/ui-response.test.js、firebase/fix1109.rules.test.mjs、本報告。

測試與命令（實際執行）：
- `cd poker && node --test --test-isolation=none test/*.test.js`：269 項，268 通過、1 失敗；既有 raise-confirm 本機 HTTP listen EPERM 127.0.0.1。沒有宣稱全綠；相同環境錯誤已達停止重試門檻。
- 最後補強空桌關閉為交易後，另跑 `node --test --test-isolation=none test/ui-response.test.js test/open-speed.test.js test/fix1109.test.js test/appendix-m.test.js`；結果見下方。
- 注入 300ms 網路延遲，真實 onCreateTable 兩分支／收桌確認 click 處理器首次回饋實測分別 0.668／0.557／0.908 ms，皆同步、網路未完成且 <200ms。此為 fake DB／UI callback 時間，不是實機繪製驗收。
- 速度 A/B/C/D 實測 1/4/2/10：A 新增建表前查詢 1；B 新增提交前與建立後查詢 2；C 不變。D 與指定 9 次基準不符：舊 harness 搜尋 async function seatPlayer，但先前座位修正已改成 function seatPlayer＋seatPlayerInner；修正 harness 才真正執行最新入座前的 room getDoc，多 1 次，並非本輪新增進桌操作。保留實測 10 的斷言，明列此項需求偏差，不用 stub 隱藏必要讀取。
- Rules 新增實際 createSingleTable 建立／加入／收桌後重開／並行收斂 assertions；projectId 固定 demo-fix1109，只接受 localhost emulator。`FIRESTORE_EMULATOR_HOST=127.0.0.1:8295 node --test firebase/fix1109.rules.test.mjs` 及加 `--test-isolation=none` 的診斷執行皆失敗；精確原因 connect EPERM 127.0.0.1:8295，初始化載入規則即遭環境拒絕，測例未執行、未清除資料。相容性尚無 emulator 通過證據。
- `node --check poker/firebase/fix1109.rules.test.mjs`、`git diff --check` 通過；Rules diff 為空。

回歸 M：單元涵蓋開桌／加入／空桌收斂／房號移除／選位提示／收桌同步回饋及既有受影響測試；桌機／手機手動端到端未執行，仍由 PM 按 M 範圍驗證。無 preview URL；未自行驗收。剩餘：嚴格並行唯一設計、emulator 實跑及雙裝置手動驗證；估需另輪 20–40 分鐘（嚴格方案可行性未定）。

最後受影響測試結果：37/37 通過（包含交易關閉空桌後的重跑）。

## 第三輪：嚴格單桌鎖＋頭像統一

### A：規則衝突，暫停待 PM／owner 決定

本輪要求固定 6 碼 `SINGLE_TABLE_CODE`、沿用現有 createRoom 的 lobby 格式，且 Rules 不變。但實際 `firebase/firestore.rules:315` 的 createLobbyRoomOk 僅允許 `[0-9]{3}`；:322 要求同批 code 文件指向新房間。:341–367 的 6 碼相容分支僅接受 status=open、且欄位白名單不包含 lobby，不能用來承接現有 lobby 建房格式。codeDigitsOk（:71）與 pokerCodes（:432–464）接受 3／6 碼，不代表房間建立也接受 6 碼。

已依 AGENTS.md「Ambiguity → stop and report」暫停 A，詢問是否改用固定 3 碼；本輪暫試的 A 修改已撤除，第二輪未提交內容保留。尚未替換 best-effort convergence、尚未更新 rules 測試及 open-speed 預期。現有並行收斂測試通過仍不是嚴格唯一保證。

待確認後的設計：保留 legacy pokerLobby 最舊桌預查；讀固定 code，交易外判定其房間可讀且開放則 joinByRoomId；否則交易第一筆 tx.get(code)，核對 absent／先前 roomId 及到期時間，再原子寫 room/code/lobby/player（新帳號含既有 grant）。鎖變更則回讀並加入勝方；不在交易內讀非成員無法讀取的關閉房間，移除建立後收桌遷移。Rules :433–444 的 codeOk 核對同批 room.code/hostUid 與 24h±10m；:446–455 的 codeReclaimable 由伺服器判定 expired／missing／closed。

到期風險：code 為 24 小時有效。`js/net/room.js:555` extendCode 可延長；全專案唯一呼叫是 `js/ui/mp-app.js` 的 mpExtendCode（手動選單操作），沒有自動續期。固定碼桌開超過 24h 且未手動延長時，若 listing 預查沒有找到該桌，鎖可被回收並建立第二桌；不能宣稱無期限嚴格唯一。A 尚待核准與實作，因此本輪開桌等待預期維持第二輪 A=1、B=4、C=2、D=10，不捏造新鎖量測。

### B：所有既有自身頭像統一入口

- 大廳 header：onAvatar 直接傳同一個 openStats。
- 大廳牌桌列的房主縮圖：加入 hostUid 標記；本人點擊攔截並呼叫 openStats，其他房主維持進桌行為。
- 牌桌：本人座位頭像、底部 heroAv（含進桌 shell／未入座、尚無 uid 標記）均走 openStats。
- 個人紀錄頁：總籌碼與單晚列表的本人頭像走 openStats。既有 stats 頁仍渲染。
- 建立表單、分享頁、加入頁、收桌／結算卡目前沒有自身頭像；未新增頭像或 UI。牌桌上方沒有另一個自身頭像。js/ui/app.js 為單機座位／玩家設定頭像，沒有登入使用者身分，不擅自改為多人個人紀錄。
- 其他玩家座位／紀錄列表頭像維持 openStatsFor 的原有浮層。待 PM 確認：owner 的統一要求是否未來也要涵蓋其他玩家？本輪依明確指示保持原行為。

本輪實際修改檔案：`js/ui/mp-app.js`、`js/ui/lobby.js`、新增 `test/avatar-stats.test.js`、本報告。其他第二輪檔案保留。未修改 PROD-EVIDENCE-930.md、Rules、依賴或憑證；無 commit／push／部署／對外網路操作。

### 實際驗證與範圍

- `cd poker && node --test --test-isolation=none test/*.test.js`：281 tests，280 pass、1 fail；唯一失敗為 raise-confirm.test.js 的 localhost listen EPERM（環境限制）。既有 stats 測試通過，未宣稱全套全綠。
- `cd poker && node --test --test-isolation=none test/avatar-stats.test.js test/ui-response.test.js`：18 tests 全通過；其中新增頭像測試 12 項。
- 重跑 ui-response 的首次同步回饋：尚無牌桌 0.644 ms、已有牌桌 0.532 ms、收桌確認 1.010 ms；注入等待 300 ms。這是本機函式／stub 量測，並非 Safari 實際繪製或正式網路延遲。
- `git diff --check`：通過。
- 回歸涵蓋：頭像點擊共用入口、本人與他人分流、既有 stats 兩模式渲染、開桌／進桌既有單元測試。未執行手動瀏覽器／桌機與手機端到端回歸，未自行驗收；仍由 PM／QA 依正式規模處理。沒有啟動或連線 emulator，rules 測試未執行。
- Preview URL：無。A 剩餘：碼位決策後實作鎖、可控並行競態與關閉回收測試、rules 測試更新及等待量測；預估另需 15–20 分鐘，不含 emulator／PM 手動回歸。

## 第四輪：固定碼 000 嚴格單桌

依 PM 明確核准的 3 碼 `SINGLE_TABLE_CODE = '000'` 實作 TASK A；本輪只處理 A，不增加 UI／功能。分支 `pm/fix-1109-trial`、起點 `60d9e4e`。未 commit／push／部署、未修改 Rules／依賴／憑證、未連網。原有未追蹤 PROD-EVIDENCE-930.md 與 node_modules 保留未動。

實作：保留 legacy pokerLobby 最舊開放桌預查；找不到才在交易外讀取 `pokerCodes/000` 及所指房間。房間可讀且開放則沿用 joinByRoomId，加成員後以既有 existing 路徑進桌及選位提示。其餘情況沿用 createRoom 的原子 room/code/lobby/player 寫入，新帳號同批寫 grant。交易第一筆必為 tx.get(code)，核對仍不存在，或 roomId 與先前判斷可回收的鎖相同且 expiresAt 未變；變更則不寫入，回讀鎖並加入勝方。交易不讀鎖所指的非成員關閉房間；回收是否合法由既有 codeReclaimable 規則判定。移除建立後查詢、關閉多開空桌及遷移的收斂流程。原 createRoom 的 hostRoomId 檢查與一般建桌 API 保留。

單元覆蓋：無桌建立、已有 legacy 清單桌加入不建立、固定碼開放桌無 listing 時仍加入、兩人均完成無桌／無鎖預讀後交錯交易（同 roomId、只建立一個房間、每筆交易首讀 000）、前桌關閉且非成員讀取被拒時回收固定碼（不在交易讀舊房、新帳號 grant 同批建立）。沿用既有測試檔，沒有新增回歸腳本。Rules 測試更新 create/join/concurrent/reclaim-after-close，含新帳號回收舊房及並行後實際 room 文件總數等於 1，projectId 仍固定 demo-fix1109。

A/B/C/D：**1／4／2／10**（0ms 與 2ms 注入延遲皆相同）。A 為開表單前 legacy 清單查詢 1 次；B 為提交時 legacy 清單查詢＋固定碼讀取＋player 預讀＋交易，共 4 次。第二輪的建立後查詢改為建立前固定碼讀取，所以 B 總數維持 4；並非省略鎖成本。C/D 未改進桌與入座流程，仍為 2／10。交易算一趟，交易內讀取／SDK 自動重試未另計；不是實機網路量測。

實際命令與結果：
- `cd poker && node --test --test-isolation=none test/ui-response.test.js test/open-speed.test.js`：16/16 通過。
- `cd poker && node --test --test-isolation=none test/*.test.js`：283 項，282 通過、1 失敗；唯一失敗為既有 raise-confirm.test.js:87 的 `listen EPERM 127.0.0.1` 環境限制。不重試此已知錯誤，不宣稱全綠。
- `node --check poker/firebase/fix1109.rules.test.mjs`、`git diff --check`：通過。未執行 Rules emulator，遵守本輪不連網限制。

本輪修改：`poker/js/net/room.js`、`poker/test/ui-response.test.js`、`poker/test/open-speed.test.js`、`poker/firebase/fix1109.rules.test.mjs`、本報告。

回歸範圍 M：已執行指定全套單元及受影響開桌／加入／選位／入座／收桌單元；未做桌機／手機手動端到端，未自行驗收。Preview URL：無。既有 24h 到期風險仍在：若開放桌無 listing 且其房間無法讀取，過期鎖可由規則允許回收；固定碼是本用戶端的交易協調，不是 Rules 對所有舊用戶端施加全站唯一限制。剩餘為 PM／QA 本機 emulator 與手動端到端驗證，估 15–25 分鐘；本輪程式與指定測試更新已完成。

## 第五輪：iPhone 回報四項

本輪依宗良回報與使用者明確授權，於 `pm/fix-1109-trial`（基底 `0a3b8a9`）僅做本機修改；未 commit、push、部署、安裝依賴或修改 Rules／憑證，未使用外部網路。`PROD-EVIDENCE-930.md`、`test/_reg1109.local.mjs` 均未修改。

### 1. 大廳本人頭像與個人紀錄

- 已核對實際路徑：`renderMpLobby()` 的唯一可見 `.mp-av[data-act="avatar"]` → `wire()` 對該 button 註冊 click → `avatar: onAvatar` → `mp-app.js` 傳入 `onAvatar: openStats`。名稱及傳參正確；不是漏接 handler。`wire()` 是逐元素 click 綁定，只有進桌清單另外使用事件委派。
- 可由原碼與測試確認的根因：`openStats()` 先把狀態設成 stats，卻等 `loadStats()` 的 Firestore 查詢結束才 `paint()`；查詢未返回時，畫面仍是大廳，點擊看起來無效。另外 `ensureOpenTablesListen()` 每筆快照都整頁 `paint()`，重建包含頭像的 DOM；若發生在手機按下與 click 之間，原點擊節點會被替換。現在進入 stats 立即繪製，資料回來僅在仍是 stats 時更新；一般清單快照改用既有 `patchOpenTables()`，保留頭像節點。單桌由無到有／有到無仍完整更新，以同步既有開桌入口。
- `openStats()` 無 early return；清單快照本來就有 `screen !== 'lobby'` 保護，沒有把 stats 設回 lobby。已驗證點擊後接快照及實際 `paint()` 仍維持 stats。沒有把此問題誤改成 `openStatsFor()`：前者是「個人紀錄」，後者是「我的戰績」浮層。他人頭像開對方浮層的既有行為保留。
- 原碼檢查：頭像在 header grid 第一欄、選單按鈕在第五欄；選單預設 hidden 且 visibility:hidden，未找到重複主頭像、覆蓋頭像的定位規則、或吞掉該頭像 click 的 touch/preventDefault handler。這些是原碼檢查，未在 owner 的 iPhone Safari 上量測 hit-test，也沒有該次實機事件 trace；不宣稱已證實那一次實機點擊的確切時序。

### 2–4. 分享頁與牌桌選單

- 分享頁移除大房號框與「或在大廳輸入房號。房號 24 小時有效。」；保留既有「點連結加入」、分享／複製連結與進桌操作，無新增文案。
- 牌桌選單移除「延長房號 24 小時」、「複製房號連結」，連同 `mpExtendCode`、兩個 click handler 與不再使用的 import 一併移除。
- 房主沿用 presence 既有計時器，進桌立即檢查，之後最多每分鐘讀取一次房號效期；距到期不足 12 小時時，使用既有 `extendCode()` 更新至目前時間加 24 小時。檢查目前房主身分、房間仍開放、code 指向同一房間；讀寫失敗不打斷牌局，下次檢查再試。沒有新增 UI 或計時器，沒有修改 Rules。
- `createSingleTable()` 既有交易外房間檢查已不受 code 效期影響：即使 000 過期，只要鎖指向房間仍開放就加入，不回收。本輪新增執行測試固定此契約，未改動已正確的建立流程。
- 剩餘風險：房主缺席、裝置休眠／背景被 Safari 暫停、離線或續期寫入遭拒超過 24 小時，無法由房主客戶端保證續期。此時房號連結可能判定過期；本版開桌流程仍會加入開放中的鎖，但既有 Rules 允許回收過期碼，其他舊版客戶端仍有覆寫風險。

### 檔案與實際驗證

修改 `js/ui/lobby.js`、`js/ui/mp-app.js`、`js/net/presence.js`、本報告；新增 `test/fix1109-round5.test.js`。未新增回歸腳本；依本輪明確要求新增既有 node:test 格式測試。

- `cd poker && node --test --test-isolation=none test/fix1109-round5.test.js`：4/4 通過。涵蓋實際 renderer 產生的主頭像及實際 click handler、網路未返回立即繪製、後續快照／paint 維持 stats、刪除 UI／文字、房主進桌及週期續期／非房主／收桌不續期、過期但開放的 000 鎖加入而不建立。
- `cd poker && node --test --test-isolation=none test/*.test.js`：292 項，286 通過、6 失敗；6 項全部為 `listen EPERM: operation not permitted 127.0.0.1`（收桌瀏覽器 4 項、大廳 idle 瀏覽器 1 項、raise-confirm 1 項）。無程式斷言失敗。日誌 `/tmp/fix1109-round5-tests.log`。
- `cd poker && env -u FIRESTORE_EMULATOR_HOST node --test --test-isolation=none test/*.test.js`：287 項，286 通過、1 失敗；剩 raise-confirm 的相同 `listen EPERM`。日誌 `/tmp/fix1109-round5-noemu.log`。
- `cd poker && env -u FIRESTORE_EMULATOR_HOST node --test --test-isolation=none --test-skip-pattern='solo: 點確認加注後引擎收到 BET_RAISE' test/*.test.js`：可執行範圍 286 通過、0 失敗，略過沙箱不能執行的 raise-confirm 案；emulator 瀏覽器群組未執行。日誌 `/tmp/fix1109-round5-available.log`。不將排除環境阻擋後的結果宣稱為完整全綠。
- `git diff --check`：通過。`git diff -- poker/firebase/firestore.rules`：空白。

回歸範圍：以 M 級受影響區域（大廳入口、個人紀錄、他人戰績入口、分享、牌桌選單、presence、單桌建立／加入）執行既有全套可用單元測試；未完成 iPhone Safari 手動端到端、瀏覽器／emulator 與 Rules 驗證，不代表 QA 驗收。未建立 preview URL。待 PM／owner 於既有 preview 複驗四項與他人頭像；本輪沒有自行審核或核准上線。

## 第六輪

- 範圍：依本輪四項指示；分支 `pm/fix-1109-trial`、基底 `2b7d213`。未 commit／push／部署、未修改 Rules 或 PROD-EVIDENCE-930.md、未安裝依賴、未使用網路。
- 修改檔案：`js/ui/mp-app.js`、`test/avatar-stats.test.js`、`test/fix1109-round5.test.js`、`test/close-result-lobby.test.js`、`test/fix1109.test.js`、既有未追蹤的 `test/_reg1109.local.mjs`、本報告。
- 本人頭像：大廳主頭像、本人房主縮圖、本人座位頭像與 `#heroAv`（含 shell／未入座無 uid）共用 `openOwnStats()`，同步呼叫 `openStatsFor(me.uid, 本人名稱)`，顯示 `.ps-sheet`。其他玩家座位仍使用其 uid；其他房主縮圖仍維持原本進桌行為。戰績選單仍呼叫 `openStats()`。未改個人統計樣式，保留第五輪一般快照 patch 清單、不重建大廳 DOM 的改善。
- 同步回饋證據：第五輪測試改用實際 `openPersonalStats`，在 load 被呼叫時即斷言 sheet 已渲染；讀取未完成及後續清單快照仍保留 sheet 與頭像節點。這是同步 DOM 單元證據，並非手機實際繪製毫秒數。
- emulator 測試：兩項原房號輸入案例改點 `[data-act="open-table"]`／現有「開新牌桌」入口（後者會加入既有 000 桌），保留 host／guest 離開後 clean lobby、帳戶結算、取消離桌，以及不 reload 再次加入與 joining 清除檢查。未刪除覆蓋。
- LEAVE 時機調查：`processIntent(LEAVE)` 立即入列並呼叫 `drainSitLeave()`；牌局中 `drainSitLeaveInner()` 對尚未 leftHand 的座位直接送 `LEAVE_FOLD`。引擎 `doLeaveFold()` 支援非當前行動者立即 folded，保留 contributed、當前 actor 與 deadline；輪到本人時走正常 fold 並推進。不依賴 away 或 TIMEOUT；結帳才等到手牌結束。全下者為既有例外，LEAVE_FOLD 不移除其攤牌資格，但也不會成為等待行動的 actor。
- 新增 host 路徑單元測試：三人桌收到非行動者 LEAVE 後，在 intent snapshot callback 返回前確認 folded、下注保留及 actor/deadline 不變；不推進時間、不送 TIMEOUT，讓其他玩家完成四個 street 到 showdown／hand_over，逐次確認 actor 不會是離桌席。測試通過，未修改 host／engine。先前 e2e 的「3 秒後 pub.folded=false」尚無法在此重現或判定原因，不能宣稱該次實際已蓋牌；仍需 PM 用更新後輪詢記錄核對 intent 接收、玩家是否全下及 pub 發布時序。
- 本機回歸程式（僅修改指定項目）：分享畫面檢查 000 前移除 `.mp-url` 連結文字；頭像以可見 `.ps-sheet` 判定並記錄 tapToSheetMs；離桌確認後最多輪詢 10 秒並記錄 foldedDelayMs。未執行該程式，未產生新的 e2e 毫秒數。
- 實際執行：`cd poker && node --test --test-isolation=none test/avatar-stats.test.js test/fix1109-round5.test.js`：16 項通過；`cd poker && node --test --test-isolation=none test/fix1109.test.js`：9 項通過。
- 指定完整命令：`cd poker && node --test --test-isolation=none test/*.test.js`：288 項，287 通過、1 失敗；唯一失敗為 `raise-confirm.test.js:87` 的 `listen EPERM: operation not permitted 127.0.0.1`，屬沙箱監聽限制。輸出保留在 `/tmp/fix1109-round6-tests.log`。未設定 FIRESTORE_EMULATOR_HOST，emulator 案例未執行。
- 另執行 `node --check poker/test/_reg1109.local.mjs`、`node --check poker/test/close-result-lobby.test.js` 與 `git diff --check`，均通過。
- 回歸範圍／風險：本輪涵蓋頭像入口、同步浮層、快照 DOM 保留、離桌 intent 與不等待離桌者的單元檢查，並執行完整既有測試命令；未進行人工桌機／手機回歸，未自行驗收或核准。PM 尚需執行兩項 emulator 案例與本機 e2e，確認實際 sheet 延遲、pub.folded 發布延遲及結算。無新增 preview URL。


## 第七輪：hands 計數

- 範圍：依本輪明確授權修復 hands、補既有測試；分支 `pm/fix-stacks-rules`、基底 `8cec6e2`。未 commit／push／部署、未使用網路、未安裝依賴、未修改 Rules 本體或指定保留的未追蹤檔案。未更動產品流程、畫面或樣式。
- 修改檔案：`js/net/host.js`、`test/fix1109.test.js`、`firebase/stacks-sim.rules.test.mjs`、`firebase/rules.test.mjs`、本報告。

### 原因與逐段追蹤

以下舊 host 行號以 `8cec6e2` 為準；Rules 與 ledger 未改，行號仍是目前版本。

1. **確定缺陷：成功標記在提交之前推進。** 舊 `host.js:267–275` 在房間已為 hand_over 時組 hands+1，但 `272` 已先改 `lastHandsBumpHandNo`；真正 `updateDoc` 在 `310`，`324` 只警告、吞掉拒絕，不還原標記。`scheduleNextHand:401–409` 只檢查已儲存的 phase／handNo 和這個記憶體標記；若第 2 手起的 bump 被拒，標記仍視為已完成，下一次計時器可開第 3 手，後續也不會補第 2 手。若只有第 1 次成功、其餘 bump 失敗，sess.hands 就會維持 1，而 stacks 結算仍可獨立成功。這個遺失／錯誤放行機制已用拒絕注入回歸涵蓋。
2. **規則文字沒有禁止「hand_over 不變、只改 hands」。** `firestore.rules:446–452`：lastMoneyEvent 不變且不是進行中→hand_over，就進一般分支；`isHostPubWrite:286` 的白名單不含 sess，所以 hands 變動須走 `isHostWrite:320–326` → `roomWriteOk:200–231`。stacks 不變符合 `nonMoneyStacksOk:93`；座位不變且每格只增加整數 hands 符合 `227–229`、`sessKeep:125–131`，chipTotal 不變符合 `230`。這一路徑也在語意上允許 hand_over→preflop 同時增 hands，只要 stacks 等條件保持；因此不能從規則文字斷言該組合必然拒絕。
3. **結算那筆明確不能帶 hands。** 進行中→hand_over 由 `isSettleTransition:291–294` 與 `450–451` 強制走 `isHostSettleWrite`，`312` 要求 sess 整份相同，`313–315` 做總額及逐席結算限制。因此把 hands 塞回結算那筆不可行。帳務事件另走 `221–224`，禁止動其他席的 sess／stacks。
4. **不是實際合併／去重佇列。** 舊 `queueWrite:232–246` 每個呼叫串在 Promise 後等待 250ms，再讀目前 engine／room；`242` 分支固定為 false，沒有按手號去重或取消。不同呼叫確實可能發布相同的最新 engine，或略過中間畫面。舊自動下一手正常情況會被 `401–409` 擋到 bump 分支執行，但它等待的是預先推進的記憶體標記，不是成功提交。一般 bump 的 patch 還會重建 pub／lobby（`279–307`），不是純 sess 寫入。
5. **首次拒絕的來源仍須實際 emulator trace 確認。** Rules 註解 `274`、`305` 已記載大型 pub 的完整比較可能超過 1000 運算式；舊 bump 必須走完整 `roomWriteOk`，因此有此疑點。但本輪沒有該次 permission-denied 的 emulator 評估記錄，且依指示不能連 emulator，不能宣稱已證實首次拒絕一定是運算式上限、下一手合併或某個特定 predicate。已證實的是：任何一次 bump 拒絕都會被舊 client 永久漏算；本輪修掉此機制並縮小 bump patch。真四人 e2e 是否完全解決，仍須 PM 重跑。
6. **最終統計來源就是 sess.hands。** `ledger.js:191,204,220`（單席結帳）、`279,292,306`（整桌結帳）將 sessRow.hands 寫入帳本，累加到 pokerPlayers.handsPlayed 與 nights/{night}.hands。Rules `618`、`686`、`730` 再對應帳本與 sess；因此上游 sess 少算會原樣反映到兩種統計，與籌碼總額守恆不衝突。

### 修正與安全界線

- `host.js:249–267`：在同一 writeChain 內，等房間已存成同一 handNo 的 hand_over，先獨立提交只有 `sess`／`rev`／`updatedAt` 的 patch。只對 uid 與 seatUids 相符的在座 sess 加 1；不帶 pub、stacks、chipTotal 或任何帳務欄位。這符合目前 Rules 的一般非帳務分支，不需改 Rules。
- `261–263`：await updateDoc 成功後才推進 lastHandsBumpHandNo。拒絕時停在 catch，原下一手計時器會在約一秒後再次排 queueWrite，成功之前仍停在 hand_over。後續 pub 寫入以已確認的 rev／sess 接續，避免等待快照回呼而送回舊手數。
- 原進行中 stacks 存檔點、結算逐席檢查、帳務只改事件席的限制全數保留；未放寬房主挪籌碼權限。成本：每手多一筆獨立 room update，之後原有 pub 更新照常進行。
- `rules.test.mjs:54–55`：START_AT 預設也改用 Timestamp.now()，不再把 serverTimestamp sentinel 放進 sess 陣列。仍是 Timestamp，符合 Rules `154–157` 的 request.time 正負十分鐘限制；原 `STARTAT=ts` 呼叫相容。結果輸出同步記錄實際使用的型別。

### 測試、回歸與待辦

- `test/fix1109.test.js:231` 新增真 host fixture：四人連打三手，逐手確認每席 hands 為 1／2／3、不重複增加，並自動開始第四手。第二手刻意拒絕第一次 hands update，阻擋重試回應時檢查仍停在第二手 hand_over、hands 仍為 1，放行後才進第三手。每次 bump 斷言 patch 僅有 sess／rev／updatedAt。fixture 補上第四位成員及可注入的 room 寫入攔截。
- `firebase/stacks-sim.rules.test.mjs:69–79,115–132`：等價於修正後 host 的「結算→純 hands bump→pub／ACK→下一手」寫入，六人連打三手、逐席驗 hands，重送 ACK 不重算，第四手能開始。每筆純 bump 用 assertSucceeds；同一 bump 若夾帶席 0 減 1、席 1 加 1（總額不變）用 assertFails。RULES_PROJECT 環境變數與預設 demo-fix1109 保留。
- 實際執行 `cd poker && node --test --test-isolation=none test/*.test.js`：290 項，289 通過、1 失敗。新增三手／拒絕重試測試通過；唯一失敗是既有 `test/raise-confirm.test.js:87` 的 `listen EPERM: operation not permitted 127.0.0.1`，無法在沙箱建立本機伺服器。完整日誌 `/tmp/fix1109-round7-tests.log`。首輪新增測試曾因 fixture 未列第四人成員失敗，補正後以上述完整命令重跑。
- 實際執行 `node --check poker/firebase/stacks-sim.rules.test.mjs`、`node --check poker/firebase/rules.test.mjs`、`git diff --check`：通過。Rules 測試未執行，不宣稱 ALLOWED／DENIED 已由 emulator 證實。
- M 級受影響區域：連續開手／結算／sess 計數／拒絕重試與既有完整單元測試。未完成桌機／手機人工端到端或 QA 驗收；沒有 preview URL。
- PM 待辦：在既有 emulator 設定下執行 `cd poker && RULES_PROJECT=demo-fix1109 node --test firebase/stacks-sim.rules.test.mjs`，以及 `cd poker/firebase && node rules.test.mjs`（後者沿用既有 8195／demo-poker 設定），再重跑原四人瀏覽器 e2e，核對 room.sess、cashout 帳本、玩家 handsPlayed 及夜間 hands。若舊 bump 仍可重現拒絕，保留首次拒絕的 emulator 評估錯誤以確認起因。斷線／接手跨程序的持久去重不在本輪新增設計範圍；沿用現有記憶體標記模型。

# 個人統計 FIRST ROUND Phase B 本機檢查點

M 級；PL：/workspace/poker-plan/personal-stats-data-proposal.md v1.0 §3–7、§10（自測及停止段 136–145 已讀）。原 LOG：/workspace/poker-plan/LOG.md；BD 版本原 LOG 待查，本輪不涉及外觀。使用者本輪明確授權本機 B 實作，優先於原規劃代理不實作的交接文字。
基底 87014f651ccc4e350705def0bdae1bd9f7057fd8；任務分支 pm/pr49-b1；僅保存本機未驗收檢查點，不推送。

## 本輪切片

新增最小摘要轉換、aggregate increments、注入式 Firestore adapter（三文件 batch：create-only 摘要、聚合、identity-only receipt）。現任 host 只讀 receipt，不讀私人摘要或聚合；receipt 必須由 Rules 與同批新摘要對帳。任意 permission-denied 不算成功。Rules 為候選且 statsEnabled=false，submitter 預設無 T0；未接正式 host，無新正式寫入。

新增裝置持久佇列介面及逐 uid recovery：成功確認才清理；清理寫入失敗保留原 rows；滿額保留舊資料、不覆蓋、不 TTL；顯式 wake、每批最多六 uid、指數退避上限 60 秒、空佇列無輪詢。既有 stats write-chain 可選注入 recovery，遊戲鏈不等待它。

## 實測與預算

TextEncoder(JSON.stringify(value)) UTF-8 實測：單 uid pending 795 bytes；六人 4,777 bytes；部分提交／重試 metadata 4,433 bytes；私人摘要 380 bytes。fixture 使用 40 字元 room、128 字元 handId、128 字元 uid（127 個中文字加尾碼）、安全整數邊界。
技術暫定 serialized 預算每項 8,192 bytes／裝置 524,288 bytes；六人 fixture 約可容 109 手，非保證手數，實際以 bytes 拒絕。保留約十倍單項餘裕。這不是舊版 4MiB／256 手建議的沿用。
localStorage UTF-16、JSON 副本、交易暫存預估至少 2–4 倍序列化成本；Firestore 文件／索引成本未實測，不能把上述 bytes 當實際帳單儲存。瀏覽器真實配額與 IndexedDB 未測；fake quota failure 已測。每 uid 正常路徑一筆 receipt server read、三文件寫；競爭／失敗另有 receipt read。Rules 文件讀／expression quota 尚未驗證，不宣稱 20 reads 或 1,000 expressions 通過。

## 實際命令與結果

- `node --test --test-isolation=none`（poker）：184 tests，171 pass、13 fail；失敗是缺 @firebase/rules-unit-testing／playwright。未安裝依賴，未連 emulator 或真實 DB。
- `node --test --test-isolation=none test/personal-stats-phase-a.test.js test/personal-stats-phase-b.test.js`：22 pass，0 fail（最後 write-chain 小幅接線後另重跑記錄見本輪回報）。
- `command -v firebase`、`command -v java`：無可用命令。Rules **UNTESTED**，沒有安裝或使用 production fallback。
- 兩次 shell 編輯曾因 cwd 多加 poker/ 前綴失敗；已改正，未改其他檔案。

## M 級回歸（不代表 QA 驗收）

| 項目 | 方法 | 結果 | 證據 |
|---|---|---|---|
| Phase A 身分、快照、不阻擋遊戲鏈 | 既有 unit | PASS | /tmp/pr49b-unit.txt |
| B 補送、部分成功、receipt 查重、容量／清理失敗 | 新增 unit（依使用者明確授權） | PASS | /tmp/pr49b-unit.txt |
| 全部既有自動測試 | 既有命令 | FAIL：缺套件 13 項 | /tmp/pr49b-tests.txt |
| 本人／host／外人／舊 host Rules 隔離及 quota | emulator | UNTESTED | CLI、Java 缺少 |
| M 受影響區域手動端到端 | manual | 未執行 | 本輪限 fake adapters，不將 unit 當手動驗收 |

## 剩餘 B 與停止點

尚需 Rules emulator 實證（含跨帳號／並發／失權／aggregate 不合法改寫／文件存取及 expression quota），receipt 的角色隔離不可視為已驗證。需固定正式 T0 的 Rules 常數，不能直接啟用候選；目前 false 為明確停用。
尚需真瀏覽器配額／保存失敗、裝置分區、最大 payload 含 SDK transforms／Firestore encoding-index 實測；前景／回線事件接線及跨 host 遠端已保存 pending 尚未實作。本機副本只可於同裝置恢復，receipt 不含可恢復摘要；不宣稱跨裝置 pending 已完成。
未動 Phase C／UI、帳務、共享引擎、安全以外既有 Rules；未部署／合併／push／commit／接觸憑證。無 preview。停止本輪，整體 B 未驗收；後續估計需另輪實作及具 emulator 的驗證環境，不能據本輪推估上線時程。

## PM 獨立核實與停報（2026-11-08，台北時間）
1. 完成首輪候選切片；獨立完整測試 184 項：171 通過、13 因缺套件失敗；證據 /workspace/pr49b-tests.tap。A/B 指定 unit 22 通過、0 失敗，證據 /workspace/pr49b-unit.tap。
2. 決定：完整測試未通過、Rules 未測，不推送；僅本機 commit 保留檢查點，既有 pm/pr49-a-fix/985554e 完全保留。
3. 不把 Codex 完成訊息視為 B 驗收；候選使用 atomic batch + increment + Rules 而非讀私人聚合 transaction，須 emulator 驗證等價原子去重。
4. 不合併、不部署、不連真實 DB、不啟用 T0、不做 C/UI；無 firebase CLI、Java，不以 production fallback。
5. 未完成：Rules 隔離及 quota、固定 T0 規則、回線/前景喚醒、跨 host 遠端 pending、真瀏覽器配額/儲存成本與最大合法 ID 邊界確認。注意目前 handKey 用 JS length、Rules size，Unicode 長度一致性待測；localStorage 多分頁競爭亦未驗證。
6. 接手先讀此 LOG、spec v1.0、submission.js/bounded-queue.js/firestore-adapter.js；下一輪先補隔離環境依賴，勿直接推本檢查點。遠端核實仍為 87014f6。估剩餘 B 約 30–45 分鐘另含環境準備，分輪另授權。

## Phase B 第二輪檢查點（2026-11-08）

基底仍為 ed88b0e，pm/pr49-b1；未 commit。使用者明確授權本輪 NEW unit/emulator assertions；未新增回歸腳本或修改既有測試。BD 版本仍未記載，本輪不涉及外觀。

變更：handKey 對 %／_ 做可逆跳脫後組合，Rules 使用同一算法，移除 JS length／Rules size 的身分依賴。佇列每次操作重新讀取儲存，瀏覽器透過 Web Locks 序列化讀改寫；無 Web Locks 的 shared localStorage 拒絕操作，不冒險覆寫。fake lock／兩佇列實例測試通過，真多分頁瀏覽器尚未測。

新增 test/personal-stats-phase-b-round2.test.js 四項測試；firebase/stats-phase-b.test.mjs 十三項子案例（owner 私人讀、host 三文件寫、非 host／外人拒絕、host 被替換後拒絕、create-only／並發去重、缺 aggregate／receipt 原子拒絕、偽造增量／receipt、Unicode／跳脫、長度／額外欄位、無機會成功拒絕）。僅 demo-poker，要求明確 localhost FIRESTORE_EMULATOR_HOST，僅在記憶體將 statsEnabled false 換為 true；正式檔案仍 false，未啟用 T0。

實際命令／證據：
- `node --test --test-isolation=none poker/test/personal-stats-phase-b-round2.test.js`：4 tests／4 pass／0 fail（本輪新跑）。
- A+B+新 unit（含 isolation=none 版本）：尚未完成，輸出停在既有 B capacity 案例之前；不能報整組通過。證據 /tmp/pr49b-round2-unit.tap、/tmp/pr49b-round2-unit-direct.tap、/tmp/pr49b-round2-b-only.tap。容量案例單跑亦未完成，停止重試。
- 以 PATH 前置 /home/box/.local/jdk/bin 的 Java jar 啟動 localhost:8296／demo-poker emulator：失敗，SocketException Operation not permitted（沙箱禁止 socket）；證據 /tmp/pr49b-round2-emulator.log。未連任何真實 DB。
- `git diff --check`、`node --check poker/firebase/stats-phase-b.test.mjs`：exit 0。

M 級回歸：新增 unit 局部通過；既有 A/B 整組未完成；Rules emulator 未執行；受影響區域手動端到端未執行。不是 QA／驗收通過。Rules reads／expressions 預算未量測；Unicode Rules replace／size 必須由 coordinator 實跑確認。失權案例定義為 hostUid 被替換，未加入新租約／過期政策。跨 host 遠端 pending、真瀏覽器容量與成本等前輪缺口仍保留。coordinator 啟動 demo-poker 本機 emulator 後可執行 `FIRESTORE_EMULATOR_HOST=127.0.0.1:<port> node --test firebase/stats-phase-b.test.mjs`（poker 目錄）；不與其他 Rules 測試同時覆寫同個 emulator 的 Rules。

依本輪 7 分鐘上限停報；剩餘為 coordinator 完整 unit／Rules／e2e、定位既有 capacity 停滯，以及上述手動／額度實證，無可靠驗收工時估計。產物僅 /tmp，未加入版本控制；無 preview，未部署／merge／push／commit，未動 C/UI／正式啟用常數。

## PM 第二輪停報（2026-11-08 08:45 台北時間）
1. 免費工具完成：Temurin JRE 21.0.13、firebase-tools 13.35.1（既有 runner 固定使用 13.20.2）、Playwright 1.49.0/Chromium 131；本 worktree 獨立 npm install，未動 pr43 依賴。apt HTTP 來源失敗，改使用原核准官方 Temurin 下載。
2. B 新增 Unicode handKey 與 Web Locks 候選、4 unit、13 Rules 子案例；既有 Rules 142/142、新 B Rules 14/14（含父案例）通過，僅 demo-poker localhost。
3. 完整單元 187 項：108 pass、0 assertion fail、79 cancelled，於 B capacity/quota 案例卡住後由 120 秒 timeout 停止；A/B targeted 26 項：23 pass、3 cancelled。基底 87014f6 同命令 177/177 pass，所以不能歸咎既有基底，B 新增停滯未解。Codex、完整及 targeted 均遇同處停滯，遵守三次同錯停止，不再重試或修改。
4. 僅一局六人 demo e2e 嘗試，150秒逾時停於 sitGuest，未到攤牌，未重跑；無法判定是否既有問題。另 e2e/layout 會跑多手，依僅一局六人限制未跑。未合併部署、未寫正式 DB、未啟用 T0、未做 C，不推送。
5. 剩餘：B capacity/Web Locks 停滯、六人 e2e、跨 host pending、前景/回線喚醒、真瀏覽器儲存與 Rules quota。估另 30–45分鐘及環境診斷，不自動續輪。
6. 證據 /workspace/pr49b-round2-{unit-noisolation,targeted,b-rules,rules,6p}.log，基底 /workspace/pr49base-round2-unit.log。遠端仍 87014f6，原 985554e 保留；本次僅保存未驗收本機 checkpoint。

## Phase B 第三輪：僅 capacity／quota 停滯修正（2026-11-08）

依使用者明確復工授權，套用 implement-approved-spec／regression-check；M 級，PL v1.0，無 C/UI 變更。任務分支 pm/pr49-b1；本輪 HEAD a2002ff58d7adcaf083ee6b5418e5049db6017b6，未 commit。

修改前先追根因：Node v24.22.1，原 capacity 案例用 `node --test --test-isolation=none --test-timeout=3000 --test-name-pattern='B capacity' test/personal-stats-phase-b.test.js` 重現 0 pass／0 fail／1 cancelled（3000ms timeout），證據 /tmp/pr49b-third-repro.tap。注入 Promise 鎖與 navigator.locks 最小比較顯示：兩者同步 throw 都會 reject 當次 request，並非當次 Promise 不回應；但原生鎖同步 throw 後下一次同名 request 超過 100ms 仍 pending，注入鎖可取得。改成 async throw 後，原生與注入鎖皆可再次取得。因此停滯發生在 quota 例外之後的 list，根因為原生鎖同步例外未釋放鎖。

最小修正：bounded-queue.js 的鎖內 run callback 改為 async，讓 reload／operation 同步例外成為 Promise rejection，保留錯誤傳遞與舊 pending。新增一項 unit，對注入與原生鎖驗證 dequeue 配額失敗後 list 可返回且舊資料保留，恢復 storage 後可成功清理。未重構或新增腳本。

實際命令／結果：
- 最小比較：`node --input-type=module` heredoc（注入／原生、同步／async、再次取得同名鎖）；另 `node --test --test-isolation=none --test-timeout=3000 /tmp/pr49b-lock-repro.test.mjs` 確認 runner 內當次 reject，1 pass。/tmp 為一次性診斷，非 repo 回歸腳本。
- 紅燈：`node --test --test-isolation=none --test-timeout=3000 --test-name-pattern='B quota rejection releases' test/personal-stats-phase-b-round2.test.js`，exit 1，0 pass／0 fail／1 cancelled（3000ms timeout），/tmp/pr49b-third-red.tap。
- 綠燈：`node --test --test-isolation=none --test-timeout=3000 test/personal-stats-phase-a.test.js test/personal-stats-phase-b.test.js test/personal-stats-phase-b-round2.test.js`，exit 0，27 pass／0 fail／0 cancelled，/tmp/pr49b-third-green.tap。
- 完整：`node --test --test-isolation=none --test-timeout=10000 test/*.test.js`，exit 1，188 tests／187 pass／1 fail／0 cancelled／0 skipped，/tmp/pr49b-third-full.tap。唯一失敗為 test/raise-confirm.test.js:87，listen EPERM 127.0.0.1（沙箱拒絕 socket），未重試，不宣稱全綠。
- `git diff --check`：exit 0。

| M 回歸項目 | 方法 | 結果 | 證據 |
|---|---|---|---|
| A 身分／快照／獨立鏈與 B 補送／容量／quota | unit | PASS 27/27 | /tmp/pr49b-third-green.tap |
| 完整既有 unit | 既有命令 | FAIL：187 pass、1 EPERM fail | /tmp/pr49b-third-full.tap |
| 受影響區域手動／六人 e2e | manual | 未執行，使用者指定 coordinator 執行 | 無手動通過證據 |

僅變更 bounded-queue.js、round2 unit 與本 LOG。未連 production DB／網路、未動 Rules／C/UI／憑證，無 deploy／merge／push／commit／雲端代理，無 preview。剩餘：coordinator 在可監聽環境驗證完整 unit，依授權執行基底及 B 各一局六人；真瀏覽器配額／跨頁鎖、Rules quota、跨 host pending 等既有缺口不在本輪驗收。重跑 unit 估 1 分鐘內；瀏覽器／Rules／e2e 時間依 coordinator 環境，未估整體 B 完工。完成本輪後停止。

## PM 第三輪獨立核實與停報（2026-11-08 08:53 台北時間）
1. 宗良授權先修容量及六人一局。本輪容量根因及 red/green 見上段；獨立完整 unit（--test-isolation=none --test-timeout=10000）188/188 pass，0 fail/0 cancelled，證據 /workspace/pr49b-round3-unit.log。
2. 鎖內 callback 改 async 是最小修正，保留 quota 失敗及既有 pending，不吞錯；新增原生/注入鎖 quota 後讀取/清理回歸。
3. 六人情境各只試一次：未改基底87014f6於120秒 timeout，停 guestDiag；B於180秒 timeout，停 joinViaLink，兩者皆未攤牌。基底 firestore-debug.log 證實舊 room update L353 已碰1000 expressions上限，另有既有 player create/update evaluation errors及 emulator ArrayIndexOutOfBoundsException。這證明失敗非 B 才出現，未完全排除環境因素，不把單一 Rules 訊息冒稱唯一 e2e 根因。依授權不修既有 app/rules。
4. 同輪既有 Rules142/142、新B Rules14/14（含父案例）皆pass；全部 localhost demo-poker，B只在測試記憶體啟用，正式statsEnabled/T0維持停用。證據 /workspace/pr49b-round3-rules.log；e2e證據 /workspace/pr49{base,b}-round3-6p.log。
5. 六人未通過所以不push，不合併部署、不寫正式DB、不做C。遠端核實仍87014f6，原985554e保留。本輪只本機commit未驗收checkpoint。
6. 接手：容量已解；先決策是否另案修基底六人Rules/環境。B仍欠跨host遠端pending、前景回線喚醒、真瀏覽器容量/多頁、Rules quota測量。估B另30–45分鐘，基底六人診斷另計；本輪完成即停，不自動續輪。

## Phase B ROUND4 檢查點（2026-11-08）

使用者明確 GO／implement-approved-spec／regression-check；本輪上限 8 分鐘／30 shell calls。HEAD 2835d8d，分支 pm/pr49-b1，未 commit。PL v1.0 §5–7、§10；M 級，BD 無視覺變更，本輪不做 C/UI。六人 e2e 使用者豁免；不修改舊 app。

### 四項狀態（候選實作，不代表 QA 或整體 B 驗收）
1. **跨 host pending：部分完成。** 新增 opt-in createRoomPendingQueue／createStatsRoomRecovery；pokerRooms/{room}/statsPending/queue 每房間單文件，最多六 uid entries、序列化上限 16,384 bytes。transaction ACK 後才標 remotely-confirmed；恢復只用 getDocFromServer 並拒絕 cache／pending writes。遠端失敗保留本機；滿額拒新留舊、無 TTL。逐 uid receipt／提交確認後才清理。現任 host 明確 get/create/update 權限，禁止 list/delete；owner／member／外人／舊 host 無權讀寫 pending。僅允許最小結算白名單，不含私牌／流水，host 仍無私人 pokerStats 讀權。新增 emulator assertions 尚未執行，因此隔離與六 entry expression budget 未核實。這是停用中的 B 接口，不接正式 host。
2. **前景／回線：部分完成。** bindStatsWake 監聽 online、visible 的 visibilitychange，microtask 呼叫獨立 recovery，提供解除監聽；無 timer／輪詢，既有 backoff 保留。unit 驗證事件同步返回、hidden 忽略、解除；未接正式 host，沒有真瀏覽器事件證據。
3. **真瀏覽器 localStorage：待 coordinator。** 遵守已知 socket 禁止，不嘗試啟動瀏覽器／server。一次性診斷 /tmp/pr49b-round4-browser.mjs（未納 repo、非回歸腳本）已 node --check；Playwright route 攔截所有請求，只供虛擬 localhost 靜態來源，不開 server／不連 DB。檢查雙頁 Web Locks enqueue、reload、帳號 key 分區，以及實際 QuotaExceededError 保留原 pending。未執行，不宣稱真瀏覽器通過或真實配額數字。
4. **Rules read／expression quota：待 coordinator。** 未啟動 emulator、未量測，不能以 unit／靜態推算宣稱通過。新增六 entry Rules assertion；下載 coverage 後需檢視 evaluated expression 次數及 request trace 文件存取，與讀寫估算分列。coverage 若未提供可對帳的文件存取總數，該項仍未量得，不能宣稱低於 20。現有正常逐 uid receipt server read + 三文件 batch 是程式路徑估計，不是 Rules access quota 實測；remote enqueue 另有 transaction read/write、restore 一次 server read、cleanup transaction read/write（重試另計）。

### payload 與容量證據

/tmp/pr49b-round4-unit.tap：六 uid、128 字元 Unicode hand/uid 與安全整數邊界的遠端文件 8,473 UTF-8 bytes；40 字元 Unicode room 9,901 bytes；控制字元 JSON 跳脫極端樣本 18,265 bytes。16,384 是技術候選序列化預算，極端樣本須提早拒收，unit 已驗證未達六 slot 也可 byte-full 並保留所有舊待送。最初 8,192 假設造成測試 30 pass/1 fail，依 payload 實測改正後通過。不是保證六人所有合法邊界一定存得下。Rules 強制六 entry／欄位／長度結構上界，沒有 JSON UTF-8 長度原語；16KiB 由 adapter 強制，不能宣稱 Rules 精確強制 16KiB。Firestore 編碼／索引／SDK metadata 與多份成本未測；不冒稱此為實際儲存帳單或瀏覽器 quota。

### 實際執行與 M 回歸

| 項目 | 方法 | 結果／證據 |
|---|---|---|
| A 身分／快照／獨立鏈，B 既有補送／容量／鎖，ROUND4 ACK／滿額／喚醒 | unit：`node --test --test-isolation=none --test-timeout=10000 poker/test/personal-stats-phase-a.test.js poker/test/personal-stats-phase-b.test.js poker/test/personal-stats-phase-b-round2.test.js poker/test/personal-stats-phase-b-round4.test.js` | PASS 32/32，0 cancelled；/tmp/pr49b-round4-unit.tap |
| 新 B emulator assertions | `node --check poker/firebase/stats-phase-b.test.mjs` | 語法 PASS；Rules 執行 UNTESTED |
| 真瀏覽器診斷 | `node --check /tmp/pr49b-round4-browser.mjs` | 語法 PASS；瀏覽器 UNTESTED |
| diff 空白檢查 | `git diff --check` | PASS |
| 完整 unit／既有 Rules／B Rules | coordinator 獨立執行 | 本輪未執行 |
| M 受影響區手動端到端 | manual | 未執行，不能用 unit 替代 |
| 六人 e2e | manual | 本輪依使用者明確豁免，未執行 |

### Coordinator 精確本機命令（此處列出不代表已跑）

1. `cd /workspace/pr49b/poker && node --test --test-isolation=none --test-timeout=10000 test/*.test.js`
2. 在可監聽環境終端 A：`cd /workspace/pr49b/poker/firebase && PATH=/home/box/.local/jdk/bin:$PATH ../node_modules/.bin/firebase emulators:start --only firestore --project demo-poker`（既有設定 127.0.0.1:8195；不可連真實 DB）。
3. 終端 B 依序、不可並行覆寫 Rules：`cd /workspace/pr49b/poker && FIRESTORE_EMULATOR_HOST=127.0.0.1:8195 node --test --test-isolation=none --test-timeout=10000 firebase/rules.test.mjs`；之後 `FIRESTORE_EMULATOR_HOST=127.0.0.1:8195 node --test --test-isolation=none --test-timeout=10000 firebase/stats-phase-b.test.mjs`。既有 Rules runner 另有 RULES/STARTAT 參數需求時沿用既有 runner，勿改正式 Rules 啟用常數。
4. B 測試後、停 emulator 前：`curl --fail http://127.0.0.1:8195/emulator/v1/projects/demo-poker:ruleCoverage -o /tmp/pr49b-round4-ruleCoverage.json`；HTML：`curl --fail http://127.0.0.1:8195/emulator/v1/projects/demo-poker:ruleCoverage.html -o /tmp/pr49b-round4-ruleCoverage.html`。搭配 firestore-debug.log／emulator request trace，量測成功三文件 batch、六 pending entry、並發／失權各路徑；coverage 的評估總次數不能冒稱單次 request 最大 expression 或讀取次數。
5. `node /tmp/pr49b-round4-browser.mjs`；不啟 app server、不連 DB。若環境禁止 Chromium 啟動，回報原錯誤，不連續重試。

變更檔案：js/stats/remote-pending.js、js/stats/submission.js、test/personal-stats-phase-b-round4.test.js、firebase/firestore.rules、firebase/stats-phase-b.test.mjs、本 LOG。沒有新增 repo regression script／依賴，未接 production／啟用 statsEnabled 或 T0，無 commit／push／merge／deploy／雲端代理／憑證／preview。本輪停止。剩餘需 coordinator 真瀏覽器／Rules quota／完整測試及手動驗證；本機測試估數分鐘，額度與環境問題無可靠完成估計，續輪需 owner GO。


## ROUND4 最小後續：遠端上限兩筆（2026-11-08）

使用者明確復工並指定 implement-approved-spec／regression-check；M 級、PL v1.0，BD 無外觀變更。本輪 2 分鐘／8 shell calls；HEAD 2835d8d，任務分支 pm/pr49-b1，未 commit。前段六筆上限與待測狀態為歷史候選，以下取代該遠端上限。

量測來源：coordinator 的 /workspace/pr49b-round4-rules.log:179–186，六筆 pending 寫入 L728 PERMISSION_DENIED，超過 1,000 expressions。依使用者授權採最小保守修改：adapter 與 B pending Rules 一致限制每房間單文件 **2 筆 handId＋uid entries**；每筆原有完整白名單／型別／數值驗證保留，現任 host 隔離及禁止 list/delete 不變。未優化或放寬授權，未動舊 app/rules。兩筆成功與 expression/access coverage **PENDING coordinator verification**，不得當成實測通過。

涵蓋／吞吐限制：同時至多兩筆遠端 ACK，包含跨手累積，不保證六人一手全員都有遠端備份；須逐 uid 提交確認並清理才釋放 slot，後續 wake 再嘗試，沒有固定吞吐保證。host 在此之前死亡，新 host 只能恢復已 ACK 子集；未 ACK 的本機待送全部保留，不靜默淘汰、不等待或阻擋牌局。裝置副本若消失仍可能缺紀錄，沿用已接受限制。16,384 serialized-byte 上限保留；先前六筆 bytes 量測僅歷史 payload 樣本，不再表示可接收六筆。

修改檔案：js/stats/remote-pending.js、firebase/firestore.rules（僅 B pending）、test/personal-stats-phase-b-round4.test.js、firebase/stats-phase-b.test.mjs、本 LOG。測試斷言 cap=2、第三筆拒絕且原內容不變、六筆本機待送在 remote-full／提交失敗後全數保留；Rules 原現任／舊 host／成員／外人隔離案例保留，新增兩筆接受／三筆拒絕與 adapter 滿額保留斷言。

| M 回歸項目 | 方法 | 結果 | 證據 |
|---|---|---|---|
| A/B 身分、獨立鏈、補送、容量、鎖、ACK、滿額與喚醒 | unit | 本輪 32/32 pass，0 fail/cancelled | /tmp/pr49b-round4-followup-unit.tap |
| B Rules assertions | node --check | 語法通過；emulator 未執行，較小 cap 成功待核實 | firebase/stats-phase-b.test.mjs |
| 完整 unit／既有 Rules | coordinator 前次結果（本輪修改前） | 使用者回報 193/193、142/142；本輪未重跑 | 使用者本輪指示 |
| M 受影響區手動端到端 | manual | 未執行；不能以 unit 替代 | 待 coordinator |

實際執行：上述 A/B 四檔 `node --test --test-isolation=none --test-timeout=10000`（修改後重跑）；`node --check poker/firebase/stats-phase-b.test.mjs`；`git diff --check`。未執行完整 unit／Rules／server／emulator，無 production／T0／C/UI／commit／push／deploy／preview。本輪完成後停止；剩餘 coordinator 重跑 B Rules（含兩筆成功與三筆拒絕）、量測 coverage/access 與 M 手動項目；Rules 重跑估數分鐘，quota 實測依環境無可靠估時。

## PM 第四輪獨立核實與停報（2026-11-08 09:07 台北時間）
1. 宗良 go 接續 B；本輪明確不推送。基底本機及遠端2835d8d。跨host ACK pending與online/foreground喚醒以opt-in介面實作，尚未掛正式host/T0，不視為產品端到端完成。
2. 原6筆remote pending Rules實跑命中1000 expressions，保留完整驗證、改每房間最多2筆/16384 serialized bytes；滿額拒新、既有本機待送不覆蓋，不阻擋牌局。兩筆最長4byte Unicode合法ID及安全整數邊界實測4217 UTF-8 bytes，Firestore encoding/index成本仍非此值。host消失前可能只有部分uid遠端ACK，未ACK者仍無跨裝置保證。
3. 最終獨立unit193/193、既有Rules142/142、B Rules15/15（含父案例）全通過，0fail/0cancel；證據 /workspace/pr49b-round4-final-{unit,rules}.log。全DB測試localhost/demo-poker；正式statsEnabled=false/T0保持停用，未跑已豁免六人。
4. 真Chromium本機診斷：雙分頁40筆不互蓋、reload保留40筆、有界拒新保留舊筆；填滿localStorage確實QuotaExceededError後queue保留原1筆並告警；offline->online喚醒1次、visible事件後2次、解除事件後不增加。證據 /workspace/pr49b-round4-browser{,-quota,-wake}.json。測試專用origin/context隨browser關閉，不寫真DB；不把Chrome配額當iPhone/Safari保證，storage.estimate也不當localStorage容量。
5. Rules quota：實測6筆超過1000 expressions、2筆通過，並取得 /workspace/pr49b-round4-final-ruleCoverage.json。coverage是整套累積，不是每request精確expression或cached document reads；因此quota項仍部分完成，不捏造精確數字。跨host與wake仍欠正式host受控整合；真多瀏覽器/裝置及精確reads/quota尚待測。
6. 未push/merge/deploy、不做C/UI、不改舊app。下一輪先讀本LOG與remote-pending.js、submission.js；估受控整合/精確quota另15–30分鐘，不含Safari/裝置測試，需另GO。無需PL重選產品定義；T0發版另定，技術兩筆上限為PM依量測制定。

## Phase B ROUND5：實際 host 受控接線（2026-11-08）

明確復工授權 implement-approved-spec／regression-check；僅 B，7 分鐘／25 shell calls。HEAD 2862004，任務分支 pm/pr49-b1；未 commit。PL v1.0 §5–7、§10有效；M級，無外觀／C改動，六人e2e依本輪豁免。

驗收切片：既有 host start/stop、完手獨立 statsWriteChain 接上 bounded account+room local queue、server-only ACK remote pending、receipt submitter、online/visible wake。正式 STATS_ENABLED=false、STATS_T0=null，停用路徑不建立持久佇列／事件／DB操作；測試才注入 enabled/period/adapters。不將統計 Promise 接入遊戲 writeChain。房間遠端仍最多2筆／16384 serialized bytes，本機沿8192／524288 bytes，不新增TTL或淘汰。

createHostStatsRuntime：wake併發合併，start冪等，stop永久撤銷該實例並解除事件；新host建立新實例。所有非同步queue/submit adapter操作前後檢查現任host及本次runtime仍有效；SDK transaction callback每次重試及讀取後再次檢查，batch提交前再次檢查。已送出的網路請求無法取消，仍依Rules判定；延遲ACK後失權不再進行下一步提交／清理。失權／失敗保留pending與錯誤回報。remote list仍只用getDocFromServer並拒絕cache/hasPendingWrites，沒有從舊host記憶體推算恢復。

最小舊程式變動：host建立runtime並把recovery注入既有獨立鏈，start/stop接生命週期；mp-app四個host建立點提供即時帳號uid，帳號變更立即stop舊host。既有離桌tearDownRoom及hostUid更換分支沿用stop解除。未修舊base／Safari／手機。

實際命令：
- 初次新增ROUND5 unit：3 pass／1 fail，fixture缺room.config（不是產品錯誤）；補完整fixture，未修改引擎。
- `node --test --test-isolation=none --test-timeout=10000 poker/test/personal-stats-phase-a.test.js poker/test/personal-stats-phase-b.test.js poker/test/personal-stats-phase-b-round2.test.js poker/test/personal-stats-phase-b-round4.test.js poker/test/personal-stats-phase-b-round5.test.js`：最後36/36 pass，0 fail/cancelled；/tmp/pr49b-round5-unit.tap。
- `node --check poker/js/ui/mp-app.js`、`git diff --check`：exit 0。未執行完整unit／Rules／browser，遵守沙箱不可socket，不嘗試server。

| M回歸項目 | 方法 | 結果 | 證據 |
|---|---|---|---|
| A/B既有身份、快照、獨立鏈、去重、quota/cleanup保留 | unit | PASS | /tmp/pr49b-round5-unit.tap |
| 實際host startHand→FOLD→HAND_OVER→本機保存及補送 | 注入adapter unit | PASS | 同上ROUND5案例 |
| ACK讀取中失權不提交／不清理、wake合併、stop解除、正式停用 | 注入adapter unit | PASS | 同上ROUND5案例 |
| 帳號／離桌／host切換真瀏覽器、受影響M區域手動 | manual | 未執行，待coordinator | 不以unit代替 |
| 六人e2e | manual | 本輪豁免 | 使用者指示 |

Coverage實查：/workspace/pr49b-round4-final-ruleCoverage.json根鍵rules、report；report節點包含sourcePosition、values[].value/count、children。沒有request ID、文件access/cache計數或明確的每request expression總數。整套累積count不能當單次額度；即使樹狀count全加總也不能宣稱等於Rules內部1000 expressions計數（節點階層／內部計數語義未有對照）。

提供coordinator隔離量測方法（未執行）：僅localhost/demo-poker，使用既有公開ruleCoverage JSON端點，先以Rules disabled管理context準備fixture並載入測試記憶體啟用Rules；取得baseline JSON；只送一個目標受保護請求（例如兩筆pending transaction，須明確記錄SDK是否重試及一個transaction可能含多個RPC），立即取得after JSON。按sourcePosition及value配對比較count差值，僅報「隔離操作期間各來源節點評估差值」，不要冒稱精確單RPC expression總數。批次提交、receipt get、remote get、pending transaction各分開在乾淨emulator／序列環境測，不能同時有其他Rules測試。成功只證明該fixture請求未超限，不給精確數字。若coordinator的公開emulator request trace有明列request關聯的expression／document access及cache資訊，才另依該證據報數；本JSON無此資料，精確每request expression及文件read/cache額度仍未量得。不用未文件化重設／debug API。

變更精確路徑：poker/js/stats/host-runtime.js（新增）、poker/js/net/host.js、poker/js/ui/mp-app.js、poker/js/stats/remote-pending.js、poker/js/stats/firestore-adapter.js、poker/js/stats/submission.js（僅更新接線說明）、poker/test/personal-stats-phase-b-round5.test.js（新增unit，非regression script）、poker/PHASE-B-LOG.md。

剩餘：coordinator完整unit與既有/B Rules、M受影響生命週期手動、隔離quota調查。正式DB接線保持停用，不宣稱產品已啟用或B驗收；只恢復已ACK遠端子集、遠端兩筆上限的涵蓋限制沿前輪。無新增依賴／regression scripts／部署／merge／push／commit／憑證／雲端代理／preview。預算到點停止；完整unit估1分鐘，手動與精確quota依環境無可靠估時，續輪需owner GO。

## PM 第五輪獨立核實與停報（2026-11-08 09:18 台北時間）
1. 宗良授權B接線與全測通過後一般推送。已接host start/stop、HAND_OVER獨立鏈、ACK pending恢復及online/visible wake；正式STATS_ENABLED=false/T0=null不變，不新增正式DB寫入。變更範圍只B必要接線。
2. 獨立完整unit197/197、既有Rules142/142、B Rules15/15全通過，0fail/0cancel；六人沿核准豁免。證據 /workspace/pr49b-round5-final-unit.log、/workspace/pr49b-round5-rules.log，僅demo-poker localhost。受影響區域unit涵蓋真host開手/FOLD/完手、失權/stop/account檢查、wake合併；未做真瀏覽器帳號/離桌/host切換M手動，不冒稱整體B驗收。
3. 配額調查：官方coverage JSON只有來源節點value/count/children，沒有每request ID、cached document reads或1000 expressions內部計數。官方限制亦說Requests Monitor不顯示依賴fetch：https://firebase.blog/posts/2021/08/firestore-emulator-requests-monitor/ 。因此精確quota仍部分完成，不虛報。
4. 隔離單一成功三文件SDK batch前後coverage，來源節點累計差2364；成功請求卻大於1000，直接證明這個加總不能當額度expression。證據 /workspace/pr49b-round5-isolated-{before,after}.json、/workspace/pr49b-round5-isolated-quota.log。靜態未計cache保守上界：aggregate3、summary3、receipt4個文件存取函式呼叫，共10，單寫最多4；pending每次Rules只讀room一次。這是source上界，不是實測cache/billable reads。2筆pending成功、6筆撞1000的實測沿前輪；遠端cap2/16KiB、本機8KiB單筆/512KiB維持。
5. 可交本輪受控接線的自測；整體B尚不可結案，欠真瀏覽器生命週期、多裝置/Safari/手機與精確quota可觀測性。額度工具不提供的數字不可用繼續堆coverage假裝量得；若要變更驗收方式請交上游確認。估手動整合自測15–30分鐘，Safari/手機另計。
6. 不合併部署、不寫正式DB、不做C。不自動續輪；本輪核准一般推PR49，不動main、不強推，push前遠端必須仍2862004。

## Phase B ROUND6 啟動受阻（2026-11-08，台北時間）

已讀交接 LOG；本輪要求本機 demo-poker 真瀏覽器登入、離桌與換 host 自測，不推送。載入 code-changes 後，其規則要求任何非簡單 repo 行為調查交由 CloudAgent；工具探索 CloudAgent 無可用工具，故停止，未以本機腳本繞過。未啟動 emulator/browser、未執行案例、未修改產品或測試程式、未 commit/push/merge/deploy、未接正式 DB。所有案例及 M 回歸均未測；沒有截圖或 idle/read 數字。需主代理解決執行工具限制後續行，不得將本輪視為通過。

## PM 第六輪真瀏覽器本機自測停報（2026-11-08 09:44 台北時間，約15分／22 calls）
- 僅 localhost demo-poker emulator；Chromium headless 多 context。測試專用：mp-app 新增 `qaStatsOpts()`（僅 isEmuMode 且 window.__qaStats 才傳 stats），正式 STATS_ENABLED=false/T0=null 不變；Rules 以未提交副本 firebase/firestore.r6-test.rules（statsEnabled→true）+ firebase.r6-test.json 啟動。腳本 test/mp-r6-stats.mjs。
- 第一次用正式 rules：本機 pending 有保存，遠端 statsPending 被拒（statsEnabled()=false，符合預期停用）。
- S1 登入+3人4手：PASS。3 uid 各 hands 4/unique 4，validHands=4，無重複；host 本機 pending 清空。
- S2 回大廳離桌：未通過/未測成。找不到「回大廳」按鈕（lobbyBtn=0），__qaShowLeaveConfirm 回 false，g2 未回大廳；收桌結算未測。需確認按鈕選擇器/顯示條件。
- S3 換 host：接手成功（hostUid 換成 z03…），舊 host 關閉後無再寫；接手後第5手未在等待內打完（h5=false），新 host 寫入、跨 host ACK 恢復、離線/前景補送未得證據。統計維持4手、無重複。
- 回歸：fold/check/call 實點 PASS；raise 只見按鈕存在；快捷/slider/−+/all-in/確認/取消/回大廳對話框未測。
- idle10s：host repaints 0、emu requests 13；大廳 0/0；新 host 0/10。
- 證據 /workspace/pr49b-r6/（r6-result.json、run1-3.log、截圖）。

## PM 第七輪補測停報（2026-11-08 09:57 台北時間，約11分／15 calls）
- 回大廳找不到：測試選擇器錯，非產品 bug。真實入口為頂部 #btnBackLobby（‹ 大廳）；牌局中依設計只 toast「這手打完才能離開」。
- S2 非 host 離桌：PASS。對話框「是否離開牌局？確認離開/取消」；取消留桌、確認回乾淨大廳（狀態在大廳、帳戶結算），離桌前後統計不變無重複。
- 回歸 PASS：raise 面板、+/−（60→80→60）、slider 最大 2,000、6 個快捷鍵、全下=2,000、取消關閉、確認送出；fold/check/call 前輪已過。
- S3 換 host：接手成功（hostUid 換人），但測試設計缺陷：第1手全下使兩位玩家籌碼歸零，之後新 host 無法打完一手，故新 host 寫入、跨 host ACK、離線/前景補送仍無證據。舊 host 關閉後無寫入、無重複。
- host 確認收桌：未測（新 host 狀態不正確，對話框未出現，腳本逾時）。
- unit 197/197 pass。Rules/B Rules 未重跑（時間不足）。未全過→未推送。
- 證據 /workspace/pr49b-r7/（r6-result.json、run1.log、unit.tap、截圖）。下一輪：全下改在最後或用 cancel 不確認、補籌碼後再測 S3 與收桌。

## PM 第八輪停報（2026-11-08 10:10 台北時間，約12分／4 calls；第二次瀏覽器跑7分超出預估）
- 全下改為取消不送，確認改用最小加注：regression 全 PASS（+/−、slider、6快捷、全下取消、確認、取消、回大廳對話框）。
- S2 非 host 離桌：PASS（等該手結束後「是否離開牌局？」取消留桌、確認回乾淨大廳；統計 3 手無重複）。
- host 確認收桌：PASS。room status=closed，新 host 回大廳帳戶 2,080，可加入牌桌 0。
- 換 host：PARTIAL。接手成功（hostUid 換人），新 host 時期寫入第4手（PXpPK 4/4、jkNkk 4/4、新玩家 1/1，hands==unique 無重複）。但 playOne 在新 host 下未於時限判定完手，離線時本機 pending 為空，跨 host ACK 恢復與離線/前景補送沒有直接證據。
- Rules 142/B Rules 15 未跑（時間）；unit 未改產品碼，上輪 197/197。未全過→未推送、未 fetch。
- 證據 /workspace/pr49b-r8/（r6-result.json、run1-2.log、截圖）。

## PM 第九輪停報（2026-11-08 10:19 台北時間，約9分／10 calls）
- Rules 142/142 PASS（0 FAIL），B Rules 15/15 PASS；只用正式 firestore.rules（statsEnabled=false）於 demo-poker。證據 /workspace/pr49b-r9/rules.log、results.json。
- 強制 pending：未成功。host 自己蓋牌後立刻斷線→該手未完成（host 動作需經線上），沒有統計產生；改為 guest 蓋牌、host 偵測完手（raf）立即斷線→統計已在斷線前寫入（2/2/2），本機 queue 為空。瀏覽器層無法可靠造出「已完手但未 ACK」狀態；需測試專用注入（例如 emu 下讓 adapter 第一次失敗）才可確定性驗證。
- 重連/前景補送、跨 host 接續確認：無證據（無 pending 可補）。所有時點 hands==unique，無重複。2 人桌 host 關閉後 60 秒內未發生接手（3 人桌前輪可接手），原因未查。
- 未全過→未推送、未 fetch。未改產品碼。證據 run1-3.log、r6-result.json、截圖。

## PM 第十輪：兩人桌未接手原因（2026-11-08 10:47 台北時間，約6分／6 calls）
- 已確認：測試腳本造成，非產品 bug、非 Rules 拒絕。接手條件（js/net/presence.js maybeTakeover）：guest 分頁 visible、已入座、距上次收到房間快照 ≥30s（+名次×3s）。mp-app.js:1532 每收到房間快照就重設 lastRecvAt。第九輪腳本每10秒用 emuBackdateHostGone 改寫 room.updatedAt，這個寫入本身觸發快照→計時歸零，永遠到不了30秒。
- 重現（兩人桌、同步驟）：只回填一次→33秒接手；每10秒回填→70秒仍未接手。guest 皆 visible、不在牌局中。證據 /workspace/pr49b-r10/r6-result.json、run1.log、takeover-*.png；腳本 test/mp-r10-takeover.mjs。
- 三人桌前輪看似成功，是因為之後的步驟（加入新玩家等）拖過30秒才查到，不是人數條件。
- 與 Phase B 無關（計時邏輯在 presence/mp-app 舊碼），未在 87014f6 另跑。產品不需修；測試只回填一次並等 ≥35 秒。

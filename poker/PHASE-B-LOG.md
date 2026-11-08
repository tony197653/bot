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

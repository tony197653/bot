# 德州撲克 第二階段（多人連線）架構規格書 v2

版本紀錄：v1 2026-11-01 初版（大型）；v2 2026-11-01 套用 EGM 審查、宗良 的 4 題答案、業界標準籌碼模型（帶入→桌上→結帳）、宗良 選定方案A 和整筆帶入
撰寫：規劃師 PL　交付：專案經理 PM　網址：https://tony-poker.web.app/（Firebase Hosting，專案 `tony-poker`；程式碼仍放 repo `tony197653/bot` 的 `poker/`）
相關文件：
- 研究：`phase2-research.md`、`chip-industry-research.md`（籌碼模型的業界調研）
- 線框：`wireframes/wf-01`～`wf-08`、`wireframes/flow-user.svg`（每張都有同名 PNG），總覽在 `wireframe-overview.png`
- 規則檔：`firebase/firestore.rules`（＝`auth.rules`＋`poker.rules`）、`firebase/firestore.indexes.json`、`firebase/firebase.json`
- 第一階段程式：`poker/js/engine/game.js`、`view.js`、`fx.js`、`app.js`、`css/game.css`
- 同步規格參考：`/workspace/stay-quiz-plan/spec-sync.md`（Firebase SDK 10.14.1 從 gstatic 載入、逾時處理、localStorage 備援）

## v2 修訂紀錄

> v2 定案：籌碼照業界標準的「帳戶 → 帶入 → 桌上 → 結帳 → 帳戶」模型（§6.10），v1 的每手結算單、補寫佇列、牌堆祕密文件全部拿掉。登入照 宗良 選的方案A（Firebase Hosting 同網域轉址）。入座照 宗良 選的方案①（帳戶全部帶上桌）。本文件沒有待選項目。

| 項目 | 改了什麼 | 章節 |
|---|---|---|
| 宗良 答案 1 | 宗良 選方案A：放 Firebase Hosting `tony-poker.web.app`，authDomain 同網域，用轉址登入；方案B 拿掉。發布改用 `firebase deploy`，預覽用 Hosting 預覽頻道 | §6.1、§8.3、§13.3 |
| 宗良 答案 2 | 房主可以自己核准自己補 2,000，補的次數全桌看得到；寫法＝加買（add-on），房間 stacks＋帳本 topup 同一個 batch | §4.1、§6.10、規則 |
| 宗良 答案 3 | 排行榜（名字、頭像、總籌碼＝帳戶＋牌桌中）所有登入的人都看得到 | §9.5、§9.6 |
| 宗良 答案 4 | 規則只保證桌上籌碼總數不變（零和），擋不了房主故意分錯底池：列為已接受風險 | §9.6、待決問題 |
| EGM #4 | 偵測 LINE／Facebook 內建瀏覽器；LINE 自動加 `openExternalBrowser=1`；其他顯示「用瀏覽器開啟」提示（新增 1-e）；註明 Safari 和主畫面版不共用 localStorage | §2、§4.1、§8.3、wf-01 |
| EGM #6 | pub 新增 `seatedAt[6]`（伺服器時間）；接任房主＝沒暫離的在座者裡 `seatedAt` 最早的人 | §6.7、§9.1 |
| EGM #7 | 房主循環只要 App 開著就跑（任何畫面）；房主離座時在 HAND_OVER 自動交棒再空出座位；切到背景＝斷線 | §6.2、§6.7、規則 |
| EGM #8 | 加入順序：讀房號 → 試讀房間 → 讀不到才加入成員；被拒顯示「牌桌已結束」。分享連結帶 `?room=房號&r=房間ID`。房主可延長房號期限（新增規則） | §2、§4.1、§9.2、規則、wf-03 |
| EGM #9 | 建房規則用 `hasAll`＋`hasOnly`；`deadlineAt:null`、`seatUids` 6 格空字串寫明；`seatUids` 每格檢查型別 | §9.2、規則 |
| EGM #11 | 計時簡化：只有房主用自己的時鐘判逾時；其他人從收到快照起算本機倒數；接手只看「房間 X 秒沒更新」，嚴格判斷交給規則的 `request.time`；`actionSeq` 跳號就跳過動畫 | §6.4、§6.5、§6.7 |
| EGM #13 | 只有房主那台的寫入計數會擋開新手牌；換日時間用 America/Los_Angeles 午夜換算，不寫死 16:00 | §6.6、§10 |
| 籌碼模型（EGM #1、#2、#3、#5、#10、#12） | 照業界做法重寫：帳戶 `bank`／牌桌中 `inPlay`／`tableRoomId`／`sessionNo`，帳本 `ledger` 只新增、固定編號（冪等）；入座＝帶入、打牌中只改房間 `stacks[6]`（規則檢查加總＝`chipTotal`）、補碼＝加買、離座＝結帳；作廢＝退回這手開始的 stacks；拿掉每手結算單、`pendingLedger`、牌堆祕密文件 | §6.8、§6.10、§9、§10 |
| 宗良 選入座方案① | 入座時把帳戶全部帶上桌（bank → inPlay），不選金額 | §6.10、規則 |
| EGM #14 | 「送你 2,000」改成「送你 N 籌碼」；刪掉 1-a「我有房號，先看看」和 §3 的對應；計時警示對齊第一階段程式（最後 5 秒） | §2、§3、§4.1、§7、§11 |

> 本文件分兩層。第 0～7 章照架構規格範本寫；第 8 章是可重用登入模組；第 9 章是 Firestore 模型與完整規則；第 10 章是用量估算；第 11 章是動畫時間軸；第 12 章是 PL 決定清單；第 13 章是實作清單。最後是待決問題。

---

## 0. 設計主軸

- **一句話主軸**：給家人和好朋友各拿自己的手機坐同一桌。要像第一階段一樣好看、順手。最重要的一件事：**每個人只看到自己的牌，下注和發牌即時同步，而且動畫不卡、不重播。**
- **每屏主角**：

| 畫面 | 主角（唯一） | 主動作（唯一） | 要降級的元素 |
|---|---|---|---|
| ① 登入 | 「用 Google 帳號登入」 | 登入 | 說明文字 |
| ① 大廳 | 「繼續上次的牌桌」卡；沒有上次的牌桌時換成「開新牌桌」 | 回到牌桌 | 戰績卡、登出 |
| ② 開新牌桌 | 新玩家起始籌碼 | 開房 | 固定規則卡 |
| ② 分享 | 6 位數房號 | 分享連結 | 複製、進入牌桌 |
| ③ 輸入房號 | 6 格數字 | 加入 | 返回 |
| ④ 等人入座 | 牌桌和空位 | 房主：開始第一手；其他人：點空位 | 觀戰人數 |
| ⑤ 多人牌桌 | 自己的兩張手牌和行動中的人 | 行動列（輪到我時） | 側欄、觀戰人數 |
| ⑥ 狀態 | 當下那一則狀態 | 核准／請出／申請補 | 其他座位 |
| ⑦ 觀戰 | 牌桌 | 點空位坐下 | — |
| ⑧ 戰績 | 排行表 | 切換總排行和每晚 | 更新時間 |

- **參考模板**：不另選模板。直接沿用第一階段已上線的牌桌樣式（宗良定案：不出新風格方向）。
- **風格 skill**：frontend-design（遊戲）。元件編號照 component-style-library（見 §0.1）。
- **風格定稿**：全部沿用第一階段 token：
  - 顏色：`--page:#13231a`、`--felt:#2f8a52`、`--rim:#7a4a26`、`--accent:#e6bf5a`、`--gold:#d6b45a`、`--warn:#ff4d3a`、`--ring:#d6b45a`
  - 字體：標題 `--tf` Noto Serif TC，內文 `--uf` Noto Sans TC
  - 尺寸：`--top-h:40px`、`--bar-h:78px`；牌 44×62，自己的手牌 60×84
  - 新畫面（大廳、開房、輸入房號、戰績）延用第一階段大廳的深色抽屜表單樣式。
- **不要清單**：
  - 不出新配色或新字體。
  - 不放 AI 玩家。
  - 不做聊天室或表情貼。
  - 不讓房主手動改籌碼。
  - 不做洗牌驗證。
  - 斷線重連後不重播動畫。
  - 不做全螢幕遮罩的「換人」畫面（多人模式拿掉）。
  - 元件不用 B3、B6、C2、C4、L1、L4、S4。

### 0.1 元件編號（component-style-library）
| 編號 | 用在哪裡 |
|---|---|
| B1 主按鈕 | 登入、用瀏覽器開啟（1-e）、回到牌桌、開房、分享連結、加入、開始第一手、加注、核准、請出座位、申請補 |
| B2 次按鈕 | 開新牌桌、輸入房號加入、複製連結、複製網址（1-e）、蓋牌（第一階段紅框樣式）、先不要、不亮 |
| B4 柔和按鈕 | 跟注、進入牌桌 |
| B5 文字連結 | 登出、再按一次、用 Safari 開啟、離座、取消申請、回大廳、延長房號 24 小時 |
| I1 細框光環 | 6 格房號 |
| I3 浮動標籤 | 牌桌名稱 |
| I5 前後綴金額 | 新玩家起始籌碼（前綴「送」，後綴「籌碼」） |
| S3 分段滑塊 | 盲注選擇、戰績「總排行／每晚輸贏」 |
| T1＋T5 | 戰績表（數字欄靠右對齊，斑馬紋，自己那一列淡底） |
| C1 留白文字卡 | 大廳的戰績卡 |
| C3 | 大廳的「繼續上次的牌桌」卡 |
| L2 狀態點 | 暫離（附倒數）、全部在線 |
| L3 標籤 | 房主、新房主、下一手加入、入座中…、剩 N 秒、觀戰中 |
| L5 計數徽章 | 觀戰 N |

## 1. 功能範圍

- **要解決的問題**：第一階段只能一支手機輪流傳，每個人都會看到別人的牌，也不能各自坐在沙發上玩。籌碼打完也就沒了，下次要重來。
- **目標**：
  - 2～6 人各用自己的手機，用 Google 登入同一桌。
  - 自己的手牌只有自己看得到。
  - 籌碼長期累積在雲端。
  - 有戰績可以看。
  - 全部在 Firebase 免費方案（Spark）內跑完。
- **v2 這一版要做**：
  1. 可重用登入模組（第 8 章），提供 Google 登入、個人資料文件、離線快取。
  2. 大廳：繼續上次的牌桌、開新牌桌、輸入房號、戰績入口。
  3. 開房：設定名稱、盲注、新玩家起始籌碼；產生 6 位數房號和分享連結。
  4. 加入：點連結直接進房，或輸入房號。
  5. 入座：點空位直接坐下，不用房主同意。坐下＝把帳戶籌碼全部帶上桌（帶入）；離座＝桌上剩的全部結帳回帳戶。牌局進行中坐下的人等下一手。最多 6 席。
  6. 多人牌桌：房主那台洗牌、發牌、執行規則。每台只拿到自己的手牌，公開狀態即時同步。思考時間 30 秒。
  7. 斷線處理：
     - 超過 60 秒沒有心跳算暫離。暫離的人輪到時自動過牌，不能過牌就蓋牌；下一手不發牌。
     - 座位保留，回來後自動回座。
     - 房主可以請暫離的人離座。
  8. 房主斷線超過 30 秒：沒有暫離的在座者裡、入座時間（`pub.seatedAt`）最早的人自動接任房主。那一手作廢：桌上籌碼退回這手開始時的 `stacks`，不碰任何人的帳戶（§6.10）。
  9. 破產補籌碼：要房主核准，每次 +2,000；房主自己輸光也可以自己核准。補的次數全桌看得到，和淨輸贏分開記錄（業界叫加買 add-on，§6.10）。
  10. 觀戰：沒入座的成員可以看，但看不到任何人的手牌。
  11. 戰績：總籌碼排行（帳戶＋牌桌中）和每晚淨輸贏（帶走 − 帶入）。
  12. 用量保護：房主那台的每日寫入計數、寫入合併、localStorage 備援。
- **這一版不做（之後再說）**：
  - 牌局紀錄回放、每手牌的歷史。
  - 聊天和表情。
  - 洗牌驗證（commit-reveal）。
  - Cloud Functions。
  - App Check。
  - 用 TTL 自動刪舊房間。
  - 推播通知。
  - 好友名單。
  - 多桌同時進行（一人同時只能在一桌）。
  - 預先動作（預先蓋牌、預先跟注）。
- **不能動的地方**：
  - 第一階段單機輪流模式要保留，大廳底部放一個 B5「同一支手機輪流玩」。
  - `game.js` 純函式 `applyAction(state, action, env)` 的介面不改，只新增 action。
  - 第一階段的動畫常數（`DEAL_FX`、`SHOWDOWN_FX`）數值不改。
  - 牌桌樣式和 CSS token 不改。

## 2. 流程

完整流程圖：`wireframes/flow-user.svg`。

主流程：
1. 打開網址。
2. 判斷有沒有登入：沒有就到 ① 1-a 用 Google 登入。
3. 判斷網址有沒有 `?room=房號&r=房間ID`：有就照 §9.2 的加入順序進 ④；沒有就到 ① 大廳。
   - 第 2 步之前先檢查是不是 App 內建瀏覽器（LINE、Facebook、Instagram）：是的話不顯示登入，改走 1-e（§8.3）。
4. 大廳可以選：
   - 開新牌桌：② → 分享 → ④
   - 輸入房號：③ → ④
   - 繼續上次的牌桌：直接到 ④
5. 在 ④ 點空位坐下。房主按「開始第一手」。
6. ⑤ 每一手的循環：發牌 → 下注 → 攤牌 → 結算（只改房間的桌上籌碼 `stacks`）→ 下一手。
7. 離座、被請出或收桌：桌上籌碼結帳回帳戶（§6.10），回大廳。

分支：

| 情況 | 處理 |
|---|---|
| 第一次來（沒有 `pokerPlayers/{uid}`） | 第一次進牌桌時建立帳戶（帳戶＋帳本 grant 同一個 batch，§6.10）。帳戶＝這房的「新玩家起始籌碼」N。顯示 3 秒提示「第一次來，送你 N 籌碼」（N 用實際數字，例如「送你 5,000 籌碼」）。 |
| 牌局中入座 | 標「下一手加入」，這手不發牌。 |
| 斷線、切到背景 | 60 秒內回來：什麼都不變。超過 60 秒：暫離。回來後自動回座。畫面直接跳到最新狀態，不重播動畫。 |
| 房主斷線超過 30 秒 | 自動換房主，本手作廢，3 秒後新房主開下一手。 |
| 房主離座 | 這手打完（HAND_OVER）時自動把房主交給下一位（同上的接任順序），再空出自己的座位（§6.7）。 |
| 在 LINE／Facebook 裡點連結 | LINE：自動加 `openExternalBrowser=1` 重開；其他：1-e 提示「用瀏覽器開啟」（§8.3）。 |
| 桌上籌碼 0 | 手牌之間出現「申請補 2,000」。房主核准後，房間 stacks 加 2,000＋帳本記一筆加買。 |
| 帳戶 0 還想坐下 | 照樣可以帶入 0 坐下，再申請補 2,000。 |
| 房主失聯超過 10 分鐘或已收桌，自己還在座 | 大廳「上次的牌桌」卡顯示「結帳離開」：自己照房間最後的 stacks 結帳回帳戶（§6.10 自救）。 |
| 房號錯、房間已關 | ③ 顯示錯誤，或顯示「牌桌已結束」卡。加入時被規則拒絕（permission-denied）也顯示「牌桌已結束」。 |
| 用量快滿 | 房主那台 6,000 次寫入時提醒，8,000 次時不再開新的一手（§6.6）。 |
| 沒網路 | 大廳和戰績顯示快取（標示「離線資料」）；牌桌顯示「正在重新連線」。 |

```
[打開網址] → App內建瀏覽器? ─是→ [1-e 用瀏覽器開啟]
           └否→ 已登入? ─否→ [①登入] ─→ 有房號? ─是→ [④牌桌/觀戰] → 點空位（帶入）→ [⑤打一手] ⇄ 結算（只改 stacks）
                   └是────────────────↗     └否→ [①大廳] → [②開房]→[分享]→[④]
                                                     ├→ [③輸入房號]→[④]
                                                     └→ [⑧戰績]
例外（虛線）：⑤ → 暫離／換房主／籌碼用完→補碼（房主核准）；離座／被請出 → 結帳 → 大廳；房主失聯 10 分鐘 → 大廳「結帳離開」自救
```

## 3. 畫面分區

線框：`wireframes/wf-0X-*.svg` 和同名 PNG。區塊字母與下表相同。

| 畫面 | 區塊 | 名稱 | 390 寬（手機，主要） | 1280 寬（桌機） |
|---|---|---|---|---|
| ① 登入／大廳 | A | 頂部列 | 高 44，右上角頭像 | 高 56 |
| | B（1-e） | App 內建瀏覽器提示卡：說明、用瀏覽器開啟、複製網址 | 置中卡，左右 30 | 置中卡 500 |
| | B | 主卡（登入按鈕、繼續上次的牌桌、開桌、房號） | 滿寬，左右 16 | 左欄 540 |
| | C | 次要入口（戰績卡） | 主卡下方 | 右欄 520（前 3 名） |
| ② 開新牌桌 | A | 頂部列（取消） | 44 | 56 |
| | B | 表單：名稱 I3、盲注 S3、起始籌碼 I5、固定規則卡 | 捲動 | 左卡 500 |
| | C | 底部固定主按鈕「開房」（避開安全區） | 高 74 | 卡內底部 |
| ② 分享 | B／C | 房號大字／分享、複製、進入 | 直排 | 同一頁右卡 |
| ③ 輸入房號 | A／B／C／E | 頂部列／6 格／加入／錯誤區 | 鍵盤上方 | 置中卡 500 |
| ④⑤⑦ 牌桌 | A | 頂部列（牌桌名、盲注、L5 觀戰數、選單） | `--top-h` | 56 |
| | B | 牌桌（6 個座位，自己固定在最下方） | 橢圓滿寬 | 左側 880 寬 |
| | C | 自己的手牌和座位 | 牌桌下緣 | 牌桌下緣 |
| | D | 行動列 | `--bar-h` 底部固定 | 右下 |
| | E | 頂部狀態橫幅（重連、換房主、補籌碼申請） | 疊在 A 下方，不擋行動列 | 牌桌上方 |
| | F | 側欄（牌局資訊、這一手、在場成員、觀戰） | 選單裡 | 右欄 400 |
| | G | 底部抽屜（暫離管理、補籌碼申請） | 從底部滑出 | 側欄內卡片 |
| ⑧ 戰績 | A／B／C／D | 頂部列／S3／表格／夜晚選擇 | 單欄切換 | 兩張表並排 |

座位順序：每台手機把自己轉到最下方，其他人照真實座位順時針排。手機座標（390×844）：上 (195,128)、右上 (316,262)、右下 (316,470)、我 (195,708)、左下 (74,470)、左上 (74,262)。實作沿用第一階段的座位定位方法，只加一個「旋轉偏移＝我的座位號」。

### 3.1 圖片需求表
不需要新圖片。沿用第一階段的牌面、牌背、籌碼素材。Google 大頭照直接用 `photoURL`，載入失敗時顯示名字的第一個字。不新增 CREDITS 條目。

## 4. 互動與狀態

### 4.1 每顆按鈕的結果與去向

| 畫面 | 元件 | 操作 | 結果 | 停用條件 |
|---|---|---|---|---|
| 1-a | 用 Google 帳號登入 B1 | 點 | 呼叫 `signIn()` → 1-b 載入中。成功後：網址有房號就到 ④，沒有就到 1-d。網址的 `?room=&r=` 在登入前後都保留。 | 登入進行中 |
| 1-e | 用瀏覽器開啟 B1 | 點 | Android：`intent://…#Intent;scheme=https;package=com.android.chrome;end` 開 Chrome；iOS／其他：複製網址並提示「右上角⋯→在瀏覽器開啟」 | — |
| 1-e | 複製網址 B2 | 點 | 複製完整網址（含 `?room=&r=`），提示「已複製」 | — |
| 1-b | 再按一次 B5 | 點 | 15 秒沒結果才出現，再呼叫一次 `signIn()` | — |
| 1-c | 重試 B1／用 Safari 開啟 B5 | 點 | 回 1-b；或複製網址並提示改用 Safari 開啟（提醒：Safari 登入後，主畫面版還要再登入一次，兩邊 localStorage 不共用） | 「用 Safari 開啟」只在 iOS 主畫面模式出現 |
| 1-d | 頭像 | 點 | 小選單：名字、登出 | — |
| 1-d | 回到牌桌 B1 | 點 | 到 ④ 或 ⑤（`lastRoomId`） | 房間已關時整張卡隱藏 |
| 1-d | 開新牌桌 B2 | 點 | 到 ② | 自己已在別桌入座時，改為提示「先離開『週五牌局』」 |
| 1-d | 輸入房號加入 B2 | 點 | 到 ③ | — |
| 1-d | 戰績卡 C1 | 點 | 到 ⑧ | — |
| 1-d | 登出 B5 | 點 | `signOut()` → 1-a | — |
| 1-d | 同一支手機輪流玩 B5 | 點 | 進第一階段的單機模式 | — |
| ② | 開房 B1 | 點 | 用交易建立房號和房間 → 2-c | 欄位錯誤或送出中 |
| ② | 取消 | 點 | 回 1-d | — |
| 2-c | 分享連結 B1 | 點 | `navigator.share` 分享 `…/poker/?room=房號&r=房間ID`；不支援時改成複製 | — |
| 2-c | 複製連結 B2／點房號 | 點 | 複製連結，提示「已複製」 | — |
| 2-c | 進入牌桌 B4 | 點 | 到 ④，房主自動坐 1 號位 | — |
| ③ | 6 格 I1 | 輸入 | 只收數字。貼上 6 位數或整條連結會自動填入 | — |
| ③ | 加入 B1 | 點 | 照 §9.2 加入順序：讀 `pokerCodes/{code}` → 試讀房間 → 讀不到才把自己加進成員 → ④；被拒顯示「牌桌已結束」 | 不到 6 位，或查詢中 |
| ④ | 空位膠囊 | 點 | 先帶入：自己寫一個 batch（帳戶 bank 全部移到 inPlay＋帳本 buyin，§6.10），再送出 SIT 意圖，座位標「入座中…」。房主那台照帳本金額讓他坐下（stacks＝帶入金額）；牌局進行中則標「下一手加入」。上次帶入了還沒坐到（`tableRoomId` 已是這桌）就直接送 SIT，不重複帶入。 | 自己已在這桌入座（要換位先離座）；自己在別桌入座 |
| ④ | 開始第一手 B1 | 點（只有房主） | 房主那台執行 START_HAND | 入座且在線的人少於 2 |
| ④⑤ | 離座 B5（選單） | 點 | 手牌之間由房主結帳（房間空出座位＋帳本 cashout＋帳戶＋每晚戰績，一人一個 batch，§6.10）；牌局中則這手自動蓋牌，結束後結帳。**房主離座**：在 HAND_OVER 用同一個 batch 交棒給下一位（§6.7）並結帳自己；沒有其他在座的人時，提示「先收桌，或等有人入座」 | — |
| ⑤ | 蓋牌 B2／跟注 B4／加注 B1 | 點 | 送出意圖，三顆按鈕立刻鎖住並顯示「送出中」。房主套用後畫面更新。 | 不是自己的回合 |
| ⑤ | 加注面板 | 沿用第一階段 | 沿用 `raisePresets` | — |
| 5-c | 亮牌 B2／不亮 B4 | 點 | 送出 SHOW 或 MUCK 意圖；5 秒沒選＝不亮 | — |
| ⑤ | 選單 | 點 | 側欄 F：牌局資訊、這一手、在場成員、離座、複製房號連結、延長房號 24 小時（只有房主）、收桌（只有房主） | — |
| ⑤ | 延長房號 24 小時 B5（房主） | 點 | 把 `pokerCodes/{code}.expiresAt` 改成現在＋24 小時，提示「房號延長到明天 22:30」 | 房號剩超過 20 小時時隱藏 |
| ⑤ | 收桌（房主） | 點，再確認 | 先逐一替在座的人結帳（一人一個 batch，最後才結帳自己），再把房間 status 改成 closed，房號立刻失效，所有人回大廳。中途斷掉：已收桌或房主失聯 10 分鐘後，沒結到帳的人自己結帳（§6.10 自救） | 牌局中要等這手結束 |
| 6-a | 點暫離的人的座位（房主） | 點 | 抽屜 G | 對方沒有暫離 |
| 6-a | 請出座位 B1 | 點 | 對方這手蓋牌，結束後由房主替他結帳（桌上剩的回到他的帳戶），空出座位 | — |
| 6-c | 申請補 2,000 B1 | 點 | 送出 TOPUP_REQ 意圖 | 桌上籌碼不是 0，或還在牌局中 |
| 6-c | 取消申請 B5 | 點 | 送出 TOPUP_CANCEL 意圖 | — |
| 6-d | 核准 B1／先不要 B2（房主） | 點 | 核准：+2,000、補籌碼次數 +1（全桌看得到「補籌碼 ×N」）。房主自己輸光時也是自己核准。先不要：關掉卡片，對方看到「房主先不補」。核准的寫法：房間 stacks 0 → 2,000、`sess[i].topUps` +1＋帳本 `…_topup{n}`，同一個 batch（§6.10） | — |
| ⑦ | 空位 | 點 | 跟 ④ 一樣 | — |
| ⑧ | 總排行／每晚輸贏 S3 | 點 | 切換表格，不換頁 | — |
| ⑧ | 夜晚選擇鈕 | 點 | 查詢那一晚的戰績（1 次查詢） | — |
| 任何頁 | 返回 | 點 | 上一層；牌桌頁的返回＝回大廳，但不離座 | — |

### 4.2 狀態
| 畫面 | 載入中 | 空的 | 一般 | 停用 | 錯誤 | 完成 |
|---|---|---|---|---|---|---|
| 登入 | 1-b 轉圈，15 秒後出現「再按一次」 | — | 1-a；App 內建瀏覽器時 1-e | 按鈕進行中 | 1-c 白話文案 | 進大廳或房間 |
| 大廳 | 先畫快取，再更新 | 沒有上次的牌桌時，主卡換成「開新牌桌」B1 | 1-d | — | 離線：顯示快取＋「離線資料」 | — |
| 開房 | 「開房中…」 | — | 2-a | 欄位錯誤 | 欄位外框加粗加紅字；送出失敗時跳通知並可重試 | 2-c |
| 輸入房號 | 「加入中…」 | — | 3-a | 不到 6 位 | 找不到／已結束／逾時 3 秒 | 進 ④ |
| 牌桌 | 牌桌骨架＋「連線中…」 | 「等大家入座…」 | ⑤ | 不是自己的回合 | 重連橫幅；用量提醒 | 收桌：回大廳 |
| 戰績 | 快取＋淡化 | 「還沒有戰績」 | ⑧ | — | 離線：顯示快取 | — |

### 4.3 動畫
摘要：第一階段的發牌、下注、攤牌動畫全部沿用。多人新增的事件見第 11 章：入座、離座、換房主＋作廢、補籌碼、暫離和回來、別人的動作、送出中、重連時跳到最新狀態。

## 5. 資料（摘要，完整版在第 9 章）

| 資料 | 存在哪裡 | 誰能讀／寫 | 重新整理後 |
|---|---|---|---|
| 個人資料 `users/{uid}` | Firestore（登入模組） | 只有本人 | 保留 |
| 房間公開狀態 `pokerRooms/{roomId}` | Firestore | 成員讀；房主寫；加入的人只能把自己加進成員 | 保留，重連後接回 |
| 動作意圖 `…/intents/{uid}` | Firestore | 本人寫；房主讀 | 保留 |
| 手牌 `…/hole/{uid}` | Firestore | 只有本人讀；房主寫 | 保留，重連後還看得到 |
| 心跳 `…/presence/{uid}` | Firestore | 本人寫；成員讀 | — |
| 房號 `pokerCodes/{code}` | Firestore | 登入者用房號讀單筆；不能列出全部 | 24 小時有效；房主可延長 |
| 籌碼帳戶 `pokerPlayers/{uid}`（bank、inPlay、total、tableRoomId、sessionNo） | Firestore | 登入者讀（排行榜）；本人建立、本人帶入；結帳時房主或本人照帳本入帳（§6.10） | 永久 |
| 帳本 `pokerPlayers/{uid}/ledger/{id}` | Firestore | 登入者讀；只能新增（grant／buyin／topup／cashout，固定編號） | 永久 |
| 每晚戰績 `pokerPlayers/{uid}/nights/{nightKey}` | Firestore | 登入者讀；結帳的人寫（照帳本 cashout 累加） | 永久 |
| 快取 `poker.v2.*` | localStorage（只當備援） | 本機 | 保留 |

規則：會留下紀錄的資料一律存 Firestore，localStorage 只當備援和快取。

## 6. 技術

### 6.1 架構與部署
- **前端**：純靜態網頁，不用建置工具，沿用 ES module。放在 Firebase Hosting：`https://tony-poker.web.app/`（宗良 選方案A，§8.3.1）。程式碼仍放 repo `tony197653/bot` 的 `poker/`，但發布不走 GitHub Pages。
- **發布**（取代 GitHub Pages）：
  - `poker/firebase/firebase.json` 同時管 Hosting 和 Firestore（規則、索引）。`hosting.public` 是 `public`（不進 git）：部署前先執行 `poker/firebase/stage.sh`，把 repo 的 `poker/` 和 `lib/` 複製成 `public/poker/`、`public/lib/`（只是複製，不是建置工具），所以 `../lib/auth/auth.js` 的相對路徑不變。根網址 `/` 302 轉到 `/poker/`。JS、CSS、HTML 設 `Cache-Control: no-cache`，更新後重新整理就拿到新版。
  - 正式版：`firebase deploy --only hosting,firestore:rules,firestore:indexes --project tony-poker`。PM 在雲端代理（cloud agent）用 CI 權杖執行，或用 GitHub Action（`FirebaseExtended/action-hosting-deploy`，`channelId: live`）在合併到 main 時自動部署。
  - 預覽：`firebase hosting:channel:deploy pr-<編號> --expires 7d`，網址像 `https://tony-poker--pr-12-xxxx.web.app`；GitHub Action 對 PR 自動開預覽頻道。QA 用預覽網址驗收，通過才部署正式版。
  - 預覽頻道的網域不在授權網域裡，所以預覽網址上的 Google 登入要用 `tony-poker.firebaseapp.com` 轉址（`sameDomainAuth` 自動判斷，§8.2）；或在 Authentication 加上該預覽網域。
- **Firebase**：開一個新的、專用的免費 Firebase 專案（建議 ID `tony-poker`，Spark 方案）。
  - Firestore 用 Standard 版 `(default)` 資料庫，地區 `asia-east1`（彰化，最近）。
  - Authentication 只開 Google。授權網域：`tony-poker.web.app`、`tony-poker.firebaseapp.com`（Firebase 預設就有）、`localhost`；QA 用的預覽頻道網域需要時再加。
- **SDK**：Firebase JS SDK 10.14.1，從 `https://www.gstatic.com/firebasejs/10.14.1/` 用動態 `import()` 載入（跟 stay-quiz 一樣）。8 秒逾時就進離線模式。
- **快取**：Firestore 用記憶體快取（不開 IndexedDB 持久化，避免多分頁鎖和舊資料）。自己的 localStorage 快取放 `poker.v2.*`。

### 6.2 誰說了算（權威模型）
- **房主那台是發牌員和裁判**。它執行第一階段的 `applyAction`，維護完整狀態（含牌堆和所有手牌）。
- 房主寫入三種資料：
  - 公開狀態：不含牌堆，也不含沒亮出的手牌。
  - 每個人的手牌文件。
  - 帳務事件（帶入後讓人坐下、補碼、結帳），和公開狀態同一筆房間寫入（§6.10）。
- **牌堆只放在房主記憶體**，不存雲端（業界做法：重發一手比還原牌堆簡單）。房主重新整理或換房主時，這一手作廢、退回這手開始的 stacks，重新洗牌。
- **其他人只送「意圖」**。每人一份 `intents/{uid}` 文件，用覆寫、`seq` 遞增，不會一直新增文件。房主監聽 intents 集合，驗證後執行 `applyAction`。不合法的意圖直接丟掉，並在公開狀態的 `rejects[uid]` 寫一個簡短理由。
- 房主自己的動作也走同一條路（在本機直接執行，不寫 intent），所以邏輯只有一套。
- 房主的「發牌循環」和「畫面動畫」分開跑。房主手機的動畫慢，不會拖慢規則執行。房主的畫面也跟其他人一樣，從公開狀態的差異來播動畫。
- **房主循環什麼時候跑**（EGM #7）：只要房主的 App 開著、分頁可見，不管在哪個畫面（牌桌、大廳、戰績）都在跑；不綁在牌桌畫面。分頁切到背景或鎖螢幕＝斷線，交給 §6.7 的接手機制，不在背景硬跑。

### 6.3 公開狀態格式（`pokerRooms/{roomId}.pub`）
- 新增 `view.js` 的 `publicState(state)`，以第一階段 `serializeState` 為基礎，再做這些處理：
  - 刪掉 `deck`。
  - 每個座位的 `hole` 換成 `null`，只有在攤牌被亮出時才放牌面。
  - 加上 `handNo`、`actionSeq`（每次動作 +1，給客戶端排動畫用）、`lastAction {seat, type, amount}`。
- **安全底線**（要寫單元測試）：`JSON.stringify(pub)` 不可以出現任何一張還沒公開的牌。
- 大小估計：6 人 < 4 KB，遠低於單一文件 1 MiB 的上限。

### 6.4 計時（EGM #11 簡化：只有房主判逾時）
- **只有房主判斷逾時，而且用房主自己的時鐘**。房主輪到某人時，在本機記 `deadlineLocal = Date.now() + 30000`，同一筆寫入放 `deadlineAt = deadlineLocal` 和 `pub.hostClockAt = Date.now()`（兩個都是房主本機毫秒，只給畫面算剩餘時間）。
- 房主在 `deadlineLocal + 1000 ms`（1 秒寬限，吸收網路延遲）時執行 TIMEOUT。
- **其他人不估伺服器時間差**。收到快照的那一刻記 `recvAt = Date.now()`，剩餘時間＝`(deadlineAt − pub.hostClockAt) − (Date.now() − recvAt)`。兩台手機的時鐘差不會影響結果，只差網路延遲（約 0.1～0.5 秒）。每秒更新文字，光環用 CSS 動畫跑完剩下的時間。
- 拿掉 v1 的 `serverNow()`／offset 中位數估算（presence 不再拿來對時）。
- 第一階段的 `ARM_DEADLINE` 延後機制：多人模式改成房主在發牌動畫的預估時間（`estimateDealTotalMs` 的多人版，不含換人步驟）之後才開始計時、寫 `deadlineAt`。
- **意圖去重和晚到**（EGM #1）：意圖帶 `handNo` 和 `turn`（送出時看到的 `pub.actionSeq`）。房主只套用 `handNo`＝目前這手、`turn`＝目前 `actionSeq`、而且是他回合的意圖；其他一律丟掉（不寫 rejects，避免重送時跳錯誤）。所以同一個動作送兩次也只會套用一次；逾時後才到的意圖因為 `actionSeq` 已經前進，自動無效。
- **重送**：送出 8 秒還沒看到 `actionSeq` 前進，就用同樣的 `type／amount／handNo／turn`、新的 `seq`（規則要求 seq 變大）再送一次，最多 2 次；之後按鈕解鎖並顯示「沒送到，再按一次」。意圖不碰籌碼帳戶，重送最壞只是被房主丟掉。

### 6.5 動畫同步
- 客戶端把每次收到的 `pub` 跟上一份比較，從差異產生動畫事件（發牌、下注、翻牌、攤牌、入座、暫離、換房主、補籌碼），放進佇列依序播放。
- **跳到最後狀態**（不播中間動畫）的條件，符合任一項就跳：
  - 快照比 `updatedAt` 晚超過 1.5 秒到。
  - 分頁原本是隱藏的。
  - 佇列超過 3 筆。
  - 剛重新連線。
  - `actionSeq` 跳號（新的 `actionSeq` − 上一份 > 1，代表中間漏了快照）。
- 規則：**重連一律不重播**。

### 6.6 寫入節流與用量保護
- 房主的公開狀態寫入合併：250 ms 內的多次變更只寫最後一份，用 `update()` 寫欄位，不用 `set()`。
- 本機每日寫入計數 `poker.v2.quota = {date, writes}`（EGM #13）：
  - **換日點用 America/Los_Angeles 的午夜換算**，不寫死台北 16:00。Firestore 配額在太平洋時間午夜重置：夏令時間是台北 15:00，標準時間是台北 16:00。
  - 算法：`date = new Intl.DateTimeFormat('en-CA', {timeZone:'America/Los_Angeles'}).format(new Date())`（得到 `YYYY-MM-DD`），日期變了就歸零。畫面上的「幾點重置」也從這個時區換算成台北時間顯示。
  - **每台都計數，但只有房主那台的計數會擋**：房主那台 6,000 次時提醒（6-e），8,000 次時不再開新的一手並顯示「今天到這裡」，手上這一手照常打完。一般玩家的計數只寫進 console，不擋任何動作（玩家每手只寫幾次意圖，擋了也沒意義）。
  - 換房主時，新房主用自己那台的計數。
  - 這個計數器只是防止程式跑錯無限寫入的保險絲；全專案的配額估算見第 10 章。
- presence 心跳：
  - 一般玩家：分頁可見時每 30 秒一次。
  - 房主：只在 10 秒內沒有寫過房間文件時才補一次心跳。

### 6.7 斷線、暫離、換房主
- **暫離判定**：房主每秒檢查每個在座者的心跳 `presence.beat`。判斷方式：房主收到心跳快照時用自己的 `Date.now()` 記下「最後一次看到心跳變動」，超過 60 秒沒變動就在 pub 標記 `away[seat]=true`（不用伺服器時間差，EGM #11）。暫離的人輪到時，房主立刻代為過牌，不能過牌就蓋牌。下一手 START_HAND 跳過暫離的人。心跳恢復就清掉標記。
- **入座時間**（EGM #6）：pub 新增 `seatedAt[6]`（伺服器毫秒，空位為 0）。房主執行 SEAT 時把那一格設成當下的伺服器時間估計值：房主自己上一次寫入後讀回的 `updatedAt`（伺服器時間）＋從那之後本機經過的毫秒。（Firestore 的 `serverTimestamp()` 不能放在陣列裡，所以用估計值；只拿來排先後，誤差不影響。換房主後新房主也用同一套伺服器時間基準，不會亂序。）UNSEAT 時歸 0。
- **接任順序**：沒有暫離（`away[seat] != true`）的在座者裡，`seatedAt` 最早的排第 1，其次第 2，依此類推（照 宗良 定的「最早入座、還在線的人接手」）。
- **換房主（接手）**：
  - 客戶端判斷（寬鬆）：在座的人收到房間快照時記 `recvAt`；`Date.now() − recvAt > 30000`（房間 30 秒沒有任何更新），就照接任順序排隊：第 k 順位等 k×3 秒，再用交易搶房主。
  - 嚴格判斷交給規則：交易寫入時，規則用 `request.time` 檢查 `updatedAt` 和房主心跳都超過 30 秒（§9.4 `isTakeover`）。時間還沒到就會被拒，客戶端 5 秒後再試。交易裡也檢查 `rev`，所以只有一人會成功。
- **房主離座**（EGM #7）：房主按離座時不立刻空位。等這手 HAND_OVER，房主那台用**同一筆**房主寫入：`hostUid` 改成接任順序第 1 位、`hostSince = serverTimestamp()`、空出自己的座位。規則要求新房主寫入前後都在座（§9.4 `isHostWrite`）。沒有其他在座的人時不能離座，提示先收桌。
- **切到背景**：房主分頁隱藏＝斷線。不在背景跑循環，不另外交棒；回來時如果已經被接手，就降為一般玩家。
- **作廢**（EGM #2，業界：發錯牌／當機＝這手不算，籌碼退回這手開始時）：接手的新房主（或重新整理後牌堆不見的原房主）執行 `VOID_HAND {stacks: 房間.stacks}`：每個人的籌碼回到這手開始的存檔點、底池清空，按鈕位置不前進，3 秒後重新洗牌開新的一手。**不碰任何人的帳戶、帳本、每晚戰績**，`chipTotal` 也不變（規則照樣檢查加總）。
- **原房主回來**：降為一般玩家，不搶回房主。

### 6.8 引擎改動（`game.js`，只新增，不改舊的）
| 新 action | 作用 |
|---|---|
| `SET_AWAY {seat, away}` | 標記或清除暫離；暫離的人不參加下一手 |
| `VOID_HAND {stacks}` | 照房間的 `stacks`（這手開始的存檔點）還原每格籌碼、清空底池，phase 回到 HAND_OVER，按鈕位置不前進；`handNo` 照樣 +1（下一手重新洗牌） |
| `TOP_UP {seat, amount}` | 只在 HAND_OVER 或 LOBBY、這格籌碼 0、`amount == config.topUpAmount` 時可用；只改引擎裡那一格的籌碼。房主那台要和房間 `stacks`、帳本 topup 同一個 batch 寫出去（§6.10） |
| `SEAT {seat, uid, chips}`（沿用） | 多人模式的 `chips`＝帳本 buyin 的金額，不再用 config 的起始籌碼 |

- **牌局中入座**：不改引擎。房主把 SIT 意圖排進佇列，等 HAND_OVER 再執行 SEAT；pub 另外放 `pendingSeats` 給畫面顯示「下一手加入」。
- **牌局中離座**：先代為 FOLD，等 HAND_OVER 再執行 UNSEAT。
- **多人模式**：不用 `PLAYER_READY`、`REQUEST_PAUSE`、換人畫面。`config.multiplayer=true` 時，`ARM_DEADLINE` 由房主依 §6.4 處理。

### 6.9 限制與效能預算
- 支援 iOS Safari 16 以上、Android Chrome、桌機 Chrome、Edge、Safari。
- 首屏（大廳快取）1 秒內畫出來。Firebase SDK 用動態載入，不擋首屏。
- 動畫 60fps，只動 transform 和 opacity。
- 從房主收到意圖到所有人看到結果，目標 < 600 ms（同一個 Wi-Fi 下）。

### 6.10 籌碼模型：帶入 → 桌上 → 結帳（業界標準）
v1 的「每手結算單寫回每個人的總帳」整個拿掉（含 `settle`、`pendingLedger`、牌堆祕密文件）。改用業界共通的兩層籌碼：**帳戶**（`pokerPlayers/{uid}.bank`，像賭場的籌碼櫃台 Cashier）和**桌上籌碼**（房間的 `stacks[6]`）。帳戶只在入座、補碼、離座時改；每一手只改房間一份文件。

#### 6.10.1 業界做法對照
| 業界做法 | 來源 | 我們怎麼做 |
|---|---|---|
| 兩層籌碼：帳戶餘額和桌上籌碼分開；入座「帶入」、離桌「帶走」 | WSOP 房規 https://www.wsoponline.com/nv/legal/house-rules ；OpenPoker https://github.com/hpyhacking/openpoker | `bank`／`inPlay`／`tableRoomId`；房間 `stacks[6]` |
| 帳本：每人一列「帶入、帶走、淨輸贏」，全桌淨輸贏加總 0 | Poker Now Ledger https://www.pokernow.com/blog/session-ledger-buy-in-buy-out-summary 、https://www.pokernow.com/blog/update-january-11-2021 、使用心得 https://note.com/tsuruhato/n/n9435a68d609b | 帳本 `ledger` 只新增；每晚戰績 net＝帶走 − 帶入（含補碼）；戰績頁顯示加總 |
| 手牌中途斷線／當機：這手作廢，籌碼退回這手開始時 | PokerStars https://www.pokerstars.com/help/articles/server-crash-web-article/ ；WSOP 房規（misdeal） | `VOID_HAND` 退回 `stacks`，不碰帳戶 |
| 每手結束記入桌上籌碼，不是每手改帳戶 | PokerStars https://www.pokerstars.com/help/articles/ring-explanations/ ；PokerTH https://github.com/pokerth/pokerth | `stacks` 每手存檔，帳戶每晚只改幾次 |
| 私人局補碼要房主核准、次數公開 | Pokerrrr 2 https://www.ratepokerclub.com/pokerrr2/how-to-host 、https://professionalrakeback.com/pokerrrr-2-app-review ；PPPoker 籌碼櫃台 https://www.ratepokerclub.com/pppoker/create-club/counter ；Poker Now MTT https://www.pokernow.com/mtt | 補碼＝加買，房主核准（房主可以核准自己），`sess[i].topUps` 全桌看得到 |
| 金額移動放在同一個交易／batch，帳本只新增、用固定編號防重複 | Firestore 交易 https://firebase.google.com/docs/firestore/manage-data/transactions ；規則條件 https://firebase.google.com/docs/firestore/security/rules-conditions ；複式帳本 https://www.harshmittal.dev/build/double-entry-ledger-design | 每個帳務事件一個 batch；帳本編號固定＝冪等鍵，規則 `allow update, delete: if false` |

完整調研：`chip-industry-research.md`。

#### 6.10.2 每個事件誰寫、寫什麼（一個事件＝一個 batch）
| 事件 | 寫入者 | batch 內容 | 規則重點（§9.4） |
|---|---|---|---|
| 第一次來（進 ④ 時沒有帳戶） | 本人 | 建 `pokerPlayers/{uid}`：`bank = N`（這房的 `newPlayerChips`）、`inPlay 0`、`total = N`、`tableRoomId null`＋帳本 `{roomId}_0_grant` | N 對得上房間設定；帳本同時存在 |
| **入座＝帶入**（方案①，宗良 已選） | 本人 | 帳戶：`inPlay = bank`、`bank = 0`、`tableRoomId = roomId`、`sessionNo + 1`＋帳本 `{roomId}_{sessionNo}_buyin`；之後送 SIT 意圖 | 原本沒坐任何桌；是成員、房間開著；帳戶全部帶上桌 |
| 房主讓他坐下 | 房主 | 房間：`seatUids[i]`、`stacks[i] = inPlay`、`chipTotal += inPlay`、`sess[i] = {uid, sessionNo, buyIn, topUps:0, topUpChips:0, hands:0, nightKey, startAt}`（startAt 用手機時間 `Timestamp.now()`，因為陣列裡不能放 serverTimestamp；規則接受跟 `request.time` 相差 ±10 分鐘內）、`lastMoneyEvent = {uid, id, seat, type:'buyin', amount}` | 讀帳本和帳戶（`getAfter`），金額和 sessionNo 要一致；兩手之間才可以 |
| **每一手結束** | 房主 | **只寫房間**：HAND_OVER 的 pub＋`stacks`＋參加者 `sess[i].hands + 1` | Σ`stacks` = `chipTotal`（同一份文件，0 次 get）；座位和 `chipTotal` 不能動；**不能跟結帳、補碼、入座合在同一筆寫入**（有帳務事件的寫入，其他座位的 sess 連 hands 都不能改），要分開寫 |
| **補碼＝加買** | 房主（核准自己也可以） | 房間：`stacks[i]` 0 → 2,000、`chipTotal += 2000`、`sess[i].topUps + 1`、`topUpChips + 2000`、`lastMoneyEvent`＋帳本 `{roomId}_{sessionNo}_topup{n}` | 原本這格 0；金額＝`config.topUpAmount`；n＝新的 topUps |
| **離座＝結帳**（自己離座、被請出、收桌、房主交棒後空出座位） | 房主 | 房間：座位空出、`stacks[i] = 0`、`chipTotal −= 帶走`、`sess[i] = null`、`lastMoneyEvent`＋帳本 `{roomId}_{sessionNo}_cashout`（帶走＝`stacks[i]`，附 sess 那一列）＋帳戶 `bank += 帶走`、`inPlay 0`、`total = bank`、`tableRoomId null`、累加 `topUps／topUpChips／handsPlayed`＋`nights/{nightKey}` 累加 | 帶走＝房間 `stacks[i]`；一人一個 batch，誰失敗只影響他自己 |
| **自救結帳**（房主失聯 10 分鐘以上、或房間已收桌，自己還在座） | 本人 | 帳本 cashout（照房間最後的 `stacks[i]`、`sess[i]`）＋帳戶＋nights；房間不動 | 房間 closed，或 `updatedAt` 和房主心跳都超過 10 分鐘（業界：錢卡在桌上會自動退回） |
| 取消帶入（帶入了但沒被安排座位，房主失聯或已收桌） | 本人 | 帳本 cashout（金額＝`inPlay`，其他 0）＋帳戶＋nights | 自己不在座位上 |
| 自救後座位還在 | 房主（之後回來的或新房主） | 只寫房間：照已存在的帳本 cashout 空出座位、`stacks[i] = 0` | 帳本已存在、金額相同；不再寫帳戶 |
| **作廢** | 新房主 | 只寫房間：pub 回到 `stacks`，重新洗牌 | 不碰帳戶；`chipTotal` 不變 |

- **冪等**：帳本編號固定，重送時 `create` 會因為已存在被拒；客戶端收到 permission-denied 就先讀那筆帳本，存在就當成功。
- **防重複結帳**：結帳後 `tableRoomId = null`，同一個 sessionNo 的 cashout 只能建一次。房主寫結帳前先讀他的帳戶：`tableRoomId` 已經是 null（他自救過），就只空出座位（上表「自救後座位還在」）。
- **新房主上任**：讀一次在座者的帳戶，`tableRoomId` 不是這桌的就照上一條空出座位。

#### 6.10.3 一致性
1. 每手只寫房間一份文件（Firestore 單一文件寫入是原子的），不會「結算寫了一半」，也不需要補寫佇列。
2. 桌上不會無中生有：規則直接檢查 Σ`stacks` = `chipTotal`；`chipTotal` 只能隨一筆帳務事件（`lastMoneyEvent`＋同時新增的帳本）改變。
3. 房主那台每次寫入前自檢 Σ`pub` 籌碼＋底池＝`chipTotal`，不相等就不寫，顯示「籌碼對不上，請收桌」並記 console。
4. 規則擋不了的：房主把底池分錯人（總數仍對）——宗良 已接受（待決 #8）；每筆帶入、補碼、帶走都在帳本可查。

#### 6.10.4 戰績怎麼算
- **每晚淨輸贏**＝帶走 ＋ 還在桌上的 − 帶入（含補碼）：
  - 已結帳的：讀 `nights/{nightKey}`（`net = cashOut − buyIn`，`buyIn` 已含補碼）。
  - 還在座的：用房間的 `stacks[i] − sess[i].buyIn − sess[i].topUpChips` 即時算（Poker Now 公式）。
  - 補碼次數 `topUps` 另外一欄顯示，不算成贏。戰績頁底部顯示「今晚加總 0」（全部結帳後一定是 0）。
  - `nightKey`＝入座時間（台北 06:00 換日），跨過 06:00 才離座也算入座那一晚。
- **總排行**＝`total`（＝`bank + inPlay`），所有登入的人都看得到；坐在桌上的人標「牌桌中」，數字是入座時帶上去的金額，結帳後才更新。

---

## 7. 驗收

| # | 項目 | 怎麼測 | 通過標準 |
|---|---|---|---|
| 1 | 版面 | 390×844 和 1280×800 各截全部畫面（wf-01～wf-08 的每一格） | 沒有重疊、沒有被切掉的字、沒有橫向捲動；跟線框的分區一致 |
| 2 | 手牌不外洩 | 單元測試：任意牌局跑 200 手，每一步 `JSON.stringify(publicState(s))` | 不出現任何一張還沒公開的牌 |
| 3 | 規則：手牌 | 模擬器：玩家 B 讀 A 的 `hole/A`、觀眾讀任何 hole | 全部拒絕；A 讀自己的成功 |
| 4 | 規則：籌碼帳戶 | 模擬器：本人直接改自己的 `bank`／`inPlay`（不是帶入）；帶入時 `bank` 沒歸 0 或 `inPlay` ≠ 原 `bank`；已坐一桌再帶入另一桌；房主寫 Σ`stacks` ≠ `chipTotal`；房主沒有帳務事件就改 `chipTotal` 或座位；房主讓人坐下的金額 ≠ 帳本 buyin；同一個 sessionNo 結帳兩次；帳本 update／delete；房主改別人 `sess` 的 buyIn／topUps；牌局中（phase 不是 lobby／hand_over）結帳 | 全部拒絕；正常的帶入、坐下、結帳 batch 成功 |
| 5 | 兩支手機同步 | 兩支實機（iPhone Safari＋Android Chrome）同一個 Wi-Fi 打 20 手 | 兩邊每一手的籌碼、公牌、贏家一致；動作到對方畫面 < 600 ms |
| 6 | 計時 | 輪到的人不動；另把非房主那台的系統時間調快 2 分鐘再測一次 | 30 秒（±1 秒）自動過牌或蓋牌；最後 5 秒光環變警示色（對齊第一階段 `app.js` 的 `leftMs <= 5000`）；調時間的那台倒數仍正確 |
| 7 | 暫離 | 一般玩家關掉分頁 70 秒 | 60 秒後標暫離；輪到時自動過牌／蓋牌；下一手不發牌；位子保留；重開分頁自動回座 |
| 8 | 房主斷線 | 房主開飛航模式；另測「房主切到背景」 | 約 30～35 秒後，沒暫離的在座者裡 `seatedAt` 最早的人接手；橫幅出現；3 秒後新的一手；每人籌碼＝這手開始時的 `stacks`，底池清空，`chipTotal` 不變，沒有任何帳戶、帳本、戰績寫入 |
| 9 | 搶房主 | 兩個候選人同時符合條件（用模擬器把順延時間設 0） | 只有一人成為房主，`rev` 只加 1 |
| 10 | 補碼（加買） | 玩家輸光 → 申請 → 房主核准；房主自己輸光 → 自己核准；模擬器：籌碼不是 0 時補、金額不是 2000、牌局中補、帳本編號 n 跳號 | 桌上籌碼 2000、`chipTotal` +2000、全桌看到「補籌碼 ×N」、帳本多一筆 topup；淨輸贏不把 2000 算成贏；模擬器的 4 種全部拒絕 |
| 11 | 中途加入 | 牌局進行中點空位 | 顯示「下一手加入」，下一手開始時入座並發牌 |
| 12 | 觀眾 | 未入座的成員 | 看得到公牌和下注，看不到任何人的手牌（攤牌亮出的除外） |
| 13 | 戰績 | 打完一晚（含 1 次補碼、1 人中途離座），看排行和今晚 | 總排行依 `total`（帳戶＋牌桌中）排序，在座的人標「牌桌中」；「今晚」淨輸贏＝帶走＋桌上 − 帶入（含補碼），全部結帳後加總 = 0；補碼次數另一欄 |
| 14 | 離線 | 關網路開大廳 | 用快取畫出大廳並顯示離線提示；不能建房，按鈕說明原因 |
| 15 | 減少動態 | 系統開「減少動態效果」 | 只剩 120 ms 淡入淡出，其他動畫直接跳到結果 |
| 16 | 用量 | 4 人打 30 手，看 Firebase 主控台用量 | 每手寫入 ≤ 30（房間約 16、意圖約 8、手牌 4；帳戶、帳本、戰績每手 0 筆）、讀取 ≤ 110（不含心跳）；整晚帳務寫入（帶入、坐下、補碼、結帳）≤ 40 |
| 17 | 登入模組 | 把 `/lib/auth/` 放進一個空白頁 | 照第 8 章的 4 步驟能登入、登出，`users/{uid}` 欄位正確 |
| 18 | App 內建瀏覽器 | 在 LINE 和 Facebook 的聊天裡點分享連結 | LINE：自動跳到外部瀏覽器，網址保留 `room`、`r`；Facebook：顯示 1-e，不出現 Google 的 403 disallowed_useragent 畫面 |
| 19 | iOS 主畫面登入 | 在 `tony-poker.web.app` 加到主畫面後開啟登入（方案A：同網域轉址） | 能登入；關掉再開仍是登入狀態；不出現彈出視窗 |
| 20 | 加入順序 | 已是成員的人再點連結；新成員點連結；連結的 `r` 和房號不符；房間已收桌 | 已是成員：不寫 `members`（0 次寫入）；新成員：1 次寫入；不符或已收：顯示「牌桌已結束」 |
| 21 | 房主離座 | 3 人在座，房主牌局中按離座 | 這手打完後房主交給 `seatedAt` 最早、沒暫離的人，原房主的座位空出；只有房主一人時不能離座 |
| 22 | 延長房號 | 房主按「延長房號 24 小時」；非房主用模擬器改 `expiresAt` | 房主成功、期限＝現在＋24 小時；非房主被拒；收桌後不能延長 |
| 23 | 規則：建房 | 模擬器：多一個欄位、少 `deadlineAt`、`seatUids` 不是 6 格空字串、`seatUids` 有數字 | 全部拒絕 |
| 24 | 用量換日 | 把房主那台系統時區設成台北，模擬美國夏令／標準時間 | 重置時間分別顯示 15:00／16:00；一般玩家那台到 8,000 不擋 |
| 25 | 冪等和重送 | 帶入 batch 送兩次；結帳 batch 送兩次；意圖同一個 `turn` 送兩次（第二次新 seq）；房主寫結帳時網路斷掉再重試 | 第二次被拒（帳本編號已存在），客戶端讀到帳本後當成功；籌碼不會多也不會少；意圖只套用一次 |
| 26 | 自救結帳 | 房主關掉 App，房間 10 分鐘沒更新；另測房主收桌時中途斷網 | 在座者大廳出現「結帳離開」，自己結帳成功（金額＝房間最後的 stacks）；10 分鐘內試被規則拒絕；之後房主回來或新房主上任，只空出座位、不重複入帳 |
| 27 | 取消帶入 | 帶入後還沒被安排座位，房主就失聯 10 分鐘 | 自己結帳退回原數，帳戶回到帶入前 |
| 28 | Hosting 發布 | PR 用 GitHub Action（或 `firebase hosting:channel:deploy`）開預覽頻道；合併後部署正式版 | 預覽網址能打開、QA 在預覽網址驗收；正式版 `https://tony-poker.web.app/` 更新，規則和索引同時部署 |

---

## 8. 可重用登入模組

目的：這次做的登入要能直接搬到之後的網頁專案。所以登入獨立成一個模組，**不知道撲克的存在**；撲克的資料（籌碼、戰績、房間）全部在模組外面。

### 8.1 檔案
| 路徑 | 內容 |
|---|---|
| `/lib/firebase/load.js` | 動態載入 Firebase SDK 10.14.1（gstatic），8 秒逾時；同一頁只初始化一次 app |
| `/lib/auth/auth.js` | 登入邏輯（公開 API 見 8.2）；不碰畫面 |
| `/lib/auth/auth-ui.js` | 可選用的登入按鈕和狀態元件（未登入、載入中、已登入、錯誤），樣式全用 CSS 變數，接專案自己的色票 |
| `/lib/auth/auth.rules` | `users/{uid}` 的安全規則片段（本次放在 `poker-plan/firebase/auth.rules`，搬到 repo 時放這裡） |
| `/lib/auth/README.md` | 接入步驟、API、已知限制 |

repo 結構：`tony197653/bot/lib/…` 跟 `poker/` 同一層；部署到 Firebase Hosting 後網址是 `https://tony-poker.web.app/lib/auth/auth.js`（§6.1 的 `stage.sh` 一起複製）。撲克頁用相對路徑 `../lib/auth/auth.js` 引用。

### 8.2 公開 API
```js
import { initAuth, onUser, getUser, signIn, signOut, getFirebase } from '../lib/auth/auth.js';

await initAuth({
  firebaseConfig,                 // 必填，專案自己的設定
  usersCollection: 'users',       // 個人資料集合名稱
  storageKey: 'auth.v1',          // localStorage 快取的 key 前綴
  touchIntervalMs: 6 * 3600e3,    // lastSeen 最多 6 小時更新一次（省寫入）
  timeoutMs: 8000,                // SDK 或登入逾時就回報 offline
  mode: 'auto',                   // 'popup' | 'redirect' | 'auto'（auto：一般用彈出視窗，被擋或 iOS 主畫面改轉址，§8.3.1）
  sameDomainAuth: true,           // authDomain 和網頁同網域才可以轉址；模組再比對 location.host，不同網域（例如 Hosting 預覽頻道）自動當成 false、只用彈出視窗
});

const stop = onUser(({ status, user, error, fromCache }) => { … });  // 回傳取消訂閱函式
getUser();        // 目前的 user 或 null（同步）
await signIn();   // Google 登入
await signOut();  // 登出，並清掉本模組的快取
getFirebase();    // { app, auth, db, fs }：給專案自己的資料層用同一個 app
```
- `status`：`signed-out`｜`loading`｜`signed-in`｜`error`｜`offline`｜`in-app-browser`（偵測到 App 內建瀏覽器，畫面顯示 1-e）。
- 另外匯出 `detectInAppBrowser()`：回傳 `null` 或 `{app:'line'|'facebook'|'instagram'|'other', reopenUrl}`。
- `user`：`{ uid, displayName, photoURL }`。**不存、不回傳 email**（不需要，少一個個資）。
- `error`：`{ code, message }`，`message` 是給使用者看的繁中短句（例：「登入視窗被擋住了，請允許彈出視窗後再試一次」）。
- `fromCache`：`true` 表示是 localStorage 的上次登入資料，還沒跟 Firebase 確認。

### 8.3 行為

#### 8.3.1 放在哪裡、怎麼登入（宗良 已選方案A）

| 項目 | 定案 |
|---|---|
| 網址 | `https://tony-poker.web.app/`（Firebase Hosting） |
| authDomain | `tony-poker.web.app`（和網頁同網域） |
| `initAuth` 設定 | `mode:'auto'`、`sameDomainAuth:true` |
| 登入方式 | 一般瀏覽器用彈出視窗；彈出被擋（`auth/popup-blocked`）或 iOS 主畫面（`navigator.standalone`）改用轉址，同網域所以轉址回來拿得到結果（iOS 16.1 以後跨網域轉址拿不到結果，同網域就沒有這個問題） |
| 部署 | §6.1：`firebase deploy`（雲端代理或 GitHub Action），預覽用 Hosting 預覽頻道 |
| 預覽頻道 | 網域是 `tony-poker--<頻道>-<雜湊>.web.app`，和 authDomain 不同網域，模組自動只用彈出視窗；QA 在桌機或一般 Safari 測登入，iOS 主畫面版的轉址登入在正式網址測（§7 #19） |
| 第一天驗證 | 先把空白頁部署到 `tony-poker.web.app`，在 iPhone 主畫面版測轉址登入（§13.3 第 1 步） |

#### 8.3.2 App 內建瀏覽器（EGM #4）
- Google 不允許在 App 內建的瀏覽器登入（回 `403 disallowed_useragent`）。所以 `initAuth` 一開始先跑 `detectInAppBrowser()`：
  - User-Agent 有 `Line/` → LINE：在網址加 `openExternalBrowser=1`（保留原本的 `room`、`r`）後 `location.replace()`，LINE 會改用外部瀏覽器開。開完還在 LINE 裡（舊版 LINE）就顯示 1-e。
  - 有 `FBAN`／`FBAV`／`FB_IAB`（Facebook、Messenger）或 `Instagram` → 直接顯示 1-e：「用瀏覽器開啟」（Android 用 `intent://` 開 Chrome；iOS 沒有可靠的方法，改成複製網址＋教學）。
  - 其他已知的 WebView（Android `; wv)`）→ 也顯示 1-e。
- 在 1-e 不呼叫 `signIn()`，不會跳出 Google 的錯誤頁。
- **Safari 和 iOS 主畫面版的 localStorage 不共用**：在 Safari 登入過，主畫面版第一次開還是未登入，要再登入一次；`auth.v1.*` 和 `poker.v2.*` 快取也各自一份。1-c「用 Safari 開啟」的提示要講清楚這件事。

- **持續登入**：`browserLocalPersistence`，關掉瀏覽器再開仍是登入狀態。
- **個人資料**：第一次登入建立 `users/{uid}` = `{displayName, photoURL, createdAt, lastSeen}`（時間都用 `serverTimestamp()`）。之後每次開頁，距上次 `lastSeen` 超過 `touchIntervalMs` 才更新。名字或頭像跟 Google 不同時順便更新。
- **離線備援**：成功登入後把 `{uid, displayName, photoURL, at}` 存進 `localStorage[storageKey + '.user']`。
  - 開頁先用快取發一次 `status:'signed-in', fromCache:true`，畫面不用等網路。
  - SDK 8 秒沒載入 → `status:'offline'`，仍帶著快取的 user。專案自己決定離線時能做什麼。
  - `signOut()` 會清掉這份快取。
- **錯誤**：`auth/popup-closed-by-user` 不算錯誤，回到 `signed-out`；其他錯誤 → `error`，畫面有「再試一次」。`auth/popup-blocked` 在同網域時自動改轉址；不同網域（預覽頻道）時顯示「登入視窗被擋住了，請允許彈出視窗後再試一次」。
- **不做的事**：不管角色權限、不管專案資料、不存 email、不做 email／密碼登入。

### 8.4 另一個專案怎麼接（4 步驟）
1. 把 `/lib/firebase/` 和 `/lib/auth/` 複製過去（或同 repo 直接引用）。
2. 在 Firebase 主控台開 Google 登入，授權網域加上新網站的網域。新網站放 Firebase Hosting 就用同網域 authDomain（`sameDomainAuth:true`，像撲克）；放別的地方（例如 GitHub Pages）就用 `mode:'popup'`（跨網域不能轉址）。
3. 把 `auth.rules` 貼進該專案的 `firestore.rules`（`// ===== [AUTH MODULE] =====` 那一段整段貼）。
4. 頁面裡：`await initAuth({firebaseConfig})`，`onUser()` 依 `status` 切換畫面；要讀寫專案資料時用 `getFirebase()` 拿 `db`。

### 8.5 撲克怎麼用它
- `poker/js/app.js` 呼叫 `initAuth`，`onUser` 決定顯示 wf-01 的哪一格。
- 撲克自己的資料在 `poker/js/net/`：`ledger.js` 用 `user.uid` 建 `pokerPlayers/{uid}`（帳戶＋帳本 grant，§6.10）。登入模組完全不知道 `pokerPlayers`。
- 撲克的 localStorage 用 `poker.v2.*`，登入模組用 `auth.v1.*`，互不覆蓋。

---

## 9. Firestore 模型與完整規則

### 9.1 集合
| 路徑 | 欄位 | 寫入者 |
|---|---|---|
| `users/{uid}` | displayName, photoURL, createdAt, lastSeen | 本人（登入模組） |
| `pokerRooms/{roomId}` | name, code, hostUid, hostSince, members[], seatUids[6], status(open/closed), config{sb, bb, newPlayerChips, actionMs:30000, topUpAmount:2000}, rev, createdAt, updatedAt, pub{…}, deadlineAt, stacks[6], chipTotal, sess[6], lastMoneyEvent | 房主；加入的人只加自己到 members |
| `…/intents/{uid}` | type, seq, amount, seat, handNo, turn, at | 本人 |
| `…/hole/{uid}` | cards[≤2], handNo, updatedAt | 房主 |
| `…/presence/{uid}` | beat, vis | 本人 |
| `pokerCodes/{code}` | roomId, hostUid, createdAt, expiresAt(+24h，房主可延長到現在＋24h) | 房主 |
| `pokerPlayers/{uid}` | displayName, photoURL, bank, inPlay, total(＝bank＋inPlay), tableRoomId, sessionNo, topUps, topUpChips, handsPlayed, lastRoomId, createdAt, updatedAt | 本人建立、改名字、帶入；結帳時房主或本人（照同一個 batch 的帳本 cashout） |
| `pokerPlayers/{uid}/ledger/{entryId}` | type(grant/buyin/topup/cashout), amount, roomId, sessionNo, seat, buyIn, topUps, topUpChips, hands, nightKey, bankAfter, by, at | grant、buyin：本人；topup：房主；cashout：房主或本人自救。只能新增 |
| `pokerPlayers/{uid}/nights/{YYYYMMDD}` | nightKey, uid, name, buyIn(含補碼), cashOut, net, topUps, hands, lastEntry, updatedAt | 結帳的人（照帳本 cashout 累加） |

- `pub` 內容：第一階段狀態去掉牌堆和未公開手牌，加上 `handNo`、`actionSeq`、`lastAction`、`away{}`、`seatedAt[6]`（v2，伺服器毫秒估計值，空位 0，§6.7）、`hostClockAt`（v2，房主本機毫秒，§6.4）、`pendingSeats[]`、`topUpReqs{}`（申請補碼的座位）、`rejects{}`。v1 的 `handStartChips` 拿掉，改用房間的 `stacks`（每手開始的存檔點）。
- 房間籌碼欄位（§6.10）：`stacks[6]`（這手開始前每格的桌上籌碼，空位 0）、`chipTotal`（＝Σstacks，只隨帳務事件改變）、`sess[6]`（每格這次入座的帳 `{uid, sessionNo, buyIn, topUps, topUpChips, hands, nightKey, startAt}`，空位 null）、`lastMoneyEvent`（`{uid, id, seat, type, amount}`，最近一筆帳務事件，指向帳本編號）。
- 每晚淨輸贏＝帶走＋還在桌上的 − 帶入（含補碼）：已結帳的看 `nights.net`；在座的用 `stacks[i] − sess[i].buyIn − sess[i].topUpChips`（§6.10.4）。
- `nightKey`：台北時間，06:00 換日（凌晨 2 點還在打算前一晚）。取入座時間，由房主在讓人坐下時寫進 `sess[i].nightKey`。
- 不刪任何文件、不開 TTL（Spark 方案用不到；資料量小）。

### 9.2 建房與加入的寫入順序
- **建房**（EGM #9）：產生 6 位數字房號 → 交易：讀 `pokerCodes/{code}`，不存在或已過期才寫；同一個交易建立房間。號碼撞到就重抽，最多 5 次。規則用 `getAfter` 互相確認房間和房號指向彼此。
  - 房間文件的欄位**剛好**是：`name, code, hostUid, hostSince, members, seatUids, status, config, rev, createdAt, updatedAt, pub, deadlineAt, stacks, chipTotal, sess, lastMoneyEvent`（17 個，規則用 `hasAll`＋`hasOnly`，多一個少一個都會被拒）。
  - 初始值寫明：`deadlineAt: null`、`seatUids: ['', '', '', '', '', '']`、`members: [自己]`、`status:'open'`、`rev:0`、`stacks:[0,0,0,0,0,0]`、`chipTotal:0`、`sess:[null×6]`、`lastMoneyEvent:null`、`pub.phase:'lobby'`、三個時間都是 `serverTimestamp()`。
  - 房主按「進入牌桌」時，跟大家一樣先帶入（第一次來先建帳戶），再用房主寫入讓自己坐 1 號位（`rev` 變 1）。
- **分享連結**（EGM #8）：`…/poker/?room=房號&r=房間ID`。房號給人看、給人輸入；`r` 讓程式確認沒有連到別人重用的同一個房號。
- **加入順序**（EGM #8）：
  1. `get pokerCodes/{code}`。不存在、過期 → wf-03 錯誤格。網址有 `r` 時，`code.roomId` 必須等於 `r`，不同就顯示「牌桌已結束」（房號已被別人重用）。
  2. 試著 `get pokerRooms/{roomId}`。讀得到＝已經是成員（規則只讓成員讀）→ 直接開始監聽，不寫入。讀得到但 `status:'closed'` → 「牌桌已結束」。
  3. 讀不到（permission-denied）→ `update` 房間：`members: arrayUnion(自己的 uid)`。
  4. 第 3 步也被拒（房間已收桌、成員滿 30 人）→ 顯示「牌桌已結束」。成功 → 開始監聽房間。
- **第一次來**：進 ④ 時讀自己的 `pokerPlayers/{uid}`，不存在就寫一個 batch：帳戶（`bank = config.newPlayerChips`）＋帳本 `{roomId}_0_grant`。
- **入座**（EGM #3）：
  1. 本人 batch：帳戶 `bank → inPlay`（全部帶上桌）、`tableRoomId = roomId`、`sessionNo + 1`＋帳本 `{roomId}_{sessionNo}_buyin`。已經是 `tableRoomId == roomId`（上次帶入了還沒坐到）就跳過這步。
  2. 送 `SIT` 意圖（帶 `seat`）。
  3. 房主在兩手之間寫房間：`seatUids[i]`、`stacks[i] = 帶入金額`、`chipTotal +=`、`sess[i]`、`lastMoneyEvent`、`pub.seatedAt[i]`；引擎執行 `SEAT {chips: 帶入金額}`。規則讀帳本和帳戶確認金額。
- **補碼**：房主核准後一個 batch：房間（`stacks[i]`、`chipTotal`、`sess[i].topUps／topUpChips`、`lastMoneyEvent`、pub）＋帳本 `…_topup{n}`。
- **離座、請出**：房主在兩手之間一個 batch：房間（空位、`stacks[i] = 0`、`chipTotal −=`、`sess[i] = null`、`lastMoneyEvent`、pub）＋帳本 `…_cashout`＋帳戶＋`nights/{nightKey}`。房主自己離座：同一個 batch 再加上交棒（`hostUid`、`hostSince`）。
- **延長房號**（EGM #8）：房主在選單按「延長房號 24 小時」→ `update pokerCodes/{code}`：只改 `expiresAt = 現在＋24 小時`（規則要求房間還開著）。
- **收桌**：房主先逐一替其他在座的人結帳（一人一個 batch），再結帳自己；全部成功後把 `status` 設成 `closed`，並把房號的 `expiresAt` 設成現在。中途失敗的人之後自己自救結帳（§6.10.2）。

### 9.3 監聽（誰聽什麼）
| 誰 | 監聽 | 用途 |
|---|---|---|
| 所有成員（含觀眾） | `pokerRooms/{roomId}` | 公開狀態 |
| 入座玩家 | 自己的 `hole/{uid}` | 手牌（v2 不再監聽自己的 presence 來對時，§6.4） |
| 房主 | `intents` 集合、`presence` 集合 | 收動作；判斷暫離 |
| 接手候選人 | 不另外監聽；房間 30 秒沒更新就直接試交易（嚴格時間由規則判斷，§6.7） | 判斷房主失聯 |
| 新房主（上任時一次） | `get` 每位在座者的 `pokerPlayers/{uid}` | `tableRoomId` 不是這桌（已自救結帳）就空出座位 |
| 大廳、戰績頁 | `get` 自己的 `pokerPlayers/{uid}`；排行 `get` 一次（不監聽） | 顯示帳戶、牌桌中、自救結帳按鈕 |

### 9.4 完整規則（`poker-plan/firebase/firestore.rules`）
規則檔已經寫好，分三段，PM 直接搬到 `poker/firebase/`（v2 改了：`seatUidsOk`、建房 `hasAll`＋`hasOnly`、交棒和接手要求新房主在座、房主延長房號；籌碼改成業界模型：房間 `stacks`／`chipTotal`／`sess`／`lastMoneyEvent` 和 `moneyOk`、帳戶 `bank`／`inPlay`、帳本 `ledger` 只新增、每晚戰績照帳本累加；拿掉 `settle`、牌堆祕密文件）：
- `auth.rules`：登入模組那一段（可單獨貼到別的專案）。
- `poker.rules`：撲克那一段。
- `firestore.rules`：兩段合起來，加上「其他路徑一律拒絕」。

> **2026-11-02 規則修正（宗良已同意）：** PM 用模擬器測過，原本的規則有兩個問題會讓遊戲完全不能玩，這裡照 PM 的 FIX-1～6 修正，修正後 75 項測試全過，測試結果見 `/workspace/poker-p2-rules/report.md`。
> 1. 入座時 `sess[i].startAt` 改成跟 `request.time` 相差 ±10 分鐘內就接受，因為 SDK 不准把 serverTimestamp 放在陣列裡。
> 2. 原本的檢查超過 Firestore「每次評估最多 1000 個運算式」的上限，改成精簡寫法（整格比對、切片比對、let 改成用參數傳），檢查的內容不變。唯一的語意變更：有帳務事件的寫入不能同時改其他座位的 hands。
> 3. 修正後最重的是「第 6 人入座」，大約用掉九成上限。**以後只要改 roomWriteOk 或 buyinSeatOk，都要重跑 `rules.test.mjs`。**

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // ===== [AUTH MODULE] 可重用登入模組：users/{uid} ===============================
    // 這一段可以原樣貼進任何專案的 firestore.rules（放在 match /databases/{database}/documents 裡）。
    // 依賴：無。集合名稱若改了（initAuth 的 usersCollection），把 /users/ 一起改掉。
    function signedIn() { return request.auth != null; }
    function isSelf(uid) { return signedIn() && request.auth.uid == uid; }
    function strOk(v, max) { return v is string && v.size() > 0 && v.size() <= max; }
    function urlOk(v) { return v == null || (v is string && v.size() <= 500 && v.matches('https://.+')); }

    match /users/{uid} {
      allow get: if isSelf(uid);
      allow list: if false;
      allow create: if isSelf(uid)
        && request.resource.data.keys().hasOnly(['displayName', 'photoURL', 'createdAt', 'lastSeen'])
        && strOk(request.resource.data.displayName, 60)
        && urlOk(request.resource.data.get('photoURL', null))
        && request.resource.data.createdAt == request.time
        && request.resource.data.lastSeen == request.time;
      allow update: if isSelf(uid)
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['displayName', 'photoURL', 'lastSeen'])
        && strOk(request.resource.data.displayName, 60)
        && urlOk(request.resource.data.get('photoURL', null))
        && request.resource.data.lastSeen == request.time;
      allow delete: if false;
    }
    // ===== [/AUTH MODULE] =====================================================

    // ===== [POKER] 德州撲克第二階段 ============================================
    // 依賴 AUTH MODULE 的 signedIn()／isSelf()／strOk()／urlOk()。
    // 籌碼模型（業界做法，見規格 §6.10）：帳戶 bank ─帶入→ 桌上 stacks ─結帳→ 帳戶 bank。
    //   打牌中只改房間的 stacks（加總必須 = chipTotal，0 次 get）；帳戶只在帶入、結帳時改；
    //   每筆帶入／補碼／帶走都在帳本 ledger 新增一筆（固定編號＝冪等鍵，只能新增）。
    function roomPath(roomId) { return /databases/$(database)/documents/pokerRooms/$(roomId); }
    function roomOf(roomId) { return get(roomPath(roomId)).data; }
    function playerPath(uid) { return /databases/$(database)/documents/pokerPlayers/$(uid); }
    function ledgerPath(uid, id) { return /databases/$(database)/documents/pokerPlayers/$(uid)/ledger/$(id); }
    function presencePath(roomId, uid) { return /databases/$(database)/documents/pokerRooms/$(roomId)/presence/$(uid); }

    function validConfig(c) {
      return c is map
        && c.keys().hasOnly(['sb', 'bb', 'newPlayerChips', 'actionMs', 'topUpAmount'])
        && c.sb in [5, 10, 25, 50]
        && c.bb == c.sb * 2
        && c.newPlayerChips is int && c.newPlayerChips >= 1000 && c.newPlayerChips <= 100000
        && c.newPlayerChips % 500 == 0
        && c.actionMs == 30000
        && c.topUpAmount == 2000;
    }
    function hostKeys() {
      return ['pub', 'seatUids', 'status', 'rev', 'updatedAt', 'deadlineAt', 'hostUid', 'hostSince',
              'stacks', 'chipTotal', 'sess', 'lastMoneyEvent'];
    }
    // 席次 6 格，每格都是字串（空位 ''，有人＝uid）
    function seatUidsOk(s) {
      return s is list && s.size() == 6
        && s[0] is string && s[0].size() <= 128 && s[1] is string && s[1].size() <= 128
        && s[2] is string && s[2].size() <= 128 && s[3] is string && s[3].size() <= 128
        && s[4] is string && s[4].size() <= 128 && s[5] is string && s[5].size() <= 128;
    }
    // 桌上籌碼 6 格（每手開始前的存檔點），整數、不為負
    function stackOk(v) { return v is int && v >= 0 && v <= 100000000; }
    function stacksOk(s) {
      return s is list && s.size() == 6
        && stackOk(s[0]) && stackOk(s[1]) && stackOk(s[2]) && stackOk(s[3]) && stackOk(s[4]) && stackOk(s[5]);
    }
    function sumOf(s) { return s[0] + s[1] + s[2] + s[3] + s[4] + s[5]; }
    // 帶入、補碼、結帳只能在兩手之間（pub.phase 是 lobby 或 hand_over）
    function betweenHands(p) { return p is map && p.get('phase', '') in ['lobby', 'hand_over']; }

    // 座位 k 沒變，或這次的帳務事件就是座位 k（一次寫入最多一筆帳務事件）
    function seatSame(d, k, ms) {
      return ms == k || d.seatUids[k] == resource.data.seatUids[k];
    }
    // 座位帳（sess）在沒有帳務事件時只能讓 hands 變多，其他欄位不能動（房主不能改別人的帶入、補碼紀錄）
    function sessKeep(a, b) {
      // [FIX-2] 先比整格相等（1 個運算式）；不相等時只允許 hands 變多（用 diff 取代逐欄比較，省運算式）
      return a == b
        || (a != null && b != null
            && b.diff(a).affectedKeys().hasOnly(['hands'])
            && b.hands is int && b.hands >= a.hands);
    }
    // 兩個 6 格陣列除了第 k 格以外都相同
    function othersSame(a, b, k) {
      return a is list && a.size() == 6 && k is int && k >= 0 && k <= 5
        && (k == 0 || a[0:k] == b[0:k])
        && (k == 5 || a[k + 1:6] == b[k + 1:6]);
    }
    function sessSame(d, k, ms) {
      return ms == k || sessKeep(resource.data.sess[k], d.sess[k]);
    }
    // 帶入後坐下：玩家自己先寫了帳戶（tableRoomId、inPlay）和帳本 buyin，房主照那個數字讓他坐下
    function buyinSeatOk(roomId, d, m, e, p) {
      let r = resource.data;
      let s = d.sess[m.seat];  // [FIX-4] 同一格只取一次，省運算式
      return m.uid in r.members
        && r.seatUids[m.seat] == '' && !(m.uid in r.seatUids) && d.seatUids[m.seat] == m.uid
        && d.stacks[m.seat] == m.amount && d.chipTotal == r.chipTotal + m.amount
        && p.tableRoomId == roomId && p.sessionNo == e.sessionNo && p.inPlay == m.amount
        // [FIX-6] 整格一次比對（取代 keys().hasOnly＋逐欄比較，省運算式）
        && s == {'uid': m.uid, 'sessionNo': e.sessionNo, 'buyIn': m.amount, 'topUps': 0, 'topUpChips': 0,
                 'hands': 0, 'nightKey': s.nightKey, 'startAt': s.startAt}
        && s.nightKey is string && s.nightKey.matches('[0-9]{8}')
        // [FIX-1] serverTimestamp() 不能放在陣列裡，客戶端無法讓 sess[i].startAt == request.time；改成 ±10 分鐘內的時間
        && s.startAt is timestamp
        && s.startAt > request.time - duration.value(10, 'm')
        && s.startAt < request.time + duration.value(10, 'm');
    }
    // 補碼（加買）：只能在桌上籌碼 0 時、剛好 config.topUpAmount；房主自己也走這條
    function topupSeatOk(d, m, e) {
      let r = resource.data;
      let s0 = r.sess[m.seat];
      let s1 = d.sess[m.seat];
      return r.seatUids[m.seat] == m.uid && d.seatUids[m.seat] == m.uid
        && r.stacks[m.seat] == 0 && d.stacks[m.seat] == m.amount
        && m.amount == r.config.topUpAmount && d.chipTotal == r.chipTotal + m.amount
        && e.sessionNo == s0.sessionNo
        && s1.uid == s0.uid && s1.sessionNo == s0.sessionNo && s1.buyIn == s0.buyIn
        && s1.nightKey == s0.nightKey && s1.startAt == s0.startAt && s1.hands == s0.hands
        && s1.topUps == s0.topUps + 1 && s1.topUpChips == s0.topUpChips + m.amount;
    }
    // 結帳（帶走）：帶走金額＝這一格的桌上籌碼；座位空出、stacks 歸 0、chipTotal 減掉
    function cashoutSeatOk(d, m, e) {
      let r = resource.data;
      return r.seatUids[m.seat] == m.uid && d.seatUids[m.seat] == ''
        && m.amount == r.stacks[m.seat] && d.stacks[m.seat] == 0
        && d.chipTotal == r.chipTotal - m.amount
        && e.sessionNo == r.sess[m.seat].sessionNo
        && d.sess[m.seat] == null;
    }
    // [FIX-5] let 綁定在每次引用時都會重算（含 getAfter 的路徑組字串），改成用函式參數傳入，只算一次
    function moneyOk(roomId, d) {
      return moneyOk2(roomId, d, d.lastMoneyEvent, resource.data);
    }
    function moneyOk2(roomId, d, m, r) {
      return m is map && m.keys().hasOnly(['uid', 'id', 'seat', 'type', 'amount'])
        && m.seat is int && m.seat >= 0 && m.seat <= 5
        && betweenHands(r.pub) && betweenHands(d.pub)
        && moneyOk3(roomId, d, m, getAfter(ledgerPath(m.uid, m.id)).data);
    }
    function moneyOk3(roomId, d, m, e) {
      return e.roomId == roomId && e.type == m.type && e.amount == m.amount
        && (m.type == 'buyin' || e.seat == m.seat)
        && ((m.type == 'buyin' && buyinSeatOk(roomId, d, m, e, getAfter(playerPath(m.uid)).data))
            || (m.type == 'topup' && topupSeatOk(d, m, e))
            || (m.type == 'cashout' && cashoutSeatOk(d, m, e)));
    }
    // 房主寫入（含交棒、接手）都要符合：rev 加 1、伺服器時間、關了不能再開、
    // 桌上籌碼加總 = chipTotal（同一份文件，0 次 get）；座位和 chipTotal 只能隨一筆帳務事件改變
    function roomWriteOk(roomId) {
      let d = request.resource.data;
      let money = d.lastMoneyEvent != resource.data.lastMoneyEvent;
      return d.rev == resource.data.rev + 1
        && d.updatedAt == request.time
        && d.status in ['open', 'closed']
        && (resource.data.status == 'open' || d.status == 'closed')
        // [FIX-3] 省運算式（上限 1000）：沒變的欄位先用整份相等短路
        && (d.seatUids == resource.data.seatUids || seatUidsOk(d.seatUids))
        && d.pub is map
        && (d.deadlineAt == null || d.deadlineAt is int)
        && d.diff(resource.data).affectedKeys().hasOnly(hostKeys())
        && stacksOk(d.stacks) && d.chipTotal is int && sumOf(d.stacks) == d.chipTotal
        && d.sess is list && d.sess.size() == 6
        // [FIX-4] 有帳務事件時：除了事件那一格，其他格的 seatUids、sess 都要一模一樣（用切片一次比完）；
        //         沒有帳務事件時：seatUids 整份不變，sess 只能讓 hands 變多
        && (money
            ? othersSame(d.seatUids, resource.data.seatUids, d.lastMoneyEvent.seat)
              && othersSame(d.sess, resource.data.sess, d.lastMoneyEvent.seat)
            : d.seatUids == resource.data.seatUids
              && (d.sess == resource.data.sess
                  || (sessSame(d, 0, -1) && sessSame(d, 1, -1) && sessSame(d, 2, -1)
                      && sessSame(d, 3, -1) && sessSame(d, 4, -1) && sessSame(d, 5, -1))))
        && (money || d.chipTotal == resource.data.chipTotal)
        && (!money || moneyOk(roomId, d));
    }

    match /pokerRooms/{roomId} {
      // 加入：只能把「自己」加進成員，其他欄位都不能動
      function isJoin() {
        let d = request.resource.data;
        return resource.data.status == 'open'
          && !(request.auth.uid in resource.data.members)
          && d.diff(resource.data).affectedKeys().hasOnly(['members'])
          && d.members.hasAll(resource.data.members)
          && d.members.size() == resource.data.members.size() + 1
          && request.auth.uid in d.members
          && d.members.size() <= 30;
      }
      // 房主寫入；交棒只能交給在座的人。
      // 房主離座：在 HAND_OVER 用同一筆寫入「交棒＋結帳空出自己的座位」（帳務事件＝自己的 cashout）；
      // 新房主寫入前後都必須在座（d.seatUids 裡也要有），不能交給空位或觀眾。
      function isHostWrite() {
        let d = request.resource.data;
        return request.auth.uid == resource.data.hostUid
          && roomWriteOk(roomId)
          && (d.hostUid == resource.data.hostUid
              || (d.hostUid != '' && d.hostUid in resource.data.seatUids && d.hostUid in d.seatUids
                  && d.hostSince == request.time));
      }
      // 房主失聯 > 30 秒：在座的人可以接手（客戶端依 pub.seatedAt 先後錯開，交易保證只有一人成功）
      // 客戶端只看「房間文件 X 秒沒更新」來決定要不要試；嚴格的時間判斷只在這裡用 request.time。
      // 接手同時作廢這一手：pub 回到 stacks（每手存檔點），不碰任何玩家帳戶。
      function isTakeover() {
        let p = presencePath(roomId, resource.data.hostUid);
        let d = request.resource.data;
        return request.auth.uid in resource.data.seatUids
          && request.auth.uid != resource.data.hostUid
          && resource.data.status == 'open'
          && request.time > resource.data.updatedAt + duration.value(30, 's')
          && (!exists(p) || request.time > get(p).data.beat + duration.value(30, 's'))
          && d.hostUid == request.auth.uid
          && d.hostSince == request.time
          && request.auth.uid in d.seatUids
          && d.lastMoneyEvent == resource.data.lastMoneyEvent
          && roomWriteOk(roomId);
      }

      allow get: if signedIn() && request.auth.uid in resource.data.members;
      allow list: if false;
      // 欄位要剛好這幾個（hasAll＋hasOnly）；deadlineAt 一開始是 null，席次一開始 6 格空字串，
      // 桌上籌碼全 0、chipTotal 0、sess 6 格 null、lastMoneyEvent null。
      allow create: if signedIn()
        && request.resource.data.keys().hasAll(['name', 'code', 'hostUid', 'hostSince', 'members', 'seatUids',
             'status', 'config', 'rev', 'createdAt', 'updatedAt', 'pub', 'deadlineAt',
             'stacks', 'chipTotal', 'sess', 'lastMoneyEvent'])
        && request.resource.data.keys().hasOnly(['name', 'code', 'hostUid', 'hostSince', 'members', 'seatUids',
             'status', 'config', 'rev', 'createdAt', 'updatedAt', 'pub', 'deadlineAt',
             'stacks', 'chipTotal', 'sess', 'lastMoneyEvent'])
        && request.resource.data.deadlineAt == null
        && request.resource.data.seatUids == ['', '', '', '', '', '']
        && request.resource.data.stacks == [0, 0, 0, 0, 0, 0]
        && request.resource.data.chipTotal == 0
        && request.resource.data.sess == [null, null, null, null, null, null]
        && request.resource.data.lastMoneyEvent == null
        && request.resource.data.hostUid == request.auth.uid
        && request.resource.data.members == [request.auth.uid]
        && request.resource.data.status == 'open'
        && request.resource.data.rev == 0
        && request.resource.data.createdAt == request.time
        && request.resource.data.updatedAt == request.time
        && request.resource.data.hostSince == request.time
        && strOk(request.resource.data.name, 20)
        && request.resource.data.code is string && request.resource.data.code.matches('[0-9]{6}')
        && validConfig(request.resource.data.config)
        && betweenHands(request.resource.data.pub)
        // 房號文件必須在同一個 batch 指向這個房間
        && getAfter(/databases/$(database)/documents/pokerCodes/$(request.resource.data.code)).data.roomId == roomId;
      allow update: if signedIn() && (isJoin() || isHostWrite() || isTakeover());
      allow delete: if false;

      // 動作意圖：每人一份，覆寫，seq 只能變大；turn＝送出時看到的 pub.actionSeq（房主用來去重）
      match /intents/{uid} {
        function intentOk() {
          let d = request.resource.data;
          return d.keys().hasOnly(['type', 'seq', 'amount', 'seat', 'handNo', 'turn', 'at'])
            && d.type in ['SIT', 'LEAVE', 'FOLD', 'CHECK', 'CALL', 'BET_RAISE', 'ALL_IN',
                          'SHOW', 'MUCK', 'TOPUP_REQ', 'TOPUP_CANCEL']
            && d.seq is int
            && (d.get('amount', null) == null || (d.amount is int && d.amount >= 0 && d.amount <= 100000000))
            && (d.get('seat', null) == null || (d.seat is int && d.seat >= 0 && d.seat <= 5))
            && d.handNo is int
            && (d.get('turn', null) == null || d.turn is int)
            && d.at == request.time
            && request.auth.uid in roomOf(roomId).members;
        }
        allow get: if isSelf(uid);
        allow list: if signedIn() && roomOf(roomId).hostUid == request.auth.uid;
        allow create: if isSelf(uid) && intentOk() && request.resource.data.seq >= 1;
        allow update: if isSelf(uid) && intentOk() && request.resource.data.seq > resource.data.seq;
        allow delete: if false;
      }

      // 手牌：只有本人看得到；只有現任房主能寫（牌堆只放在房主記憶體，不存雲端）
      match /hole/{uid} {
        allow get: if isSelf(uid);
        allow list: if false;
        allow create, update: if signedIn()
          && roomOf(roomId).hostUid == request.auth.uid
          && request.resource.data.keys().hasOnly(['cards', 'handNo', 'updatedAt'])
          && request.resource.data.cards is list && request.resource.data.cards.size() <= 2
          && request.resource.data.handNo is int
          && request.resource.data.updatedAt == request.time;
        allow delete: if false;
      }

      // 心跳：本人寫（不查房間，省讀取）；成員讀
      match /presence/{uid} {
        allow get, list: if signedIn() && request.auth.uid in roomOf(roomId).members;
        allow create, update: if isSelf(uid)
          && request.resource.data.keys().hasOnly(['beat', 'vis'])
          && request.resource.data.beat == request.time
          && request.resource.data.vis is bool;
        allow delete: if false;
      }
    }

    // 房號：只能用號碼讀單筆，不能列出；過期可重用；房主收桌時立即失效；
    // 房間還開著時，房主可以把期限延到「現在＋24 小時」（只能改 expiresAt）
    match /pokerCodes/{code} {
      function codeOk() {
        let d = request.resource.data;
        return code.matches('[0-9]{6}')
          && d.keys().hasOnly(['roomId', 'hostUid', 'createdAt', 'expiresAt'])
          && d.roomId is string && d.roomId.size() <= 40
          && d.hostUid == request.auth.uid
          && d.createdAt == request.time
          && d.expiresAt == request.time + duration.value(24, 'h')
          && getAfter(roomPath(d.roomId)).data.hostUid == request.auth.uid;
      }
      allow get: if signedIn();
      allow list: if false;
      allow create: if signedIn() && codeOk();
      allow update: if signedIn() && (
          (resource.data.expiresAt < request.time && codeOk())
          || (roomOf(resource.data.roomId).hostUid == request.auth.uid
              && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['expiresAt'])
              && (request.resource.data.expiresAt == request.time
                  || (roomOf(resource.data.roomId).status == 'open'
                      && request.resource.data.expiresAt == request.time + duration.value(24, 'h')))));
      allow delete: if false;
    }

    // 籌碼帳戶（永久，跨牌局）＝業界的 Cashier／club balance
    //   bank：不在桌上的籌碼；inPlay：帶到桌上的金額（結帳後 0）；total＝bank＋inPlay（排行榜排序用）
    //   tableRoomId：目前坐哪一桌（null＝沒坐，同時只能坐一桌）；sessionNo：第幾次入座（帳本編號用）
    match /pokerPlayers/{uid} {
      function playerKeys() {
        return ['displayName', 'photoURL', 'bank', 'inPlay', 'total', 'tableRoomId', 'sessionNo',
                'topUps', 'topUpChips', 'handsPlayed', 'lastRoomId', 'createdAt', 'updatedAt'];
      }
      // 第一次來：bank＝這房的新玩家起始籌碼；同一個 batch 要有帳本 grant
      function createOk() {
        let d = request.resource.data;
        let r = roomOf(d.lastRoomId);
        return d.keys().hasAll(playerKeys()) && d.keys().hasOnly(playerKeys())
          && strOk(d.displayName, 60) && urlOk(d.get('photoURL', null))
          && d.lastRoomId is string && request.auth.uid in r.members
          && d.bank == r.config.newPlayerChips && d.inPlay == 0 && d.total == d.bank
          && d.tableRoomId == null && d.sessionNo == 0
          && d.topUps == 0 && d.topUpChips == 0 && d.handsPlayed == 0
          && d.createdAt == request.time && d.updatedAt == request.time
          && existsAfter(ledgerPath(uid, d.lastRoomId + '_0_grant'));
      }
      // 本人改名字、頭像、上次的牌桌
      function profileOk() {
        let d = request.resource.data;
        return d.diff(resource.data).affectedKeys().hasOnly(['displayName', 'photoURL', 'lastRoomId', 'updatedAt'])
          && strOk(d.displayName, 60) && urlOk(d.get('photoURL', null))
          && d.lastRoomId is string && d.lastRoomId.size() <= 40
          && d.updatedAt == request.time;
      }
      // 本人帶入（整筆帶入）：bank 全部移到 inPlay；同一個 batch 要有帳本 buyin
      function buyinOk() {
        let d = request.resource.data;
        let r = roomOf(d.tableRoomId);
        return d.diff(resource.data).affectedKeys().hasOnly(['bank', 'inPlay', 'tableRoomId', 'sessionNo', 'lastRoomId', 'updatedAt'])
          && resource.data.tableRoomId == null
          && d.tableRoomId is string && d.lastRoomId == d.tableRoomId
          && request.auth.uid in r.members && r.status == 'open'
          && d.inPlay == resource.data.bank && d.bank == 0 && d.total == resource.data.total
          && d.sessionNo == resource.data.sessionNo + 1
          && d.updatedAt == request.time
          && existsAfter(ledgerPath(uid, d.tableRoomId + '_' + string(d.sessionNo) + '_buyin'));
      }
      // 結帳入帳（房主或本人自救）：照同一個 batch 新增的帳本 cashout 加回 bank，並累加這次的補碼和手數
      function cashoutApplyOk() {
        let d = request.resource.data;
        let e = getAfter(ledgerPath(uid, resource.data.tableRoomId + '_' + string(resource.data.sessionNo) + '_cashout')).data;
        return resource.data.tableRoomId != null
          && d.diff(resource.data).affectedKeys().hasOnly(['bank', 'inPlay', 'total', 'tableRoomId', 'topUps', 'topUpChips', 'handsPlayed', 'updatedAt'])
          && e.type == 'cashout' && e.at == request.time && e.by == request.auth.uid
          && d.bank == resource.data.bank + e.amount && d.inPlay == 0 && d.total == d.bank
          && d.tableRoomId == null
          && d.topUps == resource.data.topUps + e.topUps
          && d.topUpChips == resource.data.topUpChips + e.topUpChips
          && d.handsPlayed == resource.data.handsPlayed + e.hands
          && d.updatedAt == request.time;
      }
      allow get: if signedIn();
      allow list: if signedIn() && request.query.limit <= 50;
      allow create: if isSelf(uid) && createOk();
      allow update: if signedIn() && ((isSelf(uid) && (profileOk() || buyinOk())) || cashoutApplyOk());
      allow delete: if false;

      // 帳本（只新增）：編號固定＝冪等鍵
      //   grant：{roomId}_0_grant　buyin：{roomId}_{sessionNo}_buyin
      //   topup：{roomId}_{sessionNo}_topup{n}　cashout：{roomId}_{sessionNo}_cashout
      match /ledger/{entryId} {
        function entryKeysOk(d) {
          return d.keys().hasOnly(['type', 'amount', 'roomId', 'sessionNo', 'seat', 'buyIn', 'topUps',
                                   'topUpChips', 'hands', 'nightKey', 'bankAfter', 'by', 'at'])
            && d.type in ['grant', 'buyin', 'topup', 'cashout']
            && d.amount is int && d.amount >= 0 && d.amount <= 100000000
            && d.roomId is string && d.roomId.size() <= 40
            && d.sessionNo is int && d.sessionNo >= 0
            && d.by == request.auth.uid && d.at == request.time;
        }
        // 第一次來的贈送：本人，和帳戶 create 同一個 batch
        function grantOk(d) {
          let p = getAfter(playerPath(uid)).data;
          return d.type == 'grant' && isSelf(uid)
            && entryId == d.roomId + '_0_grant' && d.sessionNo == 0
            && p.createdAt == request.time && d.amount == p.bank && d.bankAfter == p.bank;
        }
        // 帶入：本人，和帳戶的 buyinOk 同一個 batch
        function buyinEntryOk(d) {
          let p = getAfter(playerPath(uid)).data;
          return d.type == 'buyin' && isSelf(uid)
            && entryId == d.roomId + '_' + string(d.sessionNo) + '_buyin'
            && p.tableRoomId == d.roomId && p.sessionNo == d.sessionNo
            && d.amount == p.inPlay && d.bankAfter == p.bank;
        }
        // 補碼：現任房主（房主自己輸光也可以核准自己），和房間寫入同一個 batch
        function topupEntryOk(d) {
          let r = roomOf(d.roomId);
          return d.type == 'topup' && r.hostUid == request.auth.uid
            && d.seat is int && d.seat >= 0 && d.seat <= 5
            && r.seatUids[d.seat] == uid && r.stacks[d.seat] == 0 && betweenHands(r.pub)
            && d.amount == r.config.topUpAmount
            && d.sessionNo == r.sess[d.seat].sessionNo
            && d.topUps == r.sess[d.seat].topUps + 1
            && entryId == d.roomId + '_' + string(d.sessionNo) + '_topup' + string(d.topUps)
            && getAfter(roomPath(d.roomId)).data.lastMoneyEvent.id == entryId;
        }
        // 房主失聯 10 分鐘以上（房間和房主心跳都沒更新），或房間已收桌
        function hostGone(r, roomId) {
          let hp = presencePath(roomId, r.hostUid);
          return r.status == 'closed'
            || (request.time > r.updatedAt + duration.value(10, 'm')
                && (!exists(hp) || request.time > get(hp).data.beat + duration.value(10, 'm')));
        }
        // 結帳的這一列（Poker Now 的一列）＝房間 sess[seat] 和 stacks[seat]
        function seatRowOk(d, r) {
          return d.seat is int && d.seat >= 0 && d.seat <= 5
            && r.seatUids[d.seat] == uid
            && d.sessionNo == r.sess[d.seat].sessionNo
            && d.amount == r.stacks[d.seat]
            && d.buyIn == r.sess[d.seat].buyIn
            && d.topUps == r.sess[d.seat].topUps
            && d.topUpChips == r.sess[d.seat].topUpChips
            && d.hands == r.sess[d.seat].hands
            && d.nightKey == r.sess[d.seat].nightKey;
        }
        // 結帳：①房主（這一格在同一個 batch 空出）②本人自救（房主失聯或已收桌）
        //       ③本人取消帶入（帶入了但沒被安排座位，且房主失聯或已收桌）：原數退回
        function cashoutEntryOk(d) {
          let r = roomOf(d.roomId);
          let p = getAfter(playerPath(uid)).data;
          return d.type == 'cashout'
            && entryId == d.roomId + '_' + string(d.sessionNo) + '_cashout'
            && p.tableRoomId == null && d.bankAfter == p.bank
            && ((seatRowOk(d, r)
                 && ((r.hostUid == request.auth.uid && getAfter(roomPath(d.roomId)).data.seatUids[d.seat] == '')
                     || (isSelf(uid) && hostGone(r, d.roomId))))
                || (isSelf(uid) && !(uid in r.seatUids) && hostGone(r, d.roomId)
                    && get(playerPath(uid)).data.tableRoomId == d.roomId
                    && get(playerPath(uid)).data.sessionNo == d.sessionNo
                    && d.amount == get(playerPath(uid)).data.inPlay && d.buyIn == d.amount
                    && d.topUps == 0 && d.topUpChips == 0 && d.hands == 0
                    && d.nightKey is string && d.nightKey.matches('[0-9]{8}')));
        }
        allow get: if signedIn();
        allow list: if signedIn() && request.query.limit <= 50;
        allow create: if signedIn() && entryKeysOk(request.resource.data)
          && (grantOk(request.resource.data) || buyinEntryOk(request.resource.data)
              || topupEntryOk(request.resource.data) || cashoutEntryOk(request.resource.data));
        allow update, delete: if false;
      }

      // 每晚戰績（nightKey＝這次入座的台北時間，06:00 換日的 YYYYMMDD）；只在結帳時累加
      //   buyIn＝帶入＋補碼（Poker Now 的 Buy-In）、cashOut＝帶走、net＝cashOut − buyIn
      match /nights/{nightKey} {
        function nightAddOk(base) {
          let d = request.resource.data;
          let e = getAfter(ledgerPath(uid, d.lastEntry)).data;
          return nightKey.matches('[0-9]{8}')
            && d.keys().hasOnly(['nightKey', 'uid', 'name', 'buyIn', 'cashOut', 'net', 'topUps', 'hands', 'lastEntry', 'updatedAt'])
            && d.nightKey == nightKey && d.uid == uid && strOk(d.name, 60)
            && d.lastEntry is string && d.lastEntry != base.lastEntry
            && e.type == 'cashout' && e.at == request.time && e.by == request.auth.uid && e.nightKey == nightKey
            && d.buyIn == base.buyIn + e.buyIn + e.topUpChips
            && d.cashOut == base.cashOut + e.amount
            && d.net == d.cashOut - d.buyIn
            && d.topUps == base.topUps + e.topUps
            && d.hands == base.hands + e.hands
            && d.updatedAt == request.time;
        }
        allow get: if signedIn();
        allow create: if signedIn() && nightAddOk({'lastEntry': '', 'buyIn': 0, 'cashOut': 0, 'topUps': 0, 'hands': 0});
        allow update: if signedIn() && nightAddOk(resource.data);
        allow delete: if false;
      }
    }

    // 戰績頁「某一晚」的集合群組查詢
    match /{path=**}/nights/{nightKey} {
      allow list: if signedIn() && request.query.limit <= 50;
    }
    // ===== [/POKER] ===========================================================

    // 其他路徑一律拒絕（預設就是拒絕，這裡寫明）
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

### 9.5 索引（`firestore.indexes.json`）
```json
{
  "indexes": [],
  "fieldOverrides": [
    {
      "collectionGroup": "nights",
      "fieldPath": "nightKey",
      "indexes": [
        { "order": "ASCENDING", "queryScope": "COLLECTION" },
        { "order": "DESCENDING", "queryScope": "COLLECTION" },
        { "order": "ASCENDING", "queryScope": "COLLECTION_GROUP" }
      ]
    }
  ]
}
```
- 總排行：`pokerPlayers` `orderBy('total','desc').limit(50)`，用自動單欄索引（`total`＝`bank + inPlay`，規則保證每次寫入都一致）；`tableRoomId` 不是 null 的標「牌桌中」。
- 某一晚：`collectionGroup('nights').where('nightKey','==',key).limit(50)`，需要上面的集合群組單欄索引；排序在前端做（最多 50 筆）。
- 晚上清單：自己的 `nights` `orderBy('nightKey','desc').limit(8)`。
- `firebase.json` 指向這兩個檔案，也管 Hosting（§6.1）；部署：`firebase deploy --only hosting,firestore --project tony-poker`（PM 在雲端代理用 CI 權杖，或 GitHub Action）。

### 9.6 規則自我稽核（firebase-security-rules-auditor 清單）
評分：**3／5（中）**。扣分主因是「房主說了算」這個已接受的設計（沒有 Cloud Functions 就沒有伺服器裁判），其他項目都有處理。

| 檢查項 | 結果 | 嚴重度 | 說明／處理 |
|---|---|---|---|
| 建立後再更新繞過 | 通過 | — | create 和 update 各自檢查欄位白名單；本人改帳戶只能「改名字」或「整筆帶入」；結帳入帳必須有同一個 batch 新增的帳本 cashout；帳本不能 update／delete；加入房間只能改 `members` |
| 權限來源 | 有風險（已接受） | 中 | 房主由房間文件的 `hostUid` 決定。換房主只能交給在座的人，或在房主文件和心跳都超過 30 秒（伺服器時間）時由在座的人接手。**房主可以照自己想要的結果分底池**（規則只檢查 Σ`stacks` = `chipTotal`，所以只能把桌上其他人的籌碼移給某人），這是沒有伺服器裁判的代價。帶入、補碼、帶走的金額規則都會對帳，房主改不了。家人之間使用，畫面上沒有改籌碼的功能。**宗良 已接受（2026-11-01）**：規則只保證桌上總數不變，擋不了房主故意分錯 |
| 自己灌籌碼 | 已擋 | 低 | 自己開房、自己當房主也灌不了：帳戶只能從帳本 grant（每個帳號一次，金額＝房間設定 ≤100,000，且不算淨輸贏）、補碼（桌上 0 時剛好 +2,000、次數公開、帳本一筆）、結帳（金額＝房間 `stacks[i]`）增加；桌上籌碼加總受 `chipTotal` 約束，`chipTotal` 只隨帳務事件改變；同一個 sessionNo 只能結帳一次 |
| 商業邏輯 | 通過 | — | 成員（含觀眾）讀得到房間；只有本人讀得到手牌；房主讀得到意圖和心跳；登入者讀得到排行 |
| 儲存濫用 | 部分 | 低 | 字串、陣列、數字都有上限；`members ≤ 30`；金額 ≤ 100,000,000；帳本一次帳務事件一筆，編號固定。`pub` 只檢查是 map（房主寫，文件上限 1 MiB）。任何登入者可在任何房間寫自己的心跳文件（為了省讀取不查成員），最多一人一房一份 |
| 型別 | 通過 | — | 數字用 `is int`、時間用 `== request.time`；v2 起 `seatUids` 六格逐格檢查是字串（`seatUidsOk`） |
| 欄位權限 vs 身分 | 通過 | — | 每條 update 都同時檢查身分（本人、現任房主、在座接手者） |
| 個資 | 通過 | — | 不存 email；`users/{uid}` 只有本人讀；排行只放名字、頭像、總籌碼（帳戶＋牌桌中），**所有登入的人都看得到（宗良 已同意）**；帳本也是登入者可讀（只有金額和房間 ID） |
| 列出全部 | 通過 | — | 房間、房號、手牌不能 list；排行、帳本和某一晚的查詢上限 50 筆 |
| 刪除 | 通過 | — | 全部 `delete: false` |

**v2 規則讀取次數（`get()`／`exists()`／`getAfter()`；上限：單筆寫入 10、batch 20）**：

| 寫入 | 次數 | 說明 |
|---|---|---|
| 建房（房間＋房號，同一交易） | 2 | 房間 create 1 次 `getAfter(房號)`；房號 create 1 次 `getAfter(房間)` |
| 加入（`members` arrayUnion） | 0 | |
| 房主一般寫入、交棒、每手結束、作廢 | 0 | Σ`stacks` = `chipTotal` 在同一份文件檢查 |
| 接手 | 1 | 房主心跳文件（`exists` 和 `get` 同一份文件） |
| 意圖 | 1 | `roomOf` 檢查成員 |
| 手牌 | 1 | `roomOf` |
| 心跳寫入 | 0 | |
| 房號延長／收桌 | 1 | `roomOf`（同一份文件讀兩次算 1 次） |
| 第一次來（帳戶＋帳本 grant） | 3 | 帳戶：`roomOf`、`existsAfter(grant)`；帳本：`getAfter(帳戶)` |
| 本人帶入（帳戶＋帳本 buyin） | 3 | 帳戶：`roomOf`、`existsAfter(buyin)`；帳本：`getAfter(帳戶)` |
| 房主讓人坐下（只寫房間） | 2 | `getAfter(帳本 buyin)`、`getAfter(帳戶)` |
| 補碼（房間＋帳本 topup） | 3 | 房間：`getAfter(帳本)`；帳本：`roomOf`、`getAfter(房間)` |
| 房主結帳（房間＋帳本＋帳戶＋每晚戰績） | 4 份文件（最多 7 次呼叫） | 房間、帳戶、戰績都 `getAfter(帳本)`（同一份）；帳本：`roomOf`、`getAfter(帳戶)`、`getAfter(房間)`。一人一個 batch（EGM #5） |
| 本人自救結帳（帳本＋帳戶＋每晚戰績） | 4 份（最多 5 次） | 帳本：`roomOf`、房主心跳、`getAfter(帳戶)`；帳戶、戰績：`getAfter(帳本)` |
| 本人取消帶入 | 5 份（最多 6 次） | 上一列再加 `get(帳戶)`（看帶入前的 inPlay） |
| 自救後空出座位（只寫房間） | 1 | `getAfter(帳本 cashout)`（已存在） |

**還沒驗證**：box 沒有 Java，無法跑 Firestore 模擬器，只做了括號配對檢查。第 7 章 #3、#4、#9、#10、#25～#27 的模擬器測試由 PM 在實作時跑（`@firebase/rules-unit-testing`），規則要先過語法檢查（`firebase deploy --only firestore:rules --dry-run` 或主控台的規則測試區）。特別要確認：①`let` 和 `getAfter` 在 `moneyOk` 裡的寫法語法正確；②房主結帳 batch 的文件存取次數（上表最多 7 次）低於 batch 上限 20；③`sessSame` 在空位（null）時的比較不會出錯。

---

## 10. 用量估算（Spark 免費額度：每天寫 20,000、讀 50,000）

> 額度在 America/Los_Angeles 午夜重置：美國夏令時間是台北 15:00，標準時間是台北 16:00（§6.6 用時區換算，不寫死）。
> v2：籌碼改成業界模型後，每手的帳戶、帳本、戰績寫入是 0 筆，只在入座、補碼、離座時寫；牌堆祕密文件拿掉。心跳的讀取也改了：入座玩家不再監聽自己的心跳來對時（§6.4）。

情境：6 人入座＋1 位觀眾，一晚 100 手、4 小時。

| 項目 | 寫入 | 讀取 | 算法 |
|---|---|---|---|
| 房間公開狀態 | 1,600 | 11,200 | 每手約 16 次（合併後）；7 個人在聽 |
| 動作意圖 | 1,200 | 1,200 | 每手約 12 個動作；只有房主在聽 |
| 手牌 | 600 | 600 | 每手 6 份；各自聽自己的 |
| 帳務（帳戶、帳本、每晚戰績、帳務的房間寫入） | ~70 | ~130 | 6 人：第一次來 2×6、帶入 2×6、坐下 1×6、補碼 2×約 6、結帳 4×6 ≈ 66；讀取＝帳務的房間寫入 × 7 個人在聽，加上結帳前讀帳戶 |
| 心跳 | ~2,760 | ~2,900 | 6 人 × 每 30 秒；只有房主在聽（v2 拿掉各自聽自己的） |
| 規則裡的 `get()` | — | ~1,900 | 意圖每次 1（1,200）；手牌每份 1（600）；帳務 batch 每次 2～7（約 100）；每手結束 0 |
| 戰績頁、重連 | — | ~750 | 排行 50 筆 × 幾次＋重連重讀 |
| **合計** | **~6,230（31%）** | **~18,700（37%）** | v1 是 ~7,600（38%）／~19,400（39%） |

- 一天打兩晚大約寫入 62%、讀取 75%，還在免費額度內。
- 本機保險絲：只有房主那台會擋，6,000 次寫入提醒、8,000 次停開新手牌（§6.6）。
- 讀取最大宗是「房間文件 × 聽的人數」。人數多時第一個省法是把觀眾的監聽改成每 5 秒 `get` 一次（目前不做）。
- 心跳不改用 Realtime Database（PL 已決定，少一套服務）。

---

## 11. 動畫時間軸（animation-timeline-spec）

### 11.0 目的
多人模式新增事件的動畫規格。第一階段的發牌、下注、翻牌、攤牌動畫（`DEAL_FX`、`SHOWDOWN_FX`、`chipFlyMs 650`、所有 easing）**全部照用，不改數字**。

### 11.1 範圍
入座、離座、首次加入提示、換房主＋作廢、補籌碼、暫離和回來、重連、多人發牌、送出中、計時光環。

### 11.2 全域常數（加在 `fx.js` 的 `MP_FX`）
| 名稱 | 值 |
|---|---|
| `seatInMs` | 240 |
| `seatOutMs` | 200 |
| `toastMs` | 3000 |
| `bannerInMs` / `bannerHoldMs` / `bannerOutMs` | 320 / 4000 / 240 |
| `hostTagOutMs` / `hostTagInMs` | 160 / 240 |
| `voidChipMs` | 650（＝`chipFlyMs`） |
| `voidBoardFadeMs` | 240 |
| `topUpDropMs` / `topUpCountMs` | 650 / 600 |
| `awayInMs` / `awayOutMs` | 300 / 240 |
| `reconnectFadeMs` | 160 |
| `pendingDimMs` / `pendingLabelAfterMs` / `pendingResendAfterMs` | 120 / 3000 / 8000（8 秒沒反映就重送同一個 `turn`、新的 seq，最多 2 次；房主只採用 `handNo`、`turn` 都對得上的意圖，§6.5） |
| `timerMs` / `timerWarnLastMs` | 30000 / 5000（v2：對齊第一階段 `app.js` `updateActorTimerRing` 的 `leftMs <= 5000`） |
| `skipIfLateMs` / `skipIfQueueOver` / `skipIfSeqJumpOver` | 1500 / 3 / 1（`actionSeq` 一次跳超過 1 就跳過動畫） |

### 11.3 Easing
沿用第一階段：`easeIn`（進場）、`easeOut`（退場）、`easeChip`（籌碼飛）。計時光環用 `linear`。

### 11.4 事件總表
| 事件 | 觸發（pub 差異） | 誰看得到 | 可跳過 |
|---|---|---|---|
| 入座 | `seats[i]` 從空變有人 | 全部 | 是 |
| 離座 | `seats[i]` 從有人變空 | 全部 | 是 |
| 首次加入提示 | 自己第一次入座（`pokerPlayers` 剛建立） | 本人 | 否（只是提示） |
| 換房主 | `hostUid` 改變（斷線接手，或房主離座交棒） | 全部 | 橫幅不跳過，作廢動畫可跳 |
| 補碼 | `stacks[i]` 0 → 2000 且 `sess[i].topUps` +1（座位旁標「補碼 ×N」） | 全部 | 是 |
| 結帳離座 | `lastMoneyEvent.type == 'cashout'` 且該座位變空 | 全部（本人另有「帶走 N」toast） | 是 |
| 暫離／回來 | `away[i]` 改變 | 全部 | 是 |
| 重連 | 監聽重新接上 | 本人 | 一律直接跳到最新 |
| 多人發牌 | `handNo` +1 | 全部 | 是 |
| 送出中 | 自己送出意圖還沒反映在 pub | 本人 | — |
| 計時 | `deadlineAt` 改變 | 全部 | — |

### 11.5 入座／離座
| 時間 | 元素 | 變化 |
|---|---|---|
| 0 | 座位牌 | opacity 0→1，240 ms，easeIn |
| 0 | 頭像 | scale .8→1，240 ms，easeIn |
| 240 | 籌碼數字 | 直接顯示（不跳數） |
| 離座 0 | 座位牌 | opacity 1→0，200 ms，easeOut；結束後換成「空位」虛線框 |

### 11.6 首次加入提示
- 0：底部 toast 從 y+12 滑入並淡入，240 ms easeIn，文字「第一次來，送你 N 籌碼」。
- 3000：淡出 200 ms。點一下可提早關。

### 11.7 換房主＋作廢
| 時間 | 元素 | 變化 |
|---|---|---|
| 0 | 頂部橫幅「房主斷線，由 ○○ 接手；這一手作廢」（房主離座交棒時改成「○○ 離座，由 ○○ 當房主」，沒有作廢動畫） | translateY −100%→0，320 ms，easeIn |
| 0 | 舊房主的「房主」標籤 | opacity →0，160 ms |
| 160 | 新房主的「房主」標籤 | opacity 0→1＋scale .8→1，240 ms |
| 400 | 桌上所有下注籌碼 | 飛回各自座位，650 ms，easeChip（同時起飛） |
| 400 | 公牌 | opacity →0，240 ms |
| 1050 | 籌碼數字 | 直接顯示還原後的數字 |
| 4320 | 橫幅 | 收回，240 ms，easeOut |
| 約 3000（新房主端） | 新的一手 | 照「多人發牌」開始 |

### 11.8 補籌碼
| 時間 | 元素 | 變化 |
|---|---|---|
| 0 | 一疊籌碼（2000） | 從座位上方 40 px 落到座位，650 ms，easeChip |
| 650 | 籌碼數字 | 0→2000 跳數，600 ms，easeOut |
| 650 | 「補籌碼 ×N」小標 | 淡入 240 ms |

### 11.9 暫離／回來
- 暫離：座位整體 opacity →.55、外框變虛線，300 ms；頭像停止「輪到你」脈動；顯示「暫離」標籤。
- 回來：反向，240 ms。

### 11.10 重連
- 不重播任何中間動畫。舊畫面和最新畫面交叉淡化 160 ms，之後照最新 pub 顯示（含計時光環剩下的時間）。

### 11.11 多人發牌
- 用 `estimateDealTotalMs` 的多人版：拿掉換人步驟的 `passInMs` 和 `lookPauseMs`，其他一樣。
- 房主在這段時間結束後才寫 `deadlineAt`，所以每個人的 30 秒都從看得到牌開始算。

### 11.12 送出中與計時光環
- 點了動作按鈕：所有動作按鈕 opacity →.5，120 ms，不能再點。
- 3 秒還沒反映：按鈕上方出現「送出中…」。8 秒還沒反映：重送同一個 `turn`（新的 seq），最多 2 次；之後還沒反映就顯示「沒送到，再按一次」，按鈕恢復可按。`turn` 已經不是自己（pub 前進了）就直接停止重送。
- pub 反映後：按鈕收起（照第一階段）。
- 計時光環：從剩餘時間開始（§6.4 的本機算法），`linear` 跑到 0；最後 5 秒顏色換成 `--warn`（跟第一階段一樣）；剩餘秒數每秒更新文字。

### 11.13 跳過規則與減少動態
- 跳到最後狀態：快照比 `updatedAt` 晚 > 1.5 秒、分頁原本隱藏、佇列 > 3 筆、剛重連、`actionSeq` 跳號（§6.5）。
- `prefers-reduced-motion: reduce`：所有時間設 0，只保留 120 ms 的淡入淡出；計時光環改成只顯示秒數文字。
- 驗收：錄影逐格檢查 11.7 和 11.8 的時間點誤差 < 1 格（60fps）。

---

## 12. PL 決定清單（已定，PM 照做）
1. 房主那台是發牌員和裁判；其他人只送意圖（§6.2）。
2. 牌局中入座、離座由房主排隊，等手牌結束才執行，不改引擎（§6.8）。
3. 籌碼照業界標準模型（§6.10）：帳戶 `bank`＋牌桌中 `inPlay`；入座＝帶入（方案①，整筆帶上桌，宗良 已選）；打牌中只改房間 `stacks[6]`，規則檢查 Σ＝`chipTotal`；補碼＝房主核准的加買（房主可核准自己），次數全桌看得到；離座＝結帳，房主寫、一人一個 batch；房主失聯 10 分鐘，本人可以照房間最後的 `stacks` 自救結帳；帳本只新增、固定編號，重送不會重複記帳；作廢一手＝`stacks` 回到這手開始，不動任何帳戶；牌堆只放房主記憶體，作廢就重發。
4. 接手房主的順序照 `pub.seatedAt`（沒暫離者裡最早入座的優先），客戶端錯開 3 秒；客戶端只看「房間 30 秒沒更新」，規則用 `request.time` 檢查「在座＋失聯超過 30 秒＋rev」，交易保證只有一人成功（§6.7）。
5. 登入用方案A（宗良 已選）：Firebase Hosting `tony-poker.web.app`、authDomain 同網域、iOS 主畫面版用轉址；預覽頻道網址只用彈出視窗；App 內建瀏覽器一律先引導到外部瀏覽器（§8.3.2）。
6. Firestore 用記憶體快取，不開 IndexedDB 持久化；備援用 localStorage `poker.v2.*`、`auth.v1.*`。
7. 心跳用 Firestore（不另開 Realtime Database），房主才聽全部心跳。
8. 不刪資料、不開 TTL；房號 24 小時後可被重用。
9. 分享連結帶房號和房間 ID（`?room=482913&r=房間ID`），加入時核對兩者一致；「繼續上次的牌桌」用 `lastRoomId`，不受房號過期影響；房主可延長房號期限。
10. 第一階段的單機輪流玩保留，大廳有「同一支手機輪流玩」連結（B5）。
11. 排行最多顯示 50 人，依 `total`（帳戶＋牌桌中）；每晚淨輸贏＝帶走＋桌上 − 帶入（補碼算在帶入裡，次數另外顯示）。
12. 動畫數字全部集中在 `fx.js` 的 `MP_FX`，不散在各檔。
13. 只有房主判逾時，用房主自己的時鐘；其他人用本機倒數，不估伺服器時間差（§6.4）。
14. 房主循環只要 App 開著、分頁可見就跑；切到背景＝斷線；房主離座在 HAND_OVER 自動交棒（§6.2、§6.7）。
15. 用量保險絲只有房主那台會擋；換日用 America/Los_Angeles 午夜換算（§6.6）。
16. 每晚戰績 06:00 換日；心跳不用 Realtime Database；保留單機輪流模式；專案 ID `tony-poker`（宗良 本人建立，PL 帶步驟）。
17. 發布用 Firebase Hosting（不是 GitHub Pages）：PM 用 `firebase deploy`（雲端代理＋CI 權杖，或 GitHub Action），QA 用預覽頻道驗收（§6.1）。

---

## 13. 實作清單（給 PM）

### 13.1 新檔案
| 檔案 | 內容 |
|---|---|
| `lib/firebase/load.js` | SDK 動態載入＋逾時 |
| `lib/auth/auth.js`、`auth-ui.js`、`auth.rules`、`README.md` | 可重用登入模組（第 8 章），含 `detectInAppBrowser()` 和 1-e 畫面 |
| `poker/js/net/room.js` | 建房（hasAll 欄位、初始值）、房號交易、分享連結 `?room=&r=`、§9.2 加入順序、延長房號、監聽房間、收桌 |
| `poker/js/net/host.js` | 房主循環（App 開著的任何畫面都跑）：收意圖 → `applyAction` → 寫 pub／hole、本機時鐘計時、暫離判定、`seatedAt`、離座交棒；帳務事件（讓人坐下、補碼、結帳，一人一個 batch，寫入前自我檢查 Σ`stacks` = `chipTotal`）；上任時核對在座者帳戶；作廢一手 |
| `poker/js/net/client.js` | 送意圖（`handNo`＋`turn`＋seq；8 秒重送同一個 turn，最多 2 次）、本機倒數、pub 差異 → 動畫事件佇列、跳過規則（含 `actionSeq` 跳號） |
| `poker/js/net/presence.js` | 心跳、接手房主（房間 30 秒沒更新 → 照 `seatedAt` 順位錯開 → 交易） |
| `poker/js/net/quota.js` | 本機寫入計數、America/Los_Angeles 午夜換日（`Intl.DateTimeFormat`）、只有房主那台套 6,000／8,000 門檻 |
| `poker/js/net/ledger.js` | 第一次來（grant）、帶入、補碼、結帳、自救結帳、取消帶入；帳本固定編號，被拒（已存在）就讀回當成功；每晚戰績、排行查詢 |
| `poker/js/ui/lobby.js` | wf-01～wf-04 |
| `poker/js/ui/stats.js` | wf-08 |
| `poker/firebase/firestore.rules`、`firestore.indexes.json`、`firebase.json` | 從 `poker-plan/firebase/` 搬過去（`firebase.json` 含 Hosting 設定） |
| `poker/firebase/stage.sh` | 部署前把 `poker/`、`lib/` 複製到 `poker/firebase/public/`（§6.1） |
| `.github/workflows/poker-deploy.yml` | `FirebaseExtended/action-hosting-deploy`：PR 開預覽頻道，合併到 main 部署正式版；要宗良 在 GitHub 加上服務帳戶金鑰（`FIREBASE_SERVICE_ACCOUNT_TONY_POKER`） |

### 13.2 修改
| 檔案 | 改什麼 |
|---|---|
| `game.js` | 新增 `SET_AWAY`、`VOID_HAND`（籌碼回到這手開始）、`TOP_UP`（只在 0 時補 `topUpAmount`）；`config.multiplayer` 關掉 `PLAYER_READY`、`REQUEST_PAUSE`、換人畫面 |
| `view.js` | 新增 `publicState()`；座位以「我」為底部旋轉 |
| `app.js` | 啟動流程：登入 → 大廳 → 房間；保留單機模式入口 |
| `fx.js` | 新增 `MP_FX` 和第 11 章事件 |
| `game.css` | 暫離、空位、房主標籤、橫幅、toast、送出中 |
| `index.html` | 大廳、建房、加入、戰績、1-e 的容器；`?room=房號&r=房間ID` 參數 |

### 13.3 順序
1. **第一天先做**：登入用方案A。先把空白頁用 `firebase deploy` 部署到 `tony-poker.web.app`，確認 iOS 主畫面版轉址登入可用；也測 LINE／Facebook 內建瀏覽器（第 7 章 #18、#19）。同時把發布流程接好（`stage.sh`、GitHub Action 或雲端代理的 CI 權杖、預覽頻道，#28）。
2. 登入模組＋空白測試頁（第 7 章 #17）。
3. `publicState()` 和它的單元測試（#2）。
4. 規則＋模擬器測試（#3、#4、#9、#20、#22、#23、#25、#27）。
5. 建房、加入（§9.2 順序）、延長房號、第一次來、帶入、入座（wf-02～wf-04）。
6. 房主循環＋客戶端（wf-05），兩支手機同步（#5、#6）。
7. 暫離、換房主、房主離座交棒（wf-06，#7、#8、#21）；補碼、結帳、自救結帳（#10、#25、#26、#27）。
8. 觀眾、戰績（wf-07、wf-08，#12、#13）。
9. 動畫（第 11 章）、減少動態（#15）、用量實測與換日（#16、#24）。
10. 390／1280 截圖驗收（#1）；部署到預覽頻道交給 QA，QA 通過才部署正式版。

### 13.4 測試情境（兩支以上實機）
- 3 人打 10 手，中間一人關分頁 70 秒再回來。
- 房主在翻牌後開飛航模式 40 秒再回來（應已降為一般玩家）。
- 一人輸光、申請補碼；房主自己輸光、自己核准（宗良 已同意），全桌看到「補碼 ×N」。
- 中途有人離座結帳，打完看今晚戰績：已結帳的人淨輸贏不變、其他人照桌上籌碼算，總和是 0。
- 房主關掉 App 10 分鐘，在座的人從大廳自救結帳。
- 房主牌局中按離座，這手打完後交棒。
- 從 LINE、Facebook 點分享連結進房。
- 牌局中有人點空位、有人離座。
- 觀眾從頭看到攤牌，用開發者工具確認收不到任何人的手牌。
- 打到隔天 06:00 前後，確認戰績分在正確的晚上。

### 13.5 之後
- [ ] **把登入模組做成共用 skill**：等撲克上線、穩定兩週後，把 `/lib/auth/` 的檔案、接入 4 步驟、規則片段和已知限制（跨網域不能轉址、App 內建瀏覽器、Safari 和主畫面不共用 localStorage）整理成一個 skill，之後的網頁專案直接用。

---

## 待決問題

| # | 問題 | 狀態 |
|---|---|---|
| 1 | Google 登入與發布位置 | 已決（宗良）：方案A，Firebase Hosting `tony-poker.web.app`、同網域轉址登入（§8.3.1） |
| 2 | 房主自己輸光時，可以自己核准自己補 2,000 嗎？ | 已決（宗良）：可以，補的次數全桌看得到 |
| 3 | 每晚戰績 06:00 換日 | 已決（PL） |
| 4 | 排行榜（名字、頭像、總籌碼）所有登入的人都看得到 | 已決（宗良）：可以 |
| 5 | 心跳要不要改用 Realtime Database | 已決（PL）：不要 |
| 6 | 保留第一階段「同一支手機輪流玩」 | 已決（PL）：保留 |
| 7 | Firebase 專案 ID `tony-poker` | 已決（PL）：宗良 本人建立，PL 帶步驟 |
| 8 | 規則擋不了房主故意分錯底池（只保證桌上總數不變） | 已決（宗良）：接受，列為已接受風險（§9.6） |
| 9 | 籌碼加減和儲存的業界標準模型 | 已決（PL，照調研）：§6.10 |
| 10 | 入座帶多少上桌 | 已決（宗良）：方案①，整筆帶入 |
| 11 | 房主失聯多久可以自救結帳 | 已決（PL）：10 分鐘（房間和房主心跳都超過） |

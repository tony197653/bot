# 照片轉 JSON 操作說明（給家教TU）v1

適用：「參考書轉數位考題網」（/bot/quiz-bank/）。格式以 `/workspace/quiz-import-plan/schema.json` 為準，本文件說明怎麼做。
最後更新：2026-11-02（PL）。

## 鐵則
- **照片由你（GB）自己讀**。不要用任何免費 AI（free_ai.py、OpenRouter、Gemini 免費額度等），也不要用 NotebookLM 或線上 OCR 網站。
- **照書上原文轉錄，不改寫、不自己出題。** 看不清楚就寫進 `extract.uncertain`，不要猜。
- **版權**：題目和圖只給羽蕎自己練習用。檔案只放在 box 的 `/workspace/quiz-bank-import/`，只傳給宗良。不要 commit 進任何 repo，不要上傳到公開的地方。
- 一律用繁體中文（台灣），標點用全形。

## 0. 收照片時先確認
宗良會一次傳來一批照片：**題目頁**，加上**書末詳解頁**（同一回的）。開始前先確認這四件事，缺了就問宗良：
1. 哪一本書（書名、科目、年級）。新書要取一個 `bookId`（例：`hl-m9a`），寫進你的記憶，之後固定用。
2. 哪個單元：對照你記憶裡的單元代碼表，找到 `unitCode`（例：`M9-2`）。表裡沒有就新增一筆並記下來。
3. 第幾回：書上的回次原文要記在 `roundLabel`，數字放 `round`。
4. 照片上總共有幾題：自己數一遍，寫進 `batch.expectedCount`。

**一批 JSON 只放同一本書、同一單元、同一回的題目。** 照片跨了兩回就拆成兩個檔。

## 1. 逐題轉錄
每題填 `schema.json` 的 question 欄位，重點如下：

| 欄位 | 怎麼填 |
|---|---|
| `id` | `bookId-unitCode小寫-r回數-q題號兩位數`，例：`hl-m9a-m9-2-r3-q07` |
| `subject` / `unit` / `unitCode` | 科目代碼（math、sci）、單元名稱、單元代碼 |
| `level` | 書上 1 星＝易、2 星＝中、3 星以上＝難；沒有星等就自己判斷 |
| `stem` | 題幹原文。題號不要寫進來 |
| `options` | 四個選項，A 到 D 依序填。不要寫「(A)」 |
| `answer` | 0＝A、1＝B、2＝C、3＝D |
| `explain` | 書末詳解轉錄，可以補一句「常見錯誤」 |
| `source` | 頁碼、詳解頁碼、`matchKey`＝`unitCode|回數|題號` |
| `review` | `status` 填 `draft`（有紅標就填 `flagged`），`checkedBy`、`checkedAt` 填 `null` |
| `extract` | `confidence` 填 0 到 1；有疑問的地方逐條寫進 `uncertain` |

### 公式
- 簡單的式子直接打 Unicode，例如 `(−3)² − 2 × (−4) ÷ ½`。負號用 `−`，不要用連字號 `-`。
- 分數、根號、上下標、聯立式子用 KaTeX：行內寫 `\( \)`，獨立一行寫 `\[ \]`。在 JSON 裡反斜線要寫兩次，例如 `"\\(\\frac{1}{2}\\)"`。
- 化學式寫 `\(\ce{2H2 + O2 -> 2H2O}\)`。
- 單位寫在 `\text{}` 裡，數字和單位之間空一點，例如 `\(12\,\text{N}\)`。
- 不確定的式子照你看到的寫，並在 `uncertain` 註明「第 x 題分母看不清」，同時加 flag `FORMULA_CHECK`。

### 圖
1. 在照片上找出圖的範圍（像素座標 x、y、w、h），用下面的指令裁圖，產出 WebP 的 data URL：
   ```
   python3 /workspace/quiz-import-plan/tools/crop_figure.py IMG_0413.jpg 120 860 640 380 --dataurl-file fig1.txt
   ```
   工具會自動轉正、縮到寬 1000px 以內、壓到 150 KB 以內。壓不下來就把框裁小一點。
2. 把 `fig1.txt` 的內容填進 `figures[].src`，`crop` 欄位填剛才的座標。
3. `alt` 一定要寫，把圖上的標示和數字都寫出來。校對時宗良會拿它跟圖比對。
4. 題組共用的圖放在 `groups[].figures`，單題自己的圖放在 `questions[].figures`。選項是圖時，選項文字寫 `[圖:fig2]`，再把 fig2 放進該題的 `figures`。
5. 裁好的圖**要用 Read 打開看一次**，確認沒有切到字、方向正確。

### 題組（閱讀題組）
- 共用題幹寫在 `groups[]`：`groupId`＝`bookId-unitCode小寫-r回數-g序號`。
- 屬於題組的每一題，`groupId` 都指回這個題組；`questionIds` 要依順序列出所有小題。
- 小題的 `stem` 只寫自己那一題，不要重複共用題幹。

## 2. 配對書末詳解
- **一律用 matchKey（單元＋回數＋題號）配對**，不能只看題號，因為每回題號都會從 1 重新編。
- 詳解頁的答案和你從題目推的答案不一樣時，**以詳解為準**，加 flag `EXPLAIN_MISMATCH`，並在 `review.note` 寫出你的算法。
- 詳解頁沒有這題：`explain` 填空字串，加 flag `EXPLAIN_MISSING`。
- 書末只有答案、沒有解說時，可以自己補一段簡短詳解，但開頭要寫「（TU 補充）」。

## 3. 自我檢查
```
python3 /workspace/quiz-import-plan/tools/validate_batch.py 檔名.json --fix
```
- 回傳 2：格式錯，照提示修好再跑一次。
- 回傳 1：有紅標，這是正常的。用 `--fix` 會另存一個 `檔名.checked.json`，紅標已經補進去。能自己修的先修（例如漏了附圖），修不了的就留給宗良校對。
- 回傳 0：沒有紅標。
- 另外自己再看一次：題數對嗎？每題的答案都對過詳解了嗎？KaTeX 括號有沒有成對？

## 4. 交給宗良
1. 檔名用 `batchId.json`（例：`20261105-hl-m9a-m9-2-r3.json`），放在 `/workspace/quiz-bank-import/`。
2. 在對話裡把檔案傳給宗良，附上三行說明：
   - 書、單元、第幾回、共幾題
   - 幾題有紅標、各是什麼原因（對照下表）
   - 匯入頁網址 https://tony197653.github.io/bot/quiz-bank/#/import
3. 宗良在匯入頁選這個檔案、校對、按「確認存入」。**你不需要也不可以直接寫入 Firestore。**

## 紅標代碼對照
| 代碼 | 意思 | 你能先做什麼 |
|---|---|---|
| COUNT_MISMATCH | 題數跟照片不符 | 重數一次，補漏題 |
| EXPLAIN_MISSING | 找不到詳解 | 請宗良補拍詳解頁 |
| EXPLAIN_MISMATCH | 詳解對不上 | 在 note 寫出差異 |
| ANSWER_MISSING | 沒有答案 | 同上 |
| OPTION_COUNT | 書上不是 4 個選項 | v1 不收，先跳過這題並告訴宗良 |
| FORMULA_CHECK | 公式不確定 | 在 uncertain 註明位置 |
| FIGURE_MISSING | 題目提到圖卻沒有圖 | 補裁圖 |
| LOW_CONFIDENCE | 把握低於 0.8 | 在 uncertain 列出原因 |
| DUPLICATE_ID | id 重複 | 檢查回數、題號 |
| GROUP_BROKEN | 題組對不上 | 對照 groupId 和 questionIds |
| IMAGE_TOO_BIG | 圖超過 150 KB | 重裁小一點 |

## 附：舊 Canvas 題目怎麼轉
「羽蕎・會考數學與理化診斷小測驗」的題目 `{subject, unit, level, stem, options, answer, explain}` 欄位直接照抄；`id` 要照本格式重編（例：`m1` → `tu-diag-m7-1-r1-q01`），再補上這些：
- `unitCode`、`type:"single"`、`groupId:null`、`figures:[]`
- `source`：`bookId` 填 `tu-diag`，`round` 填 1，`number` 照題序，`page` 填 1，`answerPage` 填 null
- `review`：`status` 填 `draft`
- `extract`：`confidence` 填 1

原本的 `figure:"similar"` 改成把那張 SVG 轉成 WebP 圖，放進 `figures`。

# 參考書轉數位考題網 風格規格（BD 定稿 v1，2026-11-02）
宗良選定：B 安靜高級。可操作樣張：https://tony197653.github.io/bot/samples/quiz-style/b/ （commit 700061e）
原始碼：/workspace/bd/quizsrc/（base.css + b.css + core.js + data.js，build.py 產出 /workspace/quiz-style-samples/b/index.html）。PM 以此為視覺基準，不改 PL 架構。

## 硬性要求（宗良指定）
- 選擇選項時**不縮放、不抖動、不位移**：按下只換底色 var(--press,#EEEDE9)；選中＝字母圓填 --accent；對錯揭曉只用底色＋勾叉淡入（opacity only）。
- 答錯不可有搖晃動畫。

## 配色（token 角色照元件庫）
bg #F5F4F1｜surface #FFF｜surface-2 #F0EEEA｜ink #1F1F1D｜mute #67655F｜line #E5E3DD｜line-strong #CDCAC2
accent 石板藍 #34445A｜ok #3B7150（ink #2E5C40, soft #E7EFE9）｜bad #A03F4A（ink #8C3540, soft #F6E8E9）｜warn #9A6A1E
主按鈕 #1F1F1D / 字 #FAFAF8 / hover #34332F。文字對比全部 ≥4.5。

## 字體
介面與題幹 Noto Sans TC（PingFang TC、JhengHei 後備），letter-spacing .03em，題幹 19px / 1.9。
數字（題號、分數、選項字母）Newsreader 襯線，font-variant-numeric: tabular-nums。公式 KaTeX。

## 間距、圓角、陰影
題目無卡框，靠留白：選項間距 12px、選項區距題幹 28px、選項 min-height 60px、padding 12/18/12/14。
圓角 6/8/12/20/999/50%，同心。陰影只用四個暖色 token（--shadow / --shadow-up / --pop-shadow / --sheet-shadow，值見 b.css）。
焦點 outline 2px var(--accent) offset 3px。進度條 1px 細線。

## 動態節奏
- 微互動 .22s var(--ease)；hover 包在 @media (hover:hover) and (pointer:fine)，hover 只淡入 --shadow-up。
- 換題：舊題 .2s 淡出＋上移 8px＋blur 4px；新題 .62s 淡入＋從下 12px＋blur 6px 對焦（只作用於整張題目，不作用於選項本身）。
- 選項進場：opacity 依序淡入，間隔 60ms，起始 120ms。
- 揭曉：對錯底色延遲 .12s；勾叉 .45s opacity 淡入延遲 .2s；詳解 .6s 淡入延遲 .3s。
- 結算：大號襯線分數。
- prefers-reduced-motion：全部瞬間完成。只動 transform / opacity / filter。

## 待 PM 補
圖片點放大（規格有、樣張沒做）；題號圓點超過約 12 題時要能橫向捲動；iOS Safari 實測（box 無法跑 WebKit）。

## 附錄 v1.1 對照（2026-11-02，配合 PL 規格 v1.1 與 ui-ux-donts）
- 站名回首頁：用元件庫 M8（字母方塊＋「考題網」），放在 M6 三線鈕右側 4px，首頁加 aria-current="page"。
- 手機首頁「快速入口」：錯題本、強弱表兩顆 B2，等高 44px、等寬兩欄，間距 8px；按下只變底色、不縮放。
- 作答泡泡：視覺 28px 圓，點擊區 44×44（用透明外擴，不改視覺大小）；單列橫向捲動，scroll-snap-type: x proximity，左右邊緣 16px 淡出遮罩；目前題自動捲到可見（scrollIntoView block:nearest，平滑 .22s var(--ease)，reduced-motion 時直接跳）。
- 對錯不只靠顏色：正確 ✓＋「正確答案」、錯誤 ✗＋「你的答案」；圖示 16px 與文字同色系，文字對比 ≥4.5。
- 手機內文最小 16px（題目、選項、詳解）；輔助小字最小 13px。
- 步驟或換題鈕（上一題／下一題）照元件庫 P3/P4：圓角長方形、固定尺寸與位置、連按不跳不閃。
- 禁用：文字底線鈕（舊 B5），一律改 B2。

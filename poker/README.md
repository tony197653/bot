# 週五牌局 · 德州撲克（里程碑 1）

單機熱座（傳裝置）無限注德州撲克。純 ES Module 規則引擎 + 經典綠色牌桌 UI，可直接由 GitHub Pages 提供：

https://tony197653.github.io/bot/poker/

## 本機

```bash
# 靜態伺服（需在含 bot 路徑的結構下，或直接開 poker/）
npx --yes serve -p 4173 .

# 測試
npm test
```

## 架構（為後續 Firebase 同步預留）

- `js/engine/`：純函式狀態機，`applyAction(state, action) → state`
- 狀態皆可 `JSON.stringify`；`viewForSeat(state, seat)` 產生該座位可見資訊
- 之後可由 HOST 瀏覽器跑引擎，把序列化狀態寫入 Firestore（Spark 方案、無 Cloud Functions）

## 熱座操作

1. 大廳設定盲注／籌碼／2–6 位玩家（預設含「宗良」）
2. 輪到誰就按「換人」把裝置交給對方（手牌僅自己可見）
3. 可關閉 30 秒計時方便測試

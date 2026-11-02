# 週五牌局 · 德州撲克（里程碑 2）

Google 登入 + Firestore 多人房間（專案 `tony-poker`）。單機熱座入口保留在大廳「同一支手機輪流玩」。

正式站：https://tony-poker.web.app/（Firebase Hosting；程式在本 repo 的 `poker/` + `lib/`）

## 本機

```bash
# 靜態伺服（需能解析 ../lib）
npx --yes serve -p 4173 ../   # 然後開 /poker/

# 單元測試
npm test

# Firestore 規則（模擬器 only，demo-poker；不寫正式庫）
npm run test:rules

# 部署前 stage
npm run stage
```

動畫調參：`/poker/playground.html`  
登入模組示範：`/lib/auth/demo.html`（見 `lib/auth/README.md`）

## 架構

- `lib/auth/`、`lib/firebase/`：可重用登入（§8）
- `poker/js/net/`：房間、房主循環、意圖、心跳、帳本、用量
- `poker/js/engine/`：純函式狀態機（新增 `SET_AWAY` / `VOID_HAND` / `TOP_UP`、`publicState`）
- `poker/firebase/`：規則（已部署）、索引、Hosting `stage.sh` + Action

## 熱座（里程碑 1）

大廳底部「同一支手機輪流玩」→ 原單機流程不變。

# Poker live 發布紀錄

發布前 fsync 寫入 PENDING，發布與驗證完成後寫入 DONE；失敗寫入 FAILED。
每列保留不可變版本、前版、宗良核准卡片、完整 artifact 雜湊及回復指令。
沒有已記錄的 live 基準時，工具必須拒絕發布；不得自動建立或猜測基準。
經人工確認的既有 live 可用相同欄位格式記錄 BASELINE；只有 BASELINE / DONE 建立基準。

| UTC 時間 | 狀態 | approval id | 版本 | 前一 live 版本 | approvalRef | manifest hash | rollback command |
| --- | --- | --- | --- | --- | --- | --- | --- |

| 2026-11-08T09:28:29Z | BASELINE | baseline-48dbeb5-20261108 | sites/tony-poker/versions/6bf25602b4157564 | sites/tony-poker/versions/6ded953378473aa2 | 宗良本對話核准 2026-11-08 17:26 Asia/Taipei | NOT_READ: full Hosting file manifest unavailable from channel:list; not an artifact attestation | firebase hosting:clone tony-poker@6ded953378473aa2 tony-poker:live --project tony-poker --config poker/firebase/firebase.json |

- 人工基準對應已核准的正式程式版本 `48dbeb5`；本輪只執行唯讀 `hosting:channel:list --project tony-poker --json`，確認 live 為 FINALIZED、39 files，release id `1794125601697000`。
- 宗良核准原文：「先合併 PR #53 並記下正式版 48dbeb5 基準，確認主線只建預覽後再合併 PR #52；不部署正式網站；最多 15 分鐘或 100 次停報」。
- `manifest hash` 未取得，不猜測，也未讀取憑證或執行 promote adapter；此列只建立版本基準，不構成未來正式發布的完整 artifact 核准。前版/rollback 依本對話既有核准紀錄，未於本輪重新發布或回滾。
| 2026-11-09T01:37:19.866Z | PENDING | 2026-11-09-personal-stats-cce7071 | sites/tony-poker/versions/cce7071d533b0015 | sites/tony-poker/versions/6bf25602b4157564 | t356s2081 | 01445801f0e41832ea2714c36cf17d9db932359ba461179ce47ad0521df578f2 | firebase hosting:clone tony-poker@6bf25602b4157564 tony-poker:live --project tony-poker --config poker/firebase/firebase.json |
| 2026-11-09T01:37:24.398Z | DONE | 2026-11-09-personal-stats-cce7071 | sites/tony-poker/versions/cce7071d533b0015 | sites/tony-poker/versions/6bf25602b4157564 | t356s2081 | 01445801f0e41832ea2714c36cf17d9db932359ba461179ce47ad0521df578f2 | firebase hosting:clone tony-poker@6bf25602b4157564 tony-poker:live --project tony-poker --config poker/firebase/firebase.json |

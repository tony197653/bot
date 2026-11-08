# Poker live 發布紀錄

發布前 fsync 寫入 PENDING，發布與驗證完成後寫入 DONE；失敗寫入 FAILED。
每列保留不可變版本、前版、宗良核准卡片、完整 artifact 雜湊及回復指令。
目前沒有已記錄的 live 基準，工具必須拒絕發布；不得自動建立或猜測基準。
經人工確認的既有 live 可用相同欄位格式記錄 BASELINE；只有 BASELINE / DONE 建立基準。

| UTC 時間 | 狀態 | approval id | 版本 | 前一 live 版本 | approvalRef | manifest hash | rollback command |
| --- | --- | --- | --- | --- | --- | --- | --- |

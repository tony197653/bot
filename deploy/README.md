# Poker live 發布保護

此流程是操作約定，不是 IAM 限制。CI 維持 preview-only：main 推送只部署 `main` channel，絕不自動發布 live。

核准前先確認不可變 `sites/tony-poker/versions/<id>`、完整 artifact（排序後 path/hash 清單及 `version.config`）與當時 live 版本，交由宗良核准卡片明確引用。產生器只接受不可變版本，不解析 channel：

```bash
node scripts/generate-approval.mjs \
  --id <approval-id> \
  --source sites/tony-poker/versions/<VERSION_ID> \
  --expected-live sites/tony-poker/versions/<CURRENT_LIVE_VERSION_ID> \
  --approval-ref <宗良核准卡片參照> \
  --quote '<宗良核准原文>'
```

核准 JSON 必須保留非空 `approvalRef`、核准文字、時間、來源版本、`expectedLiveVersion`、manifest、servingConfig 與完整 manifestDigest。核准卡片應引用這些確切版本與 artifact；不得用先前對可變 channel 的核准代替。

正式操作前必須明確設定 `GOOGLE_APPLICATION_CREDENTIALS` 指向所選 ADC 憑證檔；REST 另需 `HOSTING_ACCESS_TOKEN`，由操作者為同一憑證明確取得的短期 OAuth2 access token，或由程式注入 `getAccessToken`。工具不呼叫 login:ci、不使用 FIREBASE_TOKEN 當 REST bearer，也不讀取 gcloud active account。不得提交憑證或 token。

```bash
node scripts/promote-live.mjs --approval deploy/approvals/<approval-id>.json
```

工具以 `deploy/.promote.lock` 獨占鎖保護流程，finally 移除自己建立的鎖。必須已有 `deploy/releases.md` 的 DONE 或人工確認 BASELINE 紀錄，且符合核准的前版；空紀錄一律拒絕，不自動建立基準。來源須為 FINALIZED、fileCount 正確、path 無重複，檔案與 serving config 雜湊須完全相符。

發布前先 fsync 寫入 PENDING，再立即重讀 live，符合核准前版才呼叫 release；事後驗證版本與完整 artifact，fsync 寫入 DONE 或 FAILED。各列包括版本、前版、approvalRef、雜湊、時間、rollback command。外部 Console/CLI 可繞過本地鎖，因此最後檢查與發布仍非伺服器端原子交易。程序中斷留下 PENDING 或鎖時，需人工核對遠端狀態後處理，不能猜測成功。

實際發布命令維持：

```bash
firebase hosting:clone tony-poker@<VERSION_ID> tony-poker:live --project tony-poker --config poker/firebase/firebase.json
```

CLI 在 repo 根目錄執行並明確使用 `poker/firebase/firebase.json`。回復需為已記錄的前版取得新核准，再依相同流程操作。

測試只執行 `node --test deploy/test/`。測試全面封鎖真實網路與子程序，使用 mock adapter、注入 exec/fetch，以及暫存目錄中的 log/lock，絕不寫入真實發布紀錄。

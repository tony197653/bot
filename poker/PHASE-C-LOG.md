# PHASE C LOG

## C 第一輪（2026-11-08 11:26–11:37 台北時間，約11分）
分支 pm/pr49-c1（自 aa735d6），僅本機 demo-poker emulator；不推送、不合併、不部署。正式 statsEnabled()=false、STATS_ENABLED=false/T0=null 不變。
1. 資料拆分：新增 pokerStatsPublic/{uid}（僅 Page 指標：schemaVersion,startedAt,validHands,wonHands,vpip*/pfr*/threeBet* 機會/成功,netChips,updatedAt；無 lastHandKey）。host 同一 batch 寫 摘要+私有聚合+公開投影+receipt。Rules：公開投影 get 限 登入且非匿名且有 pokerPlayers/{auth.uid}；list/delete 拒；寫入須 statsEnabled 且每欄等於同交易後私有聚合；私有聚合要求 existsAfter(公開投影)。
2. 畫面骨架：js/ui/personal-stats.js 疊層（依 Page：首排勝率環/總手數、次排淨贏/目前籌碼、末排 VPIP 藍/PFR 黃/3-bet 紅三環）。入口：牌桌座位既有頭像 .av（只綁頭像）。疊層不卸載原畫面→牌局不暫停、不離座；返回鍵與瀏覽器返回同一路徑；只讀 pokerStatsPublic/{uid} 一次（getDocFromServer），無輪詢。
3. 測試：unit 200/200（新增 C1 3 案、B batch 案改 4 寫）；既有 Rules 142/142；B+C Rules 22/22（新增 C 6 案：host 寫投影無私有欄、登錄玩家讀他人、訪客/匿名/未註冊/list 拒、他人私有/摘要/pending 拒、任意寫/刪/偽造批次拒、合法新手補送成功且重送不重算）。B/C 需 --test-concurrency=1（共用 emulator 會互清）。
4. 真瀏覽器：點他人頭像顯示 大雄 勝率50.0%/2手/淨贏20/VPIP100%/PFR0%/3-bet —；瀏覽器返回與返回鍵都回原牌桌；開啟 idle10s repaints 0、emu requests 12（房間/presence 既有）。證據 /workspace/pr49c-r1/。
待 PL：見回報問題清單。

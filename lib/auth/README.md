# 可重用 Google 登入模組（§8）

撲克無關：只管 Firebase Auth + `users/{uid}`。籌碼／房間在專案自己的資料層。

## 4 步驟接入

1. 複製 `/lib/firebase/` 與 `/lib/auth/`（或同 repo 用相對路徑）。
2. Firebase Console 開 Google 登入；授權網域加上網站網域。放 Firebase Hosting 時用同網域 `authDomain` + `sameDomainAuth:true`；放 GitHub Pages 等跨網域站用 `mode:'popup'`。
3. 把 `auth.rules`（`// ===== [AUTH MODULE] =====` 段）貼進該專案 `firestore.rules`。
4. 頁面：

```js
import { initAuth, onUser, signIn, signOut, getFirebase, detectInAppBrowser } from '../lib/auth/auth.js';

await initAuth({
  firebaseConfig: { /* … */, authDomain: 'your-app.web.app' },
  usersCollection: 'users',
  storageKey: 'auth.v1',
  mode: 'auto',
  sameDomainAuth: true,
});

onUser(({ status, user, error, fromCache }) => {
  // signed-out | loading | signed-in | error | offline | in-app-browser
});
```

可選 UI：`auth-ui.js` 的 `renderAuthUi(root, state)`（樣式全吃 CSS 變數）。

## API

| 函式 | 說明 |
|---|---|
| `initAuth(opts)` | 初始化；先發快取再連 Firebase |
| `onUser(fn)` | 訂閱；回傳取消函式 |
| `getUser()` | 同步取得目前 user 或 null |
| `signIn()` / `signOut()` | Google 登入／登出（清快取） |
| `getFirebase()` | `{ app, auth, db, fs }` 給專案資料層 |
| `detectInAppBrowser()` | `null` 或 `{ app, reopenUrl }` |

`user` 只有 `{ uid, displayName, photoURL }`，**不存 email**。

## 已知限制

- iOS 16.1+ 跨網域 redirect 拿不到結果 → Hosting 同網域 authDomain，或改 popup。
- Hosting **預覽頻道**網域 ≠ authDomain → 模組自動改只用 popup；需在 Authentication 授權網域加上該預覽網域，或在桌機／一般 Safari 測。
- Safari 與 iOS 主畫面版 **localStorage 不共用**，兩邊要各登入一次。
- LINE／Facebook／Instagram 內建瀏覽器：不呼叫 `signIn()`，改引導外部瀏覽器（LINE 自動加 `openExternalBrowser=1`）。
- SDK 8 秒載不進來 → `status:'offline'`，仍帶快取 user。

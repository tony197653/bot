/**
 * §4.4 錯誤白話（畫面一律用這裡；錯誤碼只寫 console）。
 */

export const ERR = {
  network:
    '連不上網路，資料沒載入（或沒存進去）。請檢查網路後按重試。',
  permissionStudent:
    '登入已經過期，或這個帳號還沒加入名單。請重新登入。',
  permissionAdminImport:
    '沒有存入的權限，可能是登入過期。草稿還在，請重新登入後再存一次。',
  /** 作答交卷寫入被拒（§2） */
  sessionExpiredResult:
    '登入已經過期，結果先留在這台裝置。請按『重新登入』，登入後會自動補存',
  popupBlocked: '登入視窗被擋住了，請再按一次登入。',
  clipboard:
    '這個瀏覽器不能自動複製，文字已經全選，請長按複製。',
  storageUnavailable:
    '這台裝置不能暫存進度，重新整理後進度會不見，請一次做完再離開。',
  storageImportHint:
    '這台裝置不能暫存進度，重新整理後進度會不見，請一次做完再離開。先把確認好的題存入，不要關掉這頁。',
  importSaveFail:
    '沒存進去，可能是網路斷了或登入過期。草稿還在，請再按一次存入',
  cloudPending:
    '還沒存到雲端，結果先留在這台裝置。請按重試，或下次打開時會自動補存',
  loadQuestions:
    '題目沒載入成功，可能是網路斷了。請檢查網路後按重試',
  reportFail: '沒送出去，可能是網路斷了。請再按一次送出',
  deniedAllowlist: (email) =>
    `這個帳號（${email || '未知'}）還沒加入名單，請宗良把它加進去，或換一個帳號登入`,
  notFoundPage: '找不到這一頁',
  resultGone: '這回的結果已經存好了',
  quizNone: '目前沒有進行中的作答',
  importStudentOnly: '這一頁只有管理者能用',
  homeEmptyStudent: '題目還在準備中，可以先去錯題本複習',
  homeEmptyAdmin: '題目準備中。管理者可至匯入頁存入題目。',
  wrongEmpty: '目前沒有錯題，去做新的一回',
  wrongFilteredEmpty: '這個科目沒有錯題',
  unitsEmpty: '最近 30 天做完一回就會出現',
  rangeEmpty: '這個範圍還沒有題目',
  jsonBad: 'JSON 格式不正確，請檢查後再貼一次',
};

/**
 * @param {any} err
 * @returns {string}
 */
export function errCode(err) {
  return String(err?.code || err?.name || '');
}

/**
 * @param {any} err
 * @param {'student'|'admin-import'|'network'|'generic'} [kind]
 */
export function zhFromError(err, kind = 'generic') {
  const code = errCode(err);
  if (
    code === 'permission-denied' ||
    code === 'PERMISSION_DENIED' ||
    /permission-denied/i.test(String(err?.message || ''))
  ) {
    if (kind === 'admin-import') return ERR.permissionAdminImport;
    if (kind === 'student') return ERR.permissionStudent;
    return ERR.sessionExpiredResult;
  }
  if (
    code === 'unavailable' ||
    code === 'deadline-exceeded' ||
    code === 'auth/network-request-failed' ||
    code === 'offline' ||
    /network|timeout|unavailable|Failed to fetch/i.test(String(err?.message || code))
  ) {
    return ERR.network;
  }
  if (kind === 'admin-import') return ERR.importSaveFail;
  if (kind === 'network') return ERR.network;
  return ERR.network;
}

/**
 * Schema／欄位錯誤白話：第 N 題的『欄位』有問題：……
 * @param {number|null} n 1-based；null＝整批
 * @param {string} fieldZh
 * @param {string} what
 * @param {string} [how]
 */
export function schemaFieldError(n, fieldZh, what, how = '請 TU 檢查後再匯入') {
  const head = n == null ? `整批的『${fieldZh}』` : `第 ${n} 題的『${fieldZh}』`;
  return `${head}有問題：${what}。${how}`;
}

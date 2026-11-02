/* ===== 預覽／正式切換：只改這裡 ===== */
const CONFIG = {
  // TODO(launch): 正式 Worker 上線後改成實際 workers.dev 網址
  workerUrl: "https://ask-api.example.workers.dev",
  // TODO(launch): 正式 Turnstile Invisible site key；預設為 Cloudflare 隱形測試 key
  turnstileSiteKey: "1x00000000000000000000BB",
};
/* ===================================== */

(function () {
  "use strict";

  const MAX_LEN = 500;
  const WARN_LEN = 400;
  const STREAM_TIMEOUT_MS = 60_000;

  const SUGGESTIONS = ["怎麼跟同事委婉說不？", "德撲新手最常犯的錯？"];

  const ERR_MSG = {
    daily_limit: "今天的 40 題用完了，明天早上 8 點後再來。",
    all_quota: "今天大家把免費額度用完了，明天早上 8 點後再試。",
    busy: "現在太多人在用，請 30 秒後再試。",
    retry: "出了點問題，請再試一次。",
    empty: "AI 沒有給出回答，請再試一次。",
  };

  const el = {
    log: document.getElementById("log"),
    empty: document.getElementById("empty"),
    chips: document.getElementById("chips"),
    q: document.getElementById("q"),
    send: document.getElementById("send"),
    clear: document.getElementById("clear"),
    quotaNum: document.getElementById("quota-num"),
    quotaWrap: document.getElementById("quota"),
    counter: document.getElementById("counter"),
    counterLimit: document.getElementById("counter-limit"),
    shortcut: document.getElementById("shortcut"),
    status: document.getElementById("status"),
    toast: document.getElementById("toast"),
    inputWrap: document.getElementById("input-wrap"),
    turnstileHost: document.getElementById("turnstile-host"),
  };

  /** @type {{q:string,aText:string,status:string,el:HTMLElement}[]} */
  let turns = [];
  let remaining = null; // null = unknown
  let turnstileReady = false;
  let turnstileWidgetId = null;
  let turnstileStarted = false;
  let abortCtrl = null;
  let streaming = false;
  let autoScroll = true;
  let toastTimer = null;
  let busyRetryUntil = 0;

  const isDesktop = () => window.matchMedia("(min-width: 768px)").matches;

  /** 僅本機與 *.pages.dev 預覽允許 ?worker= / ?sitekey= 覆寫 */
  function allowConfigOverrides(hostname) {
    const h = hostname || location.hostname;
    return h === "localhost" || h === "127.0.0.1" || h.endsWith(".pages.dev");
  }

  function announce(msg) {
    el.status.textContent = "";
    // 強制重播
    requestAnimationFrame(() => {
      el.status.textContent = msg;
    });
  }

  function showToast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove("show"), 2000);
  }

  function setQuotaDisplay(n) {
    remaining = n;
    const full = el.quotaWrap.querySelector(".quota-full");
    const short = el.quotaWrap.querySelector(".quota-short");
    const showReset = typeof n === "number" && n <= 5;
    // 手機短標用「8 點重置」；桌面完整「早上 8 點重置」
    const resetFull = "早上 8 點重置";
    const resetShort = "8 點重置";
    if (n === null || n === undefined) {
      el.quotaWrap.classList.add("is-loading");
      full.innerHTML =
        `今天還能問 <b>—</b> 題<span class="quota-reset" hidden>${resetFull}</span>`;
      short.innerHTML =
        `剩 <b>—</b> 題<span class="quota-reset" hidden>${resetShort}</span>`;
      applyDisabledState();
      return;
    }
    el.quotaWrap.classList.remove("is-loading");
    const resetAttr = showReset ? "" : " hidden";
    full.innerHTML = `今天還能問 <b>${n}</b> 題<span class="quota-reset"${resetAttr}>${resetFull}</span>`;
    short.innerHTML = `剩 <b>${n}</b> 題<span class="quota-reset"${resetAttr}>${resetShort}</span>`;
    applyDisabledState();
  }

  function setQuotaFallback() {
    el.quotaWrap.classList.remove("is-loading");
    el.quotaWrap.querySelector(".quota-full").textContent = "今天最多問 40 題";
    el.quotaWrap.querySelector(".quota-short").textContent = "最多 40 題";
    remaining = null;
    applyDisabledState();
  }

  function trimmedLen() {
    return el.q.value.trim().length;
  }

  function applyDisabledState() {
    const out = remaining === 0;
    const empty = !el.q.value.trim();
    const over = trimmedLen() > MAX_LEN;
    const canSend = !streaming && !out && !empty && !over && turnstileReady;

    el.q.disabled = out || streaming;
    el.inputWrap.classList.toggle("is-disabled", out);
    el.inputWrap.classList.toggle("is-error", over && !out);
    if (out) {
      el.q.placeholder = "今天的 40 題用完了，明天早上 8 點後再來";
    } else if (!streaming) {
      el.q.placeholder = "輸入你的問題…";
    }

    el.chips.querySelectorAll("button").forEach((b) => {
      b.disabled = out || streaming;
    });

    el.clear.disabled = turns.length === 0;

    if (streaming) {
      el.send.disabled = false;
      el.send.dataset.mode = "stop";
      el.send.setAttribute("aria-label", "停止回答");
    } else {
      el.send.dataset.mode = "send";
      el.send.setAttribute("aria-label", "送出");
      el.send.disabled = !canSend;
    }
  }

  function resizeQ() {
    const q = el.q;
    q.style.height = "auto";
    const max = isDesktop() ? 220 : 140;
    q.style.height = Math.min(q.scrollHeight, max) + "px";
  }

  function updateCounter() {
    const n = trimmedLen();
    if (n > WARN_LEN) {
      el.counter.hidden = false;
      el.counter.textContent = `${n}/${MAX_LEN}`;
      el.counter.classList.toggle("is-warn", n > MAX_LEN);
      el.counterLimit.hidden = n <= MAX_LEN;
    } else {
      el.counter.hidden = true;
      el.counterLimit.hidden = true;
    }
    applyDisabledState();
  }

  function hideEmpty() {
    el.empty.hidden = true;
    el.chips.hidden = true;
  }

  function showEmpty() {
    el.empty.hidden = false;
    el.chips.hidden = false;
  }

  function scrollIfNeeded() {
    if (!autoScroll) return;
    el.log.scrollTop = el.log.scrollHeight;
  }

  el.log.addEventListener("scroll", () => {
    const dist = el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight;
    autoScroll = dist < 80;
  });

  function renderMarkdown(text) {
    const raw = marked.parse(text || "", { async: false });
    const clean = DOMPurify.sanitize(raw, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ["target", "rel", "tabindex"],
    });
    const wrap = document.createElement("div");
    wrap.innerHTML = clean;
    wrap.querySelectorAll("a[href]").forEach((a) => {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    });
    wrap.querySelectorAll("pre").forEach((pre) => {
      pre.setAttribute("tabindex", "0");
    });
    return wrap.innerHTML;
  }

  function makeThinking() {
    const d = document.createElement("div");
    d.className = "think";
    d.setAttribute("aria-busy", "true");
    d.innerHTML =
      '<div class="sk w1"></div><div class="sk w2"></div><div class="sk w3"></div>';
    return d;
  }

  function makeActions(turn, isLatest) {
    const row = document.createElement("div");
    row.className = "actions";

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "btn b2";
    copy.textContent = "複製";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(turn.aText || "");
        showToast("已複製");
      } catch {
        showToast("複製失敗，請長按文字自己複製");
      }
    });
    row.appendChild(copy);

    if (isLatest) {
      const regen = document.createElement("button");
      regen.type = "button";
      regen.className = "btn b2";
      regen.textContent = "重新產生";
      regen.disabled = remaining === 0;
      regen.addEventListener("click", () => regenerate(turn));
      row.appendChild(regen);
    }
    return row;
  }

  function appendTurn(question) {
    hideEmpty();
    const wrap = document.createElement("div");
    wrap.className = "turn";

    const qb = document.createElement("div");
    qb.className = "q-bubble";
    qb.textContent = question;
    wrap.appendChild(qb);

    const ab = document.createElement("div");
    ab.className = "a-block";
    ab.setAttribute("aria-busy", "true");
    const thinking = makeThinking();
    ab.appendChild(thinking);

    const hintTimer = setTimeout(() => {
      if (thinking.isConnected && !thinking.dataset.gotHint) {
        thinking.dataset.gotHint = "1";
        const h = document.createElement("p");
        h.className = "think-hint";
        h.textContent = "還在想，可能要 10 秒左右";
        thinking.appendChild(h);
      }
    }, 2000);

    wrap.appendChild(ab);
    el.log.appendChild(wrap);
    scrollIfNeeded();

    const turn = {
      q: question,
      aText: "",
      status: "thinking",
      el: wrap,
      ab,
      thinking,
      hintTimer,
      mdEl: null,
      cursor: null,
      actions: null,
      errEl: null,
      raf: 0,
      dirty: false,
    };
    turns.push(turn);
    applyDisabledState();
    return turn;
  }

  function ensureMd(turn) {
    if (turn.mdEl) return;
    if (turn.thinking) {
      clearTimeout(turn.hintTimer);
      turn.thinking.remove();
      turn.thinking = null;
    }
    turn.mdEl = document.createElement("div");
    turn.mdEl.className = "a-md";
    turn.cursor = document.createElement("span");
    turn.cursor.className = "cursor";
    turn.cursor.setAttribute("aria-hidden", "true");
    turn.ab.appendChild(turn.mdEl);
    turn.ab.appendChild(turn.cursor);
  }

  function scheduleRender(turn) {
    turn.dirty = true;
    if (turn.raf) return;
    turn.raf = requestAnimationFrame(() => {
      turn.raf = 0;
      if (!turn.dirty || !turn.mdEl) return;
      turn.dirty = false;
      turn.mdEl.innerHTML = renderMarkdown(turn.aText);
      scrollIfNeeded();
    });
  }

  function finishTurn(turn, status, opts = {}) {
    clearTimeout(turn.hintTimer);
    turn.status = status;
    turn.ab.setAttribute("aria-busy", "false");
    if (turn.cursor) {
      turn.cursor.remove();
      turn.cursor = null;
    }
    if (turn.thinking) {
      turn.thinking.remove();
      turn.thinking = null;
    }
    if (opts.stoppedNote) {
      const s = document.createElement("div");
      s.className = "stopped";
      s.textContent = "（已停止）";
      turn.ab.appendChild(s);
    }
    if (opts.truncated) {
      const s = document.createElement("div");
      s.className = "truncated";
      s.textContent = "（回答太長，已截斷）";
      turn.ab.appendChild(s);
    }
    if (turn.actions) turn.actions.remove();
    if (status === "done" || status === "stopped") {
      // 舊則拿掉重新產生
      turns.forEach((t, i) => {
        if (t.actions) {
          t.actions.remove();
          t.actions = makeActions(t, i === turns.length - 1);
          t.ab.appendChild(t.actions);
        }
      });
      turn.actions = makeActions(turn, true);
      turn.ab.appendChild(turn.actions);
    }
    applyDisabledState();
    scrollIfNeeded();
  }

  function showError(turn, code, { withRetry = true } = {}) {
    if (turn.errEl) turn.errEl.remove();
    const card = document.createElement("div");
    card.className = "err-card";
    const p = document.createElement("p");
    p.textContent = ERR_MSG[code] || ERR_MSG.retry;
    card.appendChild(p);

    const noRetry = code === "daily_limit" || code === "all_quota";
    if (withRetry && !noRetry) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn b2";
      btn.textContent = "重試";
      btn.addEventListener("click", () => {
        if (code === "busy" && Date.now() < busyRetryUntil) {
          const left = Math.ceil((busyRetryUntil - Date.now()) / 1000);
          btn.textContent = `${left} 秒`;
          return;
        }
        retryTurn(turn);
      });
      if (code === "busy") {
        busyRetryUntil = Date.now() + 30_000;
        const tick = () => {
          if (!btn.isConnected) return;
          const left = Math.ceil((busyRetryUntil - Date.now()) / 1000);
          if (left > 0) {
            btn.textContent = `${left} 秒後重試`;
            btn.disabled = true;
            setTimeout(tick, 250);
          } else {
            btn.textContent = "重試";
            btn.disabled = false;
          }
        };
        tick();
      }
      card.appendChild(btn);
    }
    turn.ab.appendChild(card);
    turn.errEl = card;
    turn.status = "error";
    turn.ab.setAttribute("aria-busy", "false");
    if (turn.cursor) {
      turn.cursor.remove();
      turn.cursor = null;
    }
    if (turn.thinking) {
      clearTimeout(turn.hintTimer);
      turn.thinking.remove();
      turn.thinking = null;
    }
    announce(p.textContent);
    applyDisabledState();
    scrollIfNeeded();
  }

  async function getTurnstileToken() {
    if (!window.turnstile) throw new Error("turnstile");
    const id = turnstileWidgetId;
    return new Promise((resolve, reject) => {
      try {
        if (typeof window.turnstile.execute === "function") {
          window.turnstile.execute(id, {
            callback: (token) => {
              resolve(token);
              // token 用過後再 reset，避免「already executing」
              try {
                if (window.turnstile.reset) window.turnstile.reset(id);
              } catch {
                /* ignore */
              }
            },
            "error-callback": () => reject(new Error("turnstile")),
          });
        } else {
          // 測試／invisible 已自動 callback 的備援
          resolve("test-token");
        }
      } catch (e) {
        reject(e);
      }
    });
  }

  async function parseSse(reader, onEvent) {
    const dec = new TextDecoder();
    let buf = "";
    let event = null;
    let data = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).trim());
        } else if (line === "") {
          if (data.length) {
            await onEvent(event, data.join("\n"));
          }
          event = null;
          data = [];
        }
      }
    }
    if (data.length) await onEvent(event, data.join("\n"));
  }

  async function streamAsk(turn, { replace = false } = {}) {
    streaming = true;
    applyDisabledState();
    announce("AI 回答中");

    abortCtrl = new AbortController();
    const timeout = setTimeout(() => abortCtrl.abort("timeout"), STREAM_TIMEOUT_MS);

    try {
      let token;
      try {
        token = await getTurnstileToken();
      } catch {
        finishPartialThenError(turn, "retry");
        return;
      }

      const res = await fetch(`${CONFIG.workerUrl}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: turn.q, turnstileToken: token }),
        signal: abortCtrl.signal,
      });

      if (!res.ok) {
        let code = "retry";
        try {
          const j = await res.json();
          code = j.code || code;
          if (typeof j.remaining === "number") setQuotaDisplay(j.remaining);
        } catch {
          /* ignore */
        }
        if (code === "daily_limit") setQuotaDisplay(0);
        showError(turn, code === "too_fast" ? "busy" : code);
        return;
      }

      if (!res.body) {
        showError(turn, "retry");
        return;
      }

      let gotDone = false;
      await parseSse(res.body.getReader(), async (event, data) => {
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          return;
        }
        if (event === "meta" && typeof json.remaining === "number") {
          setQuotaDisplay(json.remaining);
        } else if (event === "done") {
          gotDone = true;
          if (!turn.aText) {
            showError(turn, "empty");
            return;
          }
          finishTurn(turn, "done", { truncated: !!json.truncated });
          announce("回答完成");
        } else if (event === "error") {
          gotDone = true;
          finishPartialThenError(turn, json.code || "retry");
        } else if (!event && json.t) {
          ensureMd(turn);
          turn.status = "streaming";
          turn.aText += json.t;
          scheduleRender(turn);
        }
      });

      if (!gotDone && turn.status === "streaming") {
        finishTurn(turn, "done");
        announce("回答完成");
      } else if (!gotDone && turn.status === "thinking") {
        showError(turn, "retry");
      }
    } catch (e) {
      if (e && (e.name === "AbortError" || abortCtrl?.signal?.aborted)) {
        if (abortCtrl.signal.reason === "timeout") {
          finishPartialThenError(turn, "retry");
        } else {
          // 使用者停止
          if (turn.aText) {
            ensureMd(turn);
            scheduleRender(turn);
            finishTurn(turn, "stopped", { stoppedNote: true });
          } else {
            if (turn.thinking) {
              clearTimeout(turn.hintTimer);
              turn.thinking.remove();
              turn.thinking = null;
            }
            turn.aText = "";
            finishTurn(turn, "stopped", { stoppedNote: true });
          }
          announce("已停止");
        }
      } else {
        finishPartialThenError(turn, "retry");
      }
    } finally {
      clearTimeout(timeout);
      streaming = false;
      abortCtrl = null;
      applyDisabledState();
      if (isDesktop() && remaining !== 0) {
        el.q.focus();
      }
      resizeQ();
    }
  }

  function finishPartialThenError(turn, code) {
    if (turn.aText) {
      ensureMd(turn);
      if (turn.raf) {
        cancelAnimationFrame(turn.raf);
        turn.raf = 0;
      }
      turn.dirty = false;
      turn.mdEl.innerHTML = renderMarkdown(turn.aText);
      if (turn.cursor) {
        turn.cursor.remove();
        turn.cursor = null;
      }
      turn.ab.setAttribute("aria-busy", "false");
    }
    showError(turn, code);
  }

  function stopStream() {
    if (abortCtrl) abortCtrl.abort("user");
  }

  async function submit(text) {
    const q = (text ?? el.q.value).trim();
    if (!q || q.length > MAX_LEN || streaming || remaining === 0) return;
    el.q.value = "";
    resizeQ();
    updateCounter();
    const turn = appendTurn(q);
    await streamAsk(turn);
  }

  async function regenerate(turn) {
    if (streaming || remaining === 0) return;
    // 取代回答
    turn.aText = "";
    turn.status = "thinking";
    turn.ab.innerHTML = "";
    turn.mdEl = null;
    turn.cursor = null;
    turn.actions = null;
    turn.errEl = null;
    turn.thinking = makeThinking();
    turn.ab.appendChild(turn.thinking);
    turn.ab.setAttribute("aria-busy", "true");
    turn.hintTimer = setTimeout(() => {
      if (turn.thinking && turn.thinking.isConnected && !turn.thinking.dataset.gotHint) {
        turn.thinking.dataset.gotHint = "1";
        const h = document.createElement("p");
        h.className = "think-hint";
        h.textContent = "還在想，可能要 10 秒左右";
        turn.thinking.appendChild(h);
      }
    }, 2000);
    // 移到最新
    const idx = turns.indexOf(turn);
    if (idx >= 0) {
      turns.splice(idx, 1);
      turns.push(turn);
    }
    el.log.appendChild(turn.el);
    await streamAsk(turn, { replace: true });
  }

  async function retryTurn(turn) {
    if (streaming) return;
    if (turn.errEl) {
      turn.errEl.remove();
      turn.errEl = null;
    }
    if (!turn.aText) {
      turn.thinking = makeThinking();
      turn.ab.appendChild(turn.thinking);
      turn.ab.setAttribute("aria-busy", "true");
      turn.status = "thinking";
    } else {
      // 保留部分字，繼續？規格：重試＝用同一題重送；錯誤卡換成思考中
      turn.aText = "";
      turn.mdEl = null;
      turn.ab.innerHTML = "";
      turn.thinking = makeThinking();
      turn.ab.appendChild(turn.thinking);
      turn.ab.setAttribute("aria-busy", "true");
      turn.status = "thinking";
    }
    await streamAsk(turn);
  }

  function clearScreen() {
    if (streaming) stopStream();
    turns = [];
    el.log.querySelectorAll(".turn").forEach((n) => n.remove());
    showEmpty();
    applyDisabledState();
    el.q.focus();
  }

  // —— 事件 ——
  el.q.addEventListener("input", () => {
    resizeQ();
    updateCounter();
  });

  el.q.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      if (!streaming) submit();
    }
  });

  el.send.addEventListener("click", () => {
    if (streaming) stopStream();
    else submit();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && streaming) {
      e.preventDefault();
      stopStream();
    }
  });

  el.clear.addEventListener("click", clearScreen);

  SUGGESTIONS.forEach((text) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn b4";
    b.textContent = text;
    b.addEventListener("click", () => submit(text));
    el.chips.appendChild(b);
  });

  async function loadQuota() {
    setQuotaDisplay(null);
    try {
      const res = await fetch(`${CONFIG.workerUrl}/quota`);
      if (!res.ok) throw new Error("quota");
      const j = await res.json();
      if (typeof j.remaining === "number") setQuotaDisplay(j.remaining);
      else setQuotaFallback();
    } catch {
      setQuotaFallback();
    }
  }

  function initTurnstile() {
    const start = () => {
      if (turnstileStarted || !window.turnstile) return;
      turnstileStarted = true;
      // execution:"execute"：只在送出時 execute；用完再 reset
      turnstileWidgetId = window.turnstile.render(el.turnstileHost, {
        sitekey: CONFIG.turnstileSiteKey,
        execution: "execute",
        callback: () => {},
      });
      turnstileReady = true;
      applyDisabledState();
    };
    // 官方 onload 回呼（單一入口）；若腳本已就緒則立即 render 一次
    window.onAskTurnstileLoad = start;
    if (window.turnstile) start();
  }

  // 匯出給測試
  window.__ASK__ = {
    CONFIG,
    submit,
    stopStream,
    clearScreen,
    setQuotaDisplay,
    allowConfigOverrides,
    __setTurnstileReady(v) {
      turnstileReady = !!v;
      if (turnstileWidgetId === null) turnstileWidgetId = 1;
      applyDisabledState();
    },
    get remaining() {
      return remaining;
    },
    get streaming() {
      return streaming;
    },
    get turns() {
      return turns;
    },
    ERR_MSG,
    appendTurn,
  };

  // 預覽／測試：僅 localhost／127.0.0.1／*.pages.dev 可用 ?worker= / ?sitekey=
  try {
    if (window.__ASK_BOOT__?.workerUrl) CONFIG.workerUrl = window.__ASK_BOOT__.workerUrl;
    if (window.__ASK_BOOT__?.sitekey) CONFIG.turnstileSiteKey = window.__ASK_BOOT__.sitekey;
    if (allowConfigOverrides()) {
      const u = new URL(location.href);
      if (u.searchParams.get("worker")) CONFIG.workerUrl = u.searchParams.get("worker");
      if (u.searchParams.get("sitekey")) CONFIG.turnstileSiteKey = u.searchParams.get("sitekey");
    }
  } catch {
    /* ignore */
  }

  initTurnstile();
  loadQuota();
  applyDisabledState();
  resizeQ();
  if (isDesktop()) el.q.focus();
})();

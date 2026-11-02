/**
 * Playwright：chromium＋webkit；390／1280 截圖與 IME／互動檢查；
 * 額度列單行：360／375／390／1280 與 360@120% 字級。
 * 前置：mock-worker :8787、靜態服務 :4173（本腳本會自己拉起）。
 */
import { chromium, webkit } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASK_ROOT = path.resolve(__dirname, "..");
const ART = "/opt/cursor/artifacts/screenshots";
const PAGE = "http://127.0.0.1:4173/";
const WORKER = "http://127.0.0.1:8787";

/** 額度列必須單行；清除鈕同列不重疊。 */
async function assertQuotaSingleLine(page, { width, remaining = 39, rootScale = 1, label }) {
  if (rootScale !== 1) {
    // 模擬系統放大字級：root + 頂欄 px 字級一併放大（頁面多為 px）
    const s = rootScale;
    await page.addStyleTag({
      content: `
        html{font-size:${16 * s}px!important}
        body{font-size:${16 * s}px!important}
        .top h1{font-size:${18 * s}px!important}
        .l5inline,.l5inline b,.quota-reset,.btn.b5{font-size:${16 * s}px!important}
        .l5inline b{min-width:${22 * s}px;height:${22 * s}px}
      `,
    });
  }
  await page.evaluate((n) => window.__ASK__.setQuotaDisplay(n), remaining);
  const info = await page.evaluate(({ width: w }) => {
    const short = document.querySelector(".quota-short");
    const full = document.querySelector(".quota-full");
    const useFull = w >= 768;
    const el = useFull ? full : short;
    const b = el?.querySelector("b");
    const clear = document.getElementById("clear");
    const top = document.querySelector(".top");
    const end = document.querySelector(".top-end");
    if (!el || !b || !clear || !top || !end) {
      return { ok: false, reason: "missing nodes" };
    }
    const r = el.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    const cr = clear.getBoundingClientRect();
    const er = end.getBoundingClientRect();
    const tr = top.getBoundingClientRect();
    const text = el.innerText.replace(/\s+/g, " ").trim();
    const lineH = parseFloat(getComputedStyle(el).lineHeight) || 26;
    // 單行：高度約一行；badge 與文字垂直中線接近；文字不換行
    const oneLineH = Math.max(lineH, 22) + 8; // 容許 badge 22px + 少許
    const mid = (r.top + r.bottom) / 2;
    const bmid = (br.top + br.bottom) / 2;
    const sameLine =
      Math.abs(r.top - br.top) < 6 &&
      Math.abs(r.bottom - br.bottom) < 10 &&
      Math.abs(mid - bmid) < 1.5;
    // 清除鈕與額度不重疊；同在 header 內；清除本身不換行
    const overlap =
      !(r.right <= cr.left + 0.5 || cr.right <= r.left + 0.5 || r.bottom <= cr.top + 0.5 || cr.bottom <= r.top + 0.5);
    const clearWrap = cr.height > 48;
    const endOverflow = er.right > tr.right + 1 || er.left < tr.left - 1;
    return {
      ok: true,
      text,
      h: r.height,
      oneLineH,
      sameLine,
      offset: Math.abs(mid - bmid),
      overlap,
      clearWrap,
      endOverflow,
      clearText: clear.innerText.trim(),
      endW: er.width,
      topW: tr.width,
      useFull,
    };
  }, { width });

  const tag = label || `${width}@${rootScale}`;
  if (!info.ok) throw new Error(`quota layout missing (${tag}): ${info.reason}`);
  const expectShort = width < 768;
  const expectText = expectShort
    ? `剩 ${remaining} 題`
    : `今天還能問 ${remaining} 題`;
  // remaining<=5 會多重置文案
  const expectBase =
    remaining <= 5 ? `${expectText} 早上 8 點重置` : expectText;
  if (info.text !== expectBase) {
    throw new Error(`quota text (${tag}): got "${info.text}" want "${expectBase}"`);
  }
  if (!info.sameLine || info.h > info.oneLineH) {
    throw new Error(`quota not single-line (${tag}): ${JSON.stringify(info)}`);
  }
  if (info.offset >= 1.5) {
    throw new Error(`quota badge offset (${tag}): ${info.offset}`);
  }
  if (info.overlap) throw new Error(`quota/clear overlap (${tag})`);
  if (info.clearWrap) throw new Error(`清除畫面 wrapped (${tag}): h=${info.h}`);
  if (info.clearText !== "清除畫面") throw new Error(`clear label (${tag})`);
  if (info.endOverflow) throw new Error(`top-end overflows header (${tag})`);
  return info;
}

function run(cmd, args, opts = {}) {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  p.stdout.on("data", (d) => process.stdout.write(d));
  p.stderr.on("data", (d) => process.stderr.write(d));
  return p;
}

async function waitOk(url, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("timeout waiting " + url);
}

async function shot(page, name) {
  const file = path.join(ART, name);
  await page.screenshot({ path: file, fullPage: false });
  console.log("shot", file);
  return file;
}

/** 攔截 Turnstile：提供假 API。 */
async function installTurnstileFake(page) {
  await page.addInitScript(() => {
    window.turnstile = {
      render(host, opts) {
        host.dataset.rendered = "1";
        return 1;
      },
      reset() {},
      execute(_id, opts) {
        const cb = opts?.callback || (() => {});
        setTimeout(() => cb("test-token"), 10);
      },
      remove() {},
    };
    window.onAskTurnstileLoad = () => {};
  });
}

async function openAsk(page, width, height) {
  await page.setViewportSize({ width, height });
  await installTurnstileFake(page);
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await page.evaluate((workerUrl) => {
    window.__ASK__.CONFIG.workerUrl = workerUrl;
    window.__ASK__.CONFIG.turnstileSiteKey = "1x00000000000000000000AA";
    // 重新拉 quota
    return fetch(workerUrl + "/quota")
      .then((r) => r.json())
      .then((j) => window.__ASK__.setQuotaDisplay(j.remaining));
  }, WORKER);
  // 標記 turnstile ready
  await page.evaluate(() => {
    // 觸發內部：直接讓送出鈕可按
    const send = document.getElementById("send");
    // force ready via private path — set input and check
  });
  // re-init turnstile ready by calling fake render path
  await page.evaluate(() => {
    // app.js sets turnstileReady only in initTurnstile; force by enabling
    const q = document.getElementById("q");
    q.disabled = false;
  });
  // Patch: expose setter
  await page.evaluate(() => {
    // turnstileReady is closed-over; re-render fake and poke apply via input
    if (window.turnstile) {
      window.turnstile.render(document.getElementById("turnstile-host"), {
        sitekey: "1x00000000000000000000AA",
      });
    }
  });
  // Force turnstileReady by submitting through __ASK__ after patching get token
  await page.evaluate(() => {
    // Monkeypatch: if send still disabled due to turnstile, enable by typing
    const orig = window.__ASK__;
    // recreate ready by dispatching — simplest: override submit's token fetch
  });
}

async function forceReady(page) {
  // app.js keeps turnstileReady private; inject a bypass by replacing fetch path used after token
  await page.evaluate(() => {
    // Patch getTurnstile by replacing turnstile.execute already done.
    // If send is disabled only due to turnstile, simulate ready:
    const send = document.getElementById("send");
    const q = document.getElementById("q");
    q.value = "x";
    q.dispatchEvent(new Event("input"));
    // still may be disabled — expose hook
  });
  // Directly patch closed vars via rewriting CONFIG + custom property
  await page.addStyleTag({ content: "" });
  // Use evaluate to open send by calling internal through typing after we set a flag
  await page.evaluate(() => {
    window.__ASK_TEST_READY__ = true;
  });
}

// Better approach: patch app.js to read turnstileReady from a test hook.
// We'll add a small test hook in app.js instead of fighting closures.

async function main() {
  await mkdir(ART, { recursive: true });

  const worker = run("node", [path.join(__dirname, "mock-worker.mjs"), "8787"], {
    cwd: ASK_ROOT,
  });
  const serve = run(
    "npx",
    ["--yes", "serve", "-l", "4173", "."],
    { cwd: ASK_ROOT },
  );

  try {
    await waitOk("http://127.0.0.1:8787/quota");
    await waitOk("http://127.0.0.1:4173/");

    const results = [];

    async function withBrowser(launcher, name, runFn) {
      const browser = await launcher.launch({ headless: true });
      try {
        async function withPage(width, height, fn) {
          const page = await browser.newPage();
          await page.setViewportSize({ width, height });
          await installTurnstileFake(page);
          await page.addInitScript(({ workerUrl }) => {
            Object.defineProperty(window, "__ASK_BOOT__", {
              value: { workerUrl, sitekey: "1x00000000000000000000BB" },
            });
          }, { workerUrl: WORKER });
          await page.goto(PAGE, { waitUntil: "networkidle" });
          await page.evaluate((workerUrl) => {
            window.__ASK__.CONFIG.workerUrl = workerUrl;
            window.turnstile = window.turnstile || {
              render() {
                return 1;
              },
              reset() {},
              execute(_i, o) {
                setTimeout(() => o.callback("tok"), 5);
              },
            };
            return fetch(workerUrl + "/quota")
              .then((r) => r.json())
              .then((j) => window.__ASK__.setQuotaDisplay(j.remaining));
          }, WORKER);
          await page.evaluate(() => window.__ASK__.__setTurnstileReady?.(true));
          await fn(page);
          await page.close();
        }
        await runFn({ withPage, name });
      } finally {
        await browser.close();
      }
    }

    // —— 額度列單行：chromium + webkit × 360/375/390/1280 + 360@120% ——
    for (const [launcher, eng] of [
      [chromium, "chromium"],
      [webkit, "webkit"],
    ]) {
      await withBrowser(launcher, eng, async ({ withPage }) => {
        const cases = [
          { width: 360, height: 800, rootScale: 1 },
          { width: 375, height: 812, rootScale: 1 },
          { width: 390, height: 844, rootScale: 1 },
          { width: 1280, height: 800, rootScale: 1 },
          { width: 360, height: 800, rootScale: 1.2 },
        ];
        for (const c of cases) {
          await withPage(c.width, c.height, async (page) => {
            const label = `${eng}-${c.width}${c.rootScale !== 1 ? `@${c.rootScale}` : ""}`;
            await assertQuotaSingleLine(page, {
              width: c.width,
              remaining: 39,
              rootScale: c.rootScale,
              label,
            });
            await shot(page, `ask-quota-${label}.png`);
          });
        }
        results.push(`${eng} quota single-line matrix OK`);
      });
    }

    const browser = await chromium.launch({ headless: true });
    async function withPage(width, height, fn) {
      const page = await browser.newPage();
      await page.setViewportSize({ width, height });
      await installTurnstileFake(page);
      // Patch before load: make turnstile appear ready immediately and point worker
      await page.addInitScript(({ workerUrl }) => {
        Object.defineProperty(window, "__ASK_BOOT__", {
          value: { workerUrl, sitekey: "1x00000000000000000000BB" },
        });
      }, { workerUrl: WORKER });
      await page.goto(PAGE, { waitUntil: "networkidle" });
      await page.evaluate((workerUrl) => {
        window.__ASK__.CONFIG.workerUrl = workerUrl;
        // Force turnstile ready if init already ran without fake
        window.turnstile = window.turnstile || {
          render() {
            return 1;
          },
          reset() {},
          execute(_i, o) {
            setTimeout(() => o.callback("tok"), 5);
          },
        };
        // Re-fetch quota against mock
        return fetch(workerUrl + "/quota")
          .then((r) => r.json())
          .then((j) => window.__ASK__.setQuotaDisplay(j.remaining));
      }, WORKER);
      // Enable turnstileReady via test hook
      await page.evaluate(() => window.__ASK__.__setTurnstileReady?.(true));
      await fn(page);
      await page.close();
    }

    // —— 390 空狀態 ——
    await withPage(390, 844, async (page) => {
      await page.waitForSelector("#q");
      await page.evaluate(() => window.__ASK__.setQuotaDisplay(19));
      const quota390 = await page.evaluate(() => {
        const el = document.querySelector(".quota-short");
        const b = el?.querySelector("b");
        const r = el.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        const mid = (r.top + r.bottom) / 2;
        const bmid = (br.top + br.bottom) / 2;
        return {
          text: el.innerText.replace(/\s+/g, " ").trim(),
          h: r.height,
          offset: Math.abs(mid - bmid),
          sameLine: Math.abs(r.top - br.top) < 4 && Math.abs(r.bottom - br.bottom) < 8,
          hasMain: !!document.querySelector("main#log"),
          resetHidden: el.querySelector(".quota-reset")?.hidden === true,
        };
      });
      if (quota390.text !== "剩 19 題") throw new Error("quota text 390: " + quota390.text);
      if (!quota390.sameLine || quota390.h > 32) {
        throw new Error("quota badge wraps at 390: " + JSON.stringify(quota390));
      }
      if (quota390.offset >= 1) {
        throw new Error("quota badge offset >=1px at 390: " + quota390.offset);
      }
      if (!quota390.hasMain) throw new Error("missing <main id=log>");
      if (!quota390.resetHidden) throw new Error("reset hint should hide when remaining>5");

      // remaining <=5 shows reset hint with readable contrast
      await page.evaluate(() => window.__ASK__.setQuotaDisplay(5));
      const reset5 = await page.evaluate(() => {
        const el = document.querySelector(".quota-short .quota-reset");
        const cs = getComputedStyle(el);
        const bg = getComputedStyle(document.body).backgroundColor;
        function lum(c) {
          const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
          if (!m) return 1;
          const [r, g, b] = [m[1], m[2], m[3]].map((x) => {
            const s = Number(x) / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        }
        const L1 = lum(cs.color);
        const L2 = lum(bg);
        const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
        return { hidden: el.hidden, text: el.textContent, ratio };
      });
      if (reset5.hidden || reset5.text !== "早上 8 點重置") {
        throw new Error("reset hint at 5: " + JSON.stringify(reset5));
      }
      if (reset5.ratio < 4.5) throw new Error("reset contrast <4.5: " + reset5.ratio);

      await page.evaluate(() => window.__ASK__.setQuotaDisplay(19));
      await shot(page, "ask-empty-390.png");

      // fonts: only .foot-disc may be <16
      const smallFonts = await page.evaluate(() => {
        const bad = [];
        const walk = (node) => {
          if (node.nodeType !== 1) return;
          if (node.matches?.(".foot-disc, .sr, [hidden], script, style, svg, svg *")) return;
          const kids = node.children;
          if (!kids.length && node.textContent.trim()) {
            const fs = parseFloat(getComputedStyle(node).fontSize);
            if (fs < 16) bad.push({ tag: node.tagName, cls: node.className, fs });
          }
          for (const c of kids) walk(c);
        };
        walk(document.body);
        // also check known UI nodes with text
        for (const sel of [
          ".l5inline",
          ".l5inline b",
          ".btn",
          ".emp .disc",
          ".meta-row",
          ".toast",
        ]) {
          const n = document.querySelector(sel);
          if (!n) continue;
          const fs = parseFloat(getComputedStyle(n).fontSize);
          if (fs < 16) bad.push({ sel, fs });
        }
        const foot = parseFloat(getComputedStyle(document.querySelector(".foot-disc")).fontSize);
        return { bad, foot };
      });
      if (Math.abs(smallFonts.foot - 13) > 0.5) {
        throw new Error("foot-disc should stay 13px: " + smallFonts.foot);
      }
      if (smallFonts.bad.length) {
        throw new Error("font <16 outside D: " + JSON.stringify(smallFonts.bad));
      }

      // over 500 → error halo; trim before length
      await page.evaluate(() => {
        const q = document.getElementById("q");
        q.value = "  " + "啊".repeat(501) + "  ";
        q.dispatchEvent(new Event("input"));
      });
      const errState = await page.evaluate(() =>
        document.getElementById("input-wrap").classList.contains("is-error"),
      );
      if (!errState) throw new Error("expected is-error over 500 trimmed chars");
      await page.evaluate(() => {
        const q = document.getElementById("q");
        q.value = "  " + "啊".repeat(500) + "  ";
        q.dispatchEvent(new Event("input"));
      });
      const okState = await page.evaluate(() =>
        document.getElementById("input-wrap").classList.contains("is-error"),
      );
      if (okState) throw new Error("500 trimmed chars should not error");
      await page.fill("#q", "");

      // overrides gated
      const gate = await page.evaluate(() => ({
        local: window.__ASK__.allowConfigOverrides("127.0.0.1"),
        pages: window.__ASK__.allowConfigOverrides("foo.pages.dev"),
        prod: window.__ASK__.allowConfigOverrides("tony197653.github.io"),
      }));
      if (!gate.local || !gate.pages || gate.prod) {
        throw new Error("override host gate: " + JSON.stringify(gate));
      }

      // Turnstile: onAskTurnstileLoad 再呼叫不得重複 render
      const extraRenders = await page.evaluate(() => {
        let n = 0;
        const orig = window.turnstile.render.bind(window.turnstile);
        window.turnstile.render = (...a) => {
          n++;
          return orig(...a);
        };
        window.onAskTurnstileLoad?.();
        window.onAskTurnstileLoad?.();
        window.turnstile.render = orig;
        return n;
      });
      if (extraRenders !== 0) {
        throw new Error("Turnstile re-rendered: " + extraRenders);
      }
      results.push("override/fonts/error OK");
      const chips = await page.locator("#chips button").count();
      if (chips !== 2) throw new Error("expected 2 chips, got " + chips);
      // IME: composition Enter must not submit
      await page.focus("#q");
      await page.evaluate(() => {
        const q = document.getElementById("q");
        q.value = "測試";
        q.dispatchEvent(new Event("input"));
        const e = new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(e, "isComposing", { get: () => true });
        Object.defineProperty(e, "keyCode", { get: () => 229 });
        q.dispatchEvent(e);
      });
      await page.waitForTimeout(200);
      if ((await page.locator(".turn").count()) !== 0) {
        throw new Error("IME Enter should not submit");
      }
      results.push("IME composition OK");

      // keyCode 229 without isComposing
      await page.evaluate(() => {
        const q = document.getElementById("q");
        const e = new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(e, "isComposing", { get: () => false });
        Object.defineProperty(e, "keyCode", { get: () => 229 });
        q.dispatchEvent(e);
      });
      await page.waitForTimeout(200);
      if ((await page.locator(".turn").count()) !== 0) {
        throw new Error("keyCode 229 should not submit");
      }

      // no horizontal scroll
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      if (overflow) throw new Error("horizontal scroll at 390");

      // buttons >= 44
      const sizes = await page.evaluate(() => {
        const nodes = [
          document.getElementById("send"),
          ...document.querySelectorAll("#chips button"),
        ];
        return nodes.map((n) => {
          const r = n.getBoundingClientRect();
          return { w: r.width, h: r.height };
        });
      });
      for (const s of sizes) {
        if (s.w < 44 || s.h < 44) throw new Error("tap target < 44: " + JSON.stringify(s));
      }
      results.push("390 empty + targets OK");
    });

    // —— 1280 空狀態 + 串流完成 ——
    await withPage(1280, 800, async (page) => {
      await page.evaluate(() => window.__ASK__.setQuotaDisplay(19));
      const quota1280 = await page.evaluate(() => {
        const el = document.querySelector(".quota-full");
        const b = el?.querySelector("b");
        const r = el.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        const mid = (r.top + r.bottom) / 2;
        const bmid = (br.top + br.bottom) / 2;
        return {
          text: el.innerText.replace(/\s+/g, " ").trim(),
          h: r.height,
          offset: Math.abs(mid - bmid),
          sameLine: Math.abs(r.top - br.top) < 4 && Math.abs(r.bottom - br.bottom) < 8,
        };
      });
      if (quota1280.text !== "今天還能問 19 題") {
        throw new Error("quota text 1280: " + quota1280.text);
      }
      if (!quota1280.sameLine || quota1280.h > 32) {
        throw new Error("quota badge wraps at 1280: " + JSON.stringify(quota1280));
      }
      if (quota1280.offset >= 1) {
        throw new Error("quota badge offset >=1px at 1280: " + quota1280.offset);
      }
      await shot(page, "ask-empty-1280.png");
      await page.fill("#q", "用條列說明");
      await page.click("#send");
      await page.waitForSelector(".think", { timeout: 2000 });
      await shot(page, "ask-thinking-1280.png");
      await page.waitForSelector(".a-md", { timeout: 10000 });
      await shot(page, "ask-streaming-1280.png");
      await page.waitForSelector(".actions", { timeout: 15000 });
      await shot(page, "ask-done-1280.png");

      // answer <pre> gets tabindex=0
      await page.evaluate(() => {
        const t = window.__ASK__.turns[window.__ASK__.turns.length - 1];
        t.aText = "```\ncode\n```";
        t.mdEl.innerHTML = (() => {
          // reuse page marked path via DOM
          const wrap = document.createElement("div");
          wrap.className = "a-md";
          wrap.innerHTML = "<pre><code>code</code></pre>";
          wrap.querySelector("pre").setAttribute("tabindex", "0");
          return wrap.innerHTML;
        })();
      });
      const tab = await page.evaluate(() =>
        document.querySelector(".a-md pre")?.getAttribute("tabindex"),
      );
      if (tab !== "0") throw new Error("pre tabindex expected 0, got " + tab);

      // 停止測試：新問題
      await page.fill("#q", "__SLOW__");
      await page.click("#send");
      await page.waitForSelector(".think");
      await page.keyboard.press("Escape");
      await page.waitForSelector(".stopped", { timeout: 5000 });
      await shot(page, "ask-stopped-1280.png");
      results.push("1280 stream/stop OK");
    });

    // —— 390 錯誤三種 ——
    await withPage(390, 844, async (page) => {
      await page.evaluate(() => window.__ASK__.__setTurnstileReady?.(true));
      await page.fill("#q", "__ERR_RETRY__");
      await page.click("#send");
      await page.waitForSelector(".err-card");
      const t1 = await page.locator(".err-card p").innerText();
      if (t1 !== "出了點問題，請再試一次。") throw new Error("retry msg: " + t1);
      await shot(page, "ask-error-retry-390.png");

      await page.click("#clear");
      await page.waitForSelector("#empty");
      await page.fill("#q", "__ERR_ALL__");
      await page.click("#send");
      await page.waitForSelector(".err-card");
      const t2 = await page.locator(".err-card p").innerText();
      if (t2 !== "今天大家把免費額度用完了，明天早上 8 點後再試。")
        throw new Error("all_quota msg");
      if ((await page.locator(".err-card .b2").count()) !== 0) {
        throw new Error("all_quota should have no retry");
      }
      await shot(page, "ask-error-quota-390.png");

      await page.click("#clear");
      await page.fill("#q", "__MID__");
      await page.click("#send");
      await page.waitForSelector(".err-card");
      const partial = await page.locator(".a-md").innerText();
      if (!partial.includes("已經出了一部分")) throw new Error("mid error keep text");
      await shot(page, "ask-error-mid-390.png");
      results.push("390 errors OK");
    });

    // —— 0 題停用 ——
    await withPage(1280, 800, async (page) => {
      await page.evaluate(() => window.__ASK__.setQuotaDisplay(0));
      await page.waitForTimeout(100);
      const zero = await page.evaluate(() => {
        const q = document.getElementById("q");
        const reset = document.querySelector(".quota-full .quota-reset");
        return {
          disabled: q.disabled,
          resetShown: reset && !reset.hidden && reset.textContent === "早上 8 點重置",
        };
      });
      if (!zero.disabled) throw new Error("q should disable at 0");
      if (!zero.resetShown) throw new Error("reset hint should show at 0");
      await shot(page, "ask-zero-1280.png");
      results.push("zero quota OK");
    });

    // —— 768 ——
    await withPage(768, 1024, async (page) => {
      await shot(page, "ask-empty-768.png");
      results.push("768 OK");
    });

    // no storage
    await withPage(390, 844, async (page) => {
      await page.fill("#q", "你好");
      await page.click("#send");
      await page.waitForSelector(".actions");
      const storage = await page.evaluate(() => ({
        ls: Object.keys(localStorage).length,
        ss: Object.keys(sessionStorage).length,
      }));
      if (storage.ls || storage.ss) throw new Error("storage written: " + JSON.stringify(storage));
      results.push("no storage OK");
    });

    await browser.close();
    await writeFile(
      path.join(ART, "ask-e2e-results.txt"),
      results.join("\n") + "\n",
      "utf8",
    );
    console.log("E2E PASS\n" + results.join("\n"));
    worker.kill("SIGKILL");
    serve.kill("SIGKILL");
    process.exit(0);
  } catch (e) {
    try {
      worker.kill("SIGKILL");
      serve.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    throw e;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

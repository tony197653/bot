/**
 * Playwright：390／1280 截圖與 IME／互動檢查。
 * 前置：mock-worker :8787、靜態服務 :4173（本腳本會自己拉起）。
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASK_ROOT = path.resolve(__dirname, "..");
const ART = "/opt/cursor/artifacts/screenshots";
const PAGE = "http://127.0.0.1:4173/";
const WORKER = "http://127.0.0.1:8787";

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
        size: "invisible",
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

    const browser = await chromium.launch({ headless: true });
    const results = [];

    async function withPage(width, height, fn) {
      const page = await browser.newPage();
      await page.setViewportSize({ width, height });
      await installTurnstileFake(page);
      // Patch before load: make turnstile appear ready immediately and point worker
      await page.addInitScript(({ workerUrl }) => {
        Object.defineProperty(window, "__ASK_BOOT__", {
          value: { workerUrl, sitekey: "1x00000000000000000000AA" },
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
      await shot(page, "ask-empty-390.png");
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
      await shot(page, "ask-empty-1280.png");
      await page.fill("#q", "用條列說明");
      await page.click("#send");
      await page.waitForSelector(".think", { timeout: 2000 });
      await shot(page, "ask-thinking-1280.png");
      await page.waitForSelector(".a-md", { timeout: 10000 });
      await shot(page, "ask-streaming-1280.png");
      await page.waitForSelector(".actions", { timeout: 15000 });
      await shot(page, "ask-done-1280.png");
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
      const disabled = await page.evaluate(() => document.getElementById("q").disabled);
      if (!disabled) throw new Error("q should disable at 0");
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

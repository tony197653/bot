import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUIZ_ROOT = process.env.STAY_QUIZ_ROOT || join(__dirname, '../stay-quiz');
const {
  buildChoices,
  commentFor,
  createCountdown,
  isBenignPlayAbort,
  isPlayButtonDisabledWhileLoading,
  normalizeBest,
  potentialPoints,
  prepareRound,
  sampleDistractors,
  scoreFor,
  shouldAutoRetryAudio,
  shouldCountPlayFromStartAsReplay,
  shouldResumeCountdownAfterContinue,
  shouldResumeCountdownOnReplayEnded,
  shouldSuppressPlayingWhileHidden,
  shouldUpdateBest,
  shuffle,
  TimerState,
} = await import(pathToFileURL(join(QUIZ_ROOT, 'logic.js')).href);
const data = JSON.parse(readFileSync(join(QUIZ_ROOT, 'data/questions.json'), 'utf8'));

describe('計分 scoreFor', () => {
  it('聽 1 次答對＝10、2＝9、3＝8、5＝8', () => {
    assert.equal(scoreFor(1, true), 10);
    assert.equal(scoreFor(2, true), 9);
    assert.equal(scoreFor(3, true), 8);
    assert.equal(scoreFor(5, true), 8);
  });
  it('答錯／逾時／跳過（correct=false）＝0', () => {
    assert.equal(scoreFor(1, false), 0);
    assert.equal(scoreFor(3, false), 0);
  });
  it('10 題滿分 100', () => {
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += scoreFor(1, true);
    assert.equal(sum, 100);
  });
  it('potentialPoints 與答對分數一致', () => {
    assert.equal(potentialPoints(1), 10);
    assert.equal(potentialPoints(2), 9);
    assert.equal(potentialPoints(9), 8);
  });
});

describe('評語', () => {
  const EXPECTED = {
    0: '滾',
    10: '不送慢走',
    20: '你還好嗎？',
    30: '加油',
    40: '再練習五下就OK了',
    50: 'Hello，準Stay',
    60: 'Stay小隊長',
    70: '還得是你！優秀',
    80: 'Stay大隊長',
    90: 'You got an A.',
    100: '這就是真愛',
  };

  it('11 個整十分對應原文', () => {
    for (const [score, text] of Object.entries(EXPECTED)) {
      assert.equal(commentFor(Number(score)), text, `score ${score}`);
    }
  });

  it('非 10 倍數向下取整到最近 10', () => {
    assert.equal(commentFor(29), EXPECTED[20]);
    assert.equal(commentFor(41), EXPECTED[40]);
    assert.equal(commentFor(99), EXPECTED[90]);
    assert.equal(commentFor(7), EXPECTED[0]);
  });
});

describe('干擾抽樣', () => {
  it('每題 4 選項含 1 正解，干擾只來自 20 首池', () => {
    const titles = new Set(data.questions.map((q) => q.title));
    const pool = new Set(data.distractors);
    assert.equal(data.distractors.length, 20);
    for (const t of titles) assert.equal(pool.has(t), false);

    for (let round = 0; round < 1000; round++) {
      const items = prepareRound(data);
      assert.equal(items.length, 10);
      const ids = new Set(items.map((i) => i.question.id));
      assert.equal(ids.size, 10);
      let prev = [];
      for (const item of items) {
        assert.equal(item.choices.length, 4);
        assert.equal(new Set(item.choices).size, 4);
        assert.ok(item.choices.includes(item.question.title));
        for (const d of item.distractors) {
          assert.ok(pool.has(d), `干擾不在池：${d}`);
          assert.notEqual(d, item.question.title);
          assert.ok(!prev.includes(d), `干擾連續兩題：${d}`);
        }
        prev = item.distractors;
      }
    }
  });

  it('正解在 A–D 大致平均（1000 輪）', () => {
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 1000; i++) {
      const items = prepareRound(data);
      for (const item of items) {
        const idx = item.choices.indexOf(item.question.title);
        counts[idx] += 1;
      }
    }
    const total = 1000 * 10;
    for (const c of counts) {
      const ratio = c / total;
      assert.ok(ratio > 0.2 && ratio < 0.3, `分布異常 ${counts}`);
    }
  });

  it('排除清單生效', () => {
    const exclude = data.distractors.slice(0, 3);
    const got = sampleDistractors(data.distractors, 3, exclude, () => 0.5);
    for (const g of got) assert.ok(!exclude.includes(g));
  });
});

describe('最高分同分規則', () => {
  it('尚無紀錄 → 更新（含 0 分）', () => {
    assert.equal(shouldUpdateBest(0, null), true);
    assert.equal(shouldUpdateBest(50, null), true);
  });
  it('嚴格大於才更新；同分保留先達成者', () => {
    const best = { score: 80, player: '羽蕎', at: '2026-11-01' };
    assert.equal(shouldUpdateBest(81, best), true);
    assert.equal(shouldUpdateBest(80, best), false);
    assert.equal(shouldUpdateBest(79, best), false);
  });
  it('normalizeBest 拒絕壞資料', () => {
    assert.equal(normalizeBest(null, data.players), null);
    assert.equal(normalizeBest({ best: { score: 101, player: '羽蕎' } }, data.players), null);
    assert.equal(normalizeBest({ best: { score: 50, player: '路人' } }, data.players), null);
    assert.deepEqual(
      normalizeBest({ best: { score: 92, player: '容亘', at: '2026-11-01' } }, data.players),
      { score: 92, player: '容亘', at: '2026-11-01' },
    );
  });
});

describe('倒數暫停／恢復', () => {
  it('未開始不扣時間；start 後扣減', () => {
    let t = 1000;
    const c = createCountdown({ durationMs: 15000, now: () => t });
    assert.equal(c.state, TimerState.IDLE);
    assert.equal(c.remainingMs, 15000);
    c.start();
    t += 2000;
    assert.equal(c.state, TimerState.RUNNING);
    assert.equal(c.remainingMs, 13000);
  });

  it('重播暫停後不扣時間，resume 接著算', () => {
    let t = 0;
    const c = createCountdown({ durationMs: 15000, now: () => t });
    c.start();
    t += 5000; // 剩 10s
    assert.equal(c.remainingMs, 10000);
    c.pause('replay');
    t += 8000; // 暫停期間
    assert.equal(c.state, TimerState.PAUSED);
    assert.equal(c.remainingMs, 10000);
    c.resume();
    t += 3000;
    assert.equal(c.remainingMs, 7000);
  });

  it('背景暫停同樣凍結剩餘', () => {
    let t = 0;
    const c = createCountdown({ durationMs: 15000, now: () => t });
    c.start();
    t += 4000;
    c.pause('background');
    t += 10000;
    assert.equal(c.remainingMs, 11000);
    c.resume();
    t += 1000;
    assert.equal(c.remainingMs, 10000);
  });

  it('時間到 → ended；stop 也可結束', () => {
    let t = 0;
    const c = createCountdown({ durationMs: 1000, now: () => t });
    c.start();
    t += 1000;
    assert.equal(c.state, TimerState.ENDED);
    assert.equal(c.remainingMs, 0);

    const c2 = createCountdown({ durationMs: 5000, now: () => t });
    c2.start();
    c2.stop();
    assert.equal(c2.state, TimerState.ENDED);
  });

  it('displaySeconds 用 ceil；最後 5 秒 isUrgent', () => {
    let t = 0;
    const c = createCountdown({ durationMs: 15000, now: () => t });
    c.start();
    t += 10001; // 剩 4999
    assert.equal(c.displaySeconds(), 5);
    assert.equal(c.isUrgent, true);
  });

  it('重播中再暫停→續播：可再次 pause(replay)（定案 A）', () => {
    let t = 0;
    const c = createCountdown({ durationMs: 15000, now: () => t });
    c.start();
    t += 5000;
    c.pause('replay'); // 按重播
    t += 1000;
    c.resume(); // 使用者暫停重播 → 倒數恢復
    t += 500;
    assert.equal(c.state, TimerState.RUNNING);
    assert.equal(c.remainingMs, 9500);
    c.pause('replay'); // 續播同一段重播 → 再暫停
    t += 2000;
    assert.equal(c.state, TimerState.PAUSED);
    assert.equal(c.remainingMs, 9500);
  });
});

describe('QA #1 重播暫停＋背景＋繼續（倒數不可永久凍結）', () => {
  it('重播中暫停後切背景，繼續時即使 inReplaySegment 仍應 resume（音訊未在播）', () => {
    let t = 0;
    const c = createCountdown({ durationMs: 15000, now: () => t });
    c.start();
    t += 1200;
    c.pause('replay'); // 按重播
    t += 400;
    c.resume(); // 重播中按暫停 → 倒數恢復
    t += 300;
    assert.equal(c.state, TimerState.RUNNING);
    c.pause('background'); // 切背景
    const inReplaySegment = true;
    const audioPlaying = false;

    // 舊邏輯 bug：`bgPaused && !inReplaySegment` → false，倒數永遠卡住
    const buggyWouldResume = c.pauseReason === 'background' && !inReplaySegment;
    assert.equal(buggyWouldResume, false);

    assert.equal(
      shouldResumeCountdownAfterContinue({
        pauseReason: c.pauseReason,
        inReplaySegment,
        audioPlaying,
      }),
      true,
    );
    assert.ok(c.resume());
    t += 1000;
    assert.equal(c.state, TimerState.RUNNING);
    assert.equal(c.remainingMs, 15000 - 1200 - 300 - 1000);
  });

  it('背景回來時若重播音訊仍在播，倒數維持暫停', () => {
    assert.equal(
      shouldResumeCountdownAfterContinue({
        pauseReason: 'background',
        inReplaySegment: true,
        audioPlaying: true,
      }),
      false,
    );
  });

  it('重播 ended 時 background 暫停也要恢復（與 replay 同等）', () => {
    assert.equal(shouldResumeCountdownOnReplayEnded('replay'), true);
    assert.equal(shouldResumeCountdownOnReplayEnded('background'), true);
    assert.equal(shouldResumeCountdownOnReplayEnded(null), false);

    let t = 0;
    const c = createCountdown({ durationMs: 15000, now: () => t });
    c.start();
    t += 2000;
    c.pause('replay');
    // 重播中又被背景蓋成 background（可見性）
    // 模擬：先 resume 再 background — 實際 app 在 RUNNING 時才 background
    // 此處直接：重播暫停中不會再 background；但 ended 時若仍是 background（#1 變體）
    c.resume();
    t += 100;
    c.pause('background');
    assert.equal(shouldResumeCountdownOnReplayEnded(c.pauseReason), true);
    c.resume();
    assert.equal(c.state, TimerState.RUNNING);
  });
});

describe('QA #2 載入中播放鍵與重播誤計', () => {
  it('第一次發聲前播放鍵應停用', () => {
    assert.equal(
      isPlayButtonDisabledWhileLoading({
        firstSoundHeard: false,
        loadFailed: false,
        blockedAutoplay: false,
      }),
      true,
    );
    assert.equal(
      isPlayButtonDisabledWhileLoading({
        firstSoundHeard: true,
        loadFailed: false,
        blockedAutoplay: false,
      }),
      false,
    );
    // 自動播放被擋時要能按「點我播放」
    assert.equal(
      isPlayButtonDisabledWhileLoading({
        firstSoundHeard: false,
        loadFailed: false,
        blockedAutoplay: true,
      }),
      false,
    );
  });

  it('第一次發聲前從頭播放不算重播', () => {
    assert.equal(
      shouldCountPlayFromStartAsReplay({ firstSoundHeard: false, answered: false }),
      false,
    );
    assert.equal(
      shouldCountPlayFromStartAsReplay({ firstSoundHeard: true, answered: false }),
      true,
    );
  });

  it('AbortError 視為良性中斷，不走音檔失敗', () => {
    assert.equal(isBenignPlayAbort({ name: 'AbortError' }), true);
    assert.equal(isBenignPlayAbort({ name: 'NotAllowedError' }), false);
    assert.equal(isBenignPlayAbort({ name: 'NotSupportedError' }), false);
  });
});

describe('QA #3 載入中切背景不可偷播／偷跑倒數', () => {
  it('頁面隱藏時不做自動重試', () => {
    assert.equal(shouldAutoRetryAudio({ pageHidden: true }), false);
    assert.equal(shouldAutoRetryAudio({ pageHidden: false }), true);
  });

  it('隱藏或繼續遮罩期間、尚未發聲：playing 應被抑制', () => {
    assert.equal(
      shouldSuppressPlayingWhileHidden({
        pageHidden: true,
        resumeVisible: false,
        firstSoundHeard: false,
      }),
      true,
    );
    assert.equal(
      shouldSuppressPlayingWhileHidden({
        pageHidden: false,
        resumeVisible: true,
        firstSoundHeard: false,
      }),
      true,
    );
    assert.equal(
      shouldSuppressPlayingWhileHidden({
        pageHidden: false,
        resumeVisible: false,
        firstSoundHeard: false,
      }),
      false,
    );
    // 已發聲後的背景續播由「繼續」處理，不走抑制
    assert.equal(
      shouldSuppressPlayingWhileHidden({
        pageHidden: true,
        resumeVisible: true,
        firstSoundHeard: true,
      }),
      false,
    );
  });

  it('抑制期間倒數保持 idle', () => {
    const c = createCountdown({ durationMs: 15000, now: () => 0 });
    assert.equal(c.state, TimerState.IDLE);
    // 模擬：playing 被抑制 → 不呼叫 start
    if (
      !shouldSuppressPlayingWhileHidden({
        pageHidden: true,
        resumeVisible: true,
        firstSoundHeard: false,
      })
    ) {
      c.start();
    }
    assert.equal(c.state, TimerState.IDLE);
  });
});

describe('題庫資料', () => {
  it('Q6 為 God\'s Menu；玩家名正確；無簡體獻詞鍵', () => {
    assert.equal(data.questions[5].title, "God's Menu");
    assert.deepEqual(data.players, ['羽蕎', '容亘', 'Stay']);
    assert.equal(data.version, 2);
    assert.equal(data.seconds, 15);
    assert.deepEqual(data.points, [10, 9, 8]);
  });
  it('shuffle 可注入 RNG', () => {
    const a = shuffle([1, 2, 3, 4], () => 0);
    assert.equal(a.length, 4);
  });
  it('buildChoices 結構', () => {
    const q = data.questions[0];
    const { choices, distractors } = buildChoices(q, data.distractors, [], () => 0.1);
    assert.equal(choices.length, 4);
    assert.equal(distractors.length, 3);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChoices,
  commentFor,
  createCountdown,
  normalizeBest,
  potentialPoints,
  prepareRound,
  sampleDistractors,
  scoreFor,
  shouldUpdateBest,
  shuffle,
  TimerState,
} from '../logic.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(__dirname, '../data/questions.json'), 'utf8'));

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
  it('分數區間', () => {
    assert.match(commentFor(100), /滿分/);
    assert.match(commentFor(80), /超強/);
    assert.match(commentFor(50), /很棒/);
    assert.match(commentFor(49), /補 MV/);
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

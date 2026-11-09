import { it } from 'node:test';
import assert from 'node:assert/strict';
import { startPresence } from '../js/net/presence.js';

function setup({ host = true, roomWriteAt = 0 } = {}) {
  let time = 0;
  let tick;
  let interval;
  let cancelled = false;
  let fail = false;
  const beats = [];
  const listeners = new Map();
  const document = {
    visibilityState: 'visible',
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
  };
  const presence = startPresence({
    db: {},
    fs: {
      doc: () => ({}),
      serverTimestamp: () => time,
      setDoc: async (_ref, data) => {
        if (fail) throw new Error('transient');
        beats.push({ at: time, ...data });
      },
    },
  }, 'room', 'uid', {
    isHost: () => host,
    lastRoomWriteAt: () => roomWriteAt,
    now: () => time,
    document,
    setInterval: (fn, ms) => { tick = fn; interval = ms; return 1; },
    clearInterval: () => { cancelled = true; },
  });
  return {
    beats, presence, document,
    setHost: (value) => { host = value; },
    setFail: (value) => { fail = value; },
    async advance(ms) {
      await Promise.resolve();
      assert.equal(interval, 10_000);
      for (let end = time + ms; time < end;) {
        time += interval;
        if (!cancelled) tick();
        await Promise.resolve();
      }
    },
    async visibility(value) {
      document.visibilityState = value;
      listeners.get('visibilitychange')?.();
      await Promise.resolve();
    },
  };
}

it('idle host beats by 20s and never leaves a gap over 20s for 90s', async () => {
  const h = setup();
  await h.advance(90_000);
  const times = h.beats.map((b) => b.at);
  assert.ok(times[0] <= 20_000);
  assert.deepEqual(times, [10_000, 30_000, 50_000, 70_000, 90_000]);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] <= 20_000);
  h.presence.stop();
});

it('players retain the initial beat and 30s periodic beats', async () => {
  const h = setup({ host: false });
  await h.advance(90_000);
  assert.deepEqual(h.beats.map((b) => b.at), [0, 30_000, 60_000, 90_000]);
  h.presence.stop();
});

it('hidden pages send no periodic beats, preserving visibility notifications', async () => {
  const h = setup();
  await h.advance(10_000);
  await h.visibility('hidden');
  assert.equal(h.beats.at(-1).vis, false);
  const count = h.beats.length;
  await h.advance(90_000);
  assert.equal(h.beats.length, count);
  h.presence.stop();
});

it('uses the current host role on each tick', async () => {
  const h = setup({ host: false });
  await h.advance(10_000);
  h.setHost(true);
  await h.advance(40_000);
  assert.deepEqual(h.beats.map((b) => b.at), [0, 20_000, 40_000]);
  h.presence.stop();
});

it('explicit beats update the successful-beat clock and failures do not', async () => {
  const h = setup();
  await h.advance(10_000);
  await h.presence.beatNow();
  await h.advance(10_000);
  await h.presence.beatNow();
  h.setFail(true);
  await h.advance(20_000);
  h.setFail(false);
  await h.advance(10_000);
  assert.deepEqual(h.beats.map((b) => b.at), [10_000, 10_000, 20_000, 50_000]);
  h.presence.stop();
});

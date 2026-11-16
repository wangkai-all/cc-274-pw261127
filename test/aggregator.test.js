import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { Aggregator, windowsForEvent, canonicalScalar, displayScalar } from '../src/engine/aggregator.js';
import { normalizeSpec } from '../src/spec.js';

function aggregator(patch = {}, options = {}) {
  const { spec, parsed } = normalizeSpec({
    label: 'test',
    filter: 'ok',
    group: 'coalesce(device, "unknown")',
    dedup: 'event_id',
    measure: 'amount',
    aggregate: 'sum',
    window: { kind: 'tumbling', sizeMs: 10_000, allowedLatenessMs: 0, offsetMs: 0 },
    ...patch,
  });
  return new Aggregator({ spec, parsed, retainResults: true, ...options });
}

let counter = 0;
function ev(time, payload = {}, seq = null) {
  counter += 1;
  return {
    seq: seq ?? counter,
    eventId: payload.event_id ?? `e${counter}`,
    eventTime: time,
    payload: { device: 'ios', amount: 10, ok: true, ...payload },
  };
}

describe('window assignment', () => {
  test('tumbling windows align to size and offset', () => {
    const w = { kind: 'tumbling', sizeMs: 10_000, slideMs: 10_000, offsetMs: 0 };
    assert.deepEqual(windowsForEvent(0, w), [{ start: 0, end: 10_000 }]);
    assert.deepEqual(windowsForEvent(9_999, w), [{ start: 0, end: 10_000 }]);
    assert.deepEqual(windowsForEvent(10_000, w), [{ start: 10_000, end: 20_000 }]);
    const shifted = { ...w, offsetMs: 3_000 };
    assert.deepEqual(windowsForEvent(2_999, shifted), [{ start: -7_000, end: 3_000 }]);
    assert.deepEqual(windowsForEvent(3_000, shifted), [{ start: 3_000, end: 13_000 }]);
  });

  test('hopping windows emit each overlapping window, newest first', () => {
    const w = { kind: 'hopping', sizeMs: 10_000, slideMs: 5_000, offsetMs: 0 };
    assert.deepEqual(windowsForEvent(7_000, w), [
      { start: 5_000, end: 15_000 },
      { start: 0, end: 10_000 },
    ]);
    assert.equal(windowsForEvent(7_000, { ...w, sizeMs: 30_000, slideMs: 10_000 }).length, 3);
  });

  test('negative event times are normalised without float drift', () => {
    const w = { kind: 'tumbling', sizeMs: 10_000, slideMs: 10_000, offsetMs: 0 };
    assert.deepEqual(windowsForEvent(-1, w), [{ start: -10_000, end: 0 }]);
  });
});

describe('aggregation semantics', () => {
  test('closes a window only when the watermark passes it', () => {
    const a = aggregator();
    const first = a.process(ev(1_000, { amount: 100 }, 1));
    assert.equal(first.closed.length, 0, 'window still open');
    const second = a.process(ev(12_000, {}, 2));
    assert.equal(second.closed.length, 1);
    const [result] = second.closed;
    assert.equal(result.groupKey, 's:ios');
    assert.equal(result.windowStart, 0);
    assert.equal(result.windowEnd, 10_000);
    assert.equal(result.sum, 100);
    assert.equal(result.count, 1);
  });

  test('late events beyond allowed lateness are rejected, not silently merged', () => {
    const a = aggregator({ window: { kind: 'tumbling', sizeMs: 10_000, allowedLatenessMs: 0 } });
    a.process(ev(1_000, { amount: 100 }, 1));
    a.process(ev(25_000, {}, 2)); // watermark 25_000 → closes and forgets 0..10_000
    const late = a.process(ev(5_000, { amount: 999 }, 3));
    assert.equal(late.outcome, 'late');
    assert.equal(a.counters.late, 1);
  });

  test('allowed lateness keeps a window open past its end', () => {
    const a = aggregator({ window: { kind: 'tumbling', sizeMs: 10_000, allowedLatenessMs: 5_000 } });
    a.process(ev(1_000, { amount: 100 }, 1));
    const stillOpen = a.process(ev(12_000, { amount: 50 }, 2));
    assert.equal(stillOpen.closed.length, 0, 'watermark is 7_000, window still open');
    // Arrives out of order but inside the lateness allowance: it must still merge.
    const late = a.process(ev(9_500, { amount: 25 }, 3));
    assert.equal(late.outcome, 'accepted');
    const closes = a.process(ev(26_000, {}, 4));
    assert.equal(closes.closed.length, 2, 'both windows close once the watermark passes');
    const first = closes.closed.find((r) => r.windowStart === 0);
    assert.equal(first.sum, 125);
    assert.equal(first.count, 2);
  });

  test('dedup is per window, not global', () => {
    const a = aggregator();
    a.process(ev(1_000, { event_id: 'same', amount: 100 }, 1));
    const dup = a.process(ev(2_000, { event_id: 'same', amount: 100 }, 2));
    assert.equal(dup.outcome, 'duplicate');
    const nextWindow = a.process(ev(11_000, { event_id: 'same', amount: 100 }, 3));
    assert.equal(nextWindow.outcome, 'accepted', 'same id in a later window is a new event');
    assert.equal(a.counters.duplicate, 1);
  });

  test('filtered events still advance the watermark', () => {
    const a = aggregator();
    a.process(ev(1_000, { amount: 100 }, 1));
    const filtered = a.process(ev(30_000, { ok: false }, 2));
    assert.equal(filtered.outcome, 'filtered');
    assert.equal(filtered.closed.length, 1, 'watermark advanced despite the filter');
  });

  test('group key is null-safe and type-tagged', () => {
    assert.equal(displayScalar(canonicalScalar('1')), '1');
    assert.equal(displayScalar(canonicalScalar(1)), 1);
    assert.notEqual(canonicalScalar('1'), canonicalScalar(1));
    assert.notEqual(canonicalScalar(true), canonicalScalar('true'));
    const a = aggregator({ group: 'coalesce(region, "unknown")' });
    const result = a.process(ev(1_000, { region: null }, 1));
    assert.equal(result.outcome, 'accepted');
    assert.equal(displayScalar(result.groupKey), 'unknown');
  });

  test('count aggregate counts rows even when the measure is null', () => {
    const a = aggregator({ aggregate: 'count', measure: 'to_number(region)' });
    a.process(ev(1_000, { region: 'not-a-number' }, 1));
    a.process(ev(2_000, { region: '42' }, 2));
    a.process(ev(30_000, {}, 3));
    const [result] = a.closedResults;
    assert.equal(result.count, 2);
    assert.equal(a.displayValue(result), 2, 'count ignores null measures');
  });

  test('avg uses count of rows, not count of non-null measures', () => {
    const a = aggregator({ aggregate: 'avg', measure: 'to_number(region)' });
    a.process(ev(1_000, { region: 'nope' }, 1));
    a.process(ev(2_000, { region: '10' }, 2));
    a.process(ev(30_000, {}, 3));
    const [result] = a.closedResults;
    assert.equal(result.sum, 10);
    assert.equal(a.displayValue(result), 5, 'null measure contributes 0 to avg? no: sum/count');
  });
});

describe('determinism', () => {
  const events = [];
  for (let i = 0; i < 60; i += 1) {
    events.push(
      ev(i * 700, {
        device: i % 3 ? 'ios' : 'web',
        amount: (i * 37) % 500,
        ok: i % 5 !== 0,
        event_id: `d${i % 47}`,
      }, i + 1),
    );
  }

  test('same input produces identical results regardless of instance', () => {
    const a = aggregator();
    const b = aggregator();
    for (const e of events) a.process({ ...e });
    for (const e of events) b.process({ ...e });
    assert.deepEqual(a.closedResults, b.closedResults);
    assert.deepEqual(a.openWindows(), b.openWindows());
    assert.deepEqual(a.counters, b.counters);
  });

  test('snapshot/restore resumes with the same result', () => {
    const a = aggregator();
    for (const e of events.slice(0, 30)) a.process({ ...e });
    const snapshot = JSON.parse(JSON.stringify(a.snapshot()));
    const alreadyClosed = a.closedResults.length;
    const b = aggregator();
    b.restore(snapshot);
    for (const e of events.slice(30)) b.process({ ...e });
    for (const e of events.slice(30)) a.process({ ...e });
    // Results closed before the snapshot are already persisted; the resumed
    // instance must reproduce exactly the windows that close afterwards.
    assert.deepEqual(b.closedResults, a.closedResults.slice(alreadyClosed));
    assert.deepEqual(b.counters, a.counters);
    assert.equal(b.watermark, a.watermark);
  });

  test('contribution digest identifies the contributing set', () => {
    const a = aggregator();
    for (const e of events) a.process({ ...e });
    const first = a.closedResults.map((r) => r.contributionsDigest);
    assert.equal(new Set(first).size, first.length, 'digests are distinct per window');
  });
});

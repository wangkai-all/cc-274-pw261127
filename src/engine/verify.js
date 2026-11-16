/**
 * Full-baseline verification.
 *
 * Recomputes an epoch from retained raw events with a fresh aggregator and
 * compares every closed window against the persisted derived rows. Because the
 * baseline is derived only from raw_events, it is an independent check of both
 * live processing and migration/rebuild results.
 */

import { Aggregator } from './aggregator.js';
import { normalizeSpec } from '../spec.js';
import { displayScalar } from './aggregator.js';
import { audit, getEpoch, getMeta, getVersion } from './repository.js';
import { notFound } from '../errors.js';
import { parseJson } from '../db.js';

const EPSILON = 1e-9;

export class Verifier {
  constructor(engine) {
    this.engine = engine;
  }

  run({ epochId = null, sampleLimit = 20 } = {}) {
    const engine = this.engine;
    const epoch = epochId ? getEpoch(engine.db, epochId) : engine.active.epoch;
    if (!epoch) throw notFound('epoch 不存在');
    const version = getVersion(engine.db, epoch.versionId);
    if (!version) throw notFound('规则版本不存在');
    const normalized = normalizeSpec(version.spec);

    const baseline = new Aggregator({
      spec: normalized.spec,
      parsed: normalized.parsed,
      coverageStartSeq: epoch.coverageStartSeq,
      retainResults: true,
    });

    const rows = engine.db.all('SELECT * FROM raw_events ORDER BY seq ASC');
    const startedAt = engine.now();
    for (const row of rows) {
      baseline.process({
        seq: row.seq,
        eventId: row.event_id,
        eventTime: row.event_time,
        payload: parseJson(row.payload_json, {}),
      });
    }
    const closed = baseline.closeReadyWindows();
    const baselineMap = new Map();
    for (const result of baseline.closedResults) {
      baselineMap.set(keyOf(result), result);
    }

    const storedRows = engine.db.all('SELECT * FROM results WHERE epoch_id = ? ORDER BY window_start, group_key', epoch.id);
    const storedMap = new Map();
    for (const row of storedRows) {
      storedMap.set(`${row.group_key}\u0000${row.window_start}\u0000${row.window_end}`, row);
    }

    const mismatches = [];
    let matched = 0;
    const allKeys = new Set([...baselineMap.keys(), ...storedMap.keys()]);
    for (const key of allKeys) {
      const expected = baselineMap.get(key);
      const actual = storedMap.get(key);
      if (!expected || !actual) {
        mismatches.push({
          kind: expected ? 'missing-in-store' : 'extra-in-store',
          group: displayScalar((expected ?? actual).groupKey ?? (expected ?? actual).group_key),
          windowStart: expected?.windowStart ?? actual.window_start,
          windowEnd: expected?.windowEnd ?? actual.window_end,
          expected: expected ? describe(expected, normalized.spec.aggregate) : null,
          actual: actual ? describeStored(actual, normalized.spec.aggregate) : null,
        });
        continue;
      }
      const problems = compare(expected, actual);
      if (problems.length > 0) {
        mismatches.push({
          kind: 'value-mismatch',
          group: displayScalar(expected.groupKey),
          windowStart: expected.windowStart,
          windowEnd: expected.windowEnd,
          problems,
          expected: describe(expected, normalized.spec.aggregate),
          actual: describeStored(actual, normalized.spec.aggregate),
        });
      } else {
        matched += 1;
      }
    }

    const durationMs = engine.now() - startedAt;
    const ok = mismatches.length === 0;
    const openWindows = baseline.openWindows().map((row) => ({
      group: displayScalar(row.groupKey),
      windowStart: row.windowStart,
      windowEnd: row.windowEnd,
      count: row.count,
      value: baseline.displayValue(row),
    }));

    const report = {
      ok,
      epochId: epoch.id,
      versionId: version.id,
      versionLabel: version.label,
      strategy: epoch.strategy,
      aggregate: normalized.spec.aggregate,
      window: normalized.spec.window,
      rawEvents: rows.length,
      baselineWindows: baselineMap.size,
      storedWindows: storedMap.size,
      matched,
      mismatchCount: mismatches.length,
      mismatches: mismatches.slice(0, sampleLimit),
      openWindows: openWindows.slice(0, sampleLimit),
      openWindowCount: openWindows.length,
      baselineCounters: baseline.counters,
      watermark: baseline.watermark,
      durationMs,
      checkedAt: engine.now(),
      note:
        openWindows.length > 0
          ? `另有 ${openWindows.length} 个窗口尚未关闭（水位线以内），不参与逐行比对。`
          : '所有窗口均已关闭并逐行比对。',
    };

    engine.db.transaction(() => {
      const previous = Number(getMeta(engine.db, 'verify_count', 0));
      engine.db.run(
        'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        'verify_count',
        String(previous + 1),
      );
      engine.db.run(
        'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        'last_verify',
        JSON.stringify({
          at: report.checkedAt,
          ok,
          epochId: epoch.id,
          versionId: version.id,
          rawEvents: report.rawEvents,
          mismatches: report.mismatchCount,
          durationMs,
        }),
      );
      audit(
        engine.db,
        'verify',
        {
          epochId: epoch.id,
          versionId: version.id,
          ok,
          mismatchCount: report.mismatchCount,
          baselineWindows: baselineMap.size,
          durationMs,
        },
        report.checkedAt,
      );
    });

    return report;
  }
}

function keyOf(result) {
  return `${result.groupKey}\u0000${result.windowStart}\u0000${result.windowEnd}`;
}

function compare(expected, actual) {
  const problems = [];
  if (expected.count !== actual.count) problems.push(`count ${expected.count} ≠ ${actual.count}`);
  if (!closeEnough(expected.sum, actual.sum)) problems.push(`sum ${expected.sum} ≠ ${actual.sum}`);
  if (!closeEnough(expected.min, actual.min)) problems.push(`min ${expected.min} ≠ ${actual.min}`);
  if (!closeEnough(expected.max, actual.max)) problems.push(`max ${expected.max} ≠ ${actual.max}`);
  if (expected.contributionsDigest !== actual.contributions_digest) {
    problems.push('贡献事件集合不一致');
  }
  return problems;
}

function closeEnough(a, b) {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
}

function aggregateOf(aggregate, values) {
  switch (aggregate) {
    case 'count':
      return values.count;
    case 'avg':
      return values.count === 0 ? null : values.sum / values.count;
    case 'min':
      return values.min;
    case 'max':
      return values.max;
    default:
      return values.sum;
  }
}

function describe(result, aggregate) {
  return {
    count: result.count,
    sum: result.sum,
    min: result.min,
    max: result.max,
    value: aggregateOf(aggregate, result),
    contributionsDigest: result.contributionsDigest,
  };
}

function describeStored(row, aggregate) {
  const values = { count: row.count, sum: row.sum, min: row.min, max: row.max };
  return {
    count: row.count,
    sum: row.sum,
    min: row.min,
    max: row.max,
    value: aggregateOf(aggregate, values),
    contributionsDigest: row.contributions_digest,
  };
}

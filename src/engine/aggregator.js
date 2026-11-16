/**
 * Deterministic streaming aggregator.
 *
 * The same class powers the live path, shadow rebuilds, previews, and the
 * full-baseline verifier. Determinism comes from processing raw events in
 * append (seq) order with a watermark derived only from event time, never wall
 * time. Given the same event sequence and spec, every instance produces
 * identical group/window results.
 *
 * State kept per open window is enough to answer every supported aggregate:
 * count, sum, min, max. The list of contributing seqs produces a digest that
 * makes verification independent of value rounding.
 */

import { createHash } from 'node:crypto';
import { evaluate } from '../expr/evaluator.js';

export const NO_WATERMARK = null;
const SAMPLE_LIMIT = 24;

function isNull(value) {
  return value === null || value === undefined;
}

/** Canonical group/dedup key; type-tagged so 1, "1", and true cannot collide. */
export function canonicalScalar(value) {
  if (typeof value === 'string') return `s:${value}`;
  if (typeof value === 'number') return `n:${value}`;
  if (typeof value === 'boolean') return `b:${value ? '1' : '0'}`;
  return null;
}

export function displayScalar(key) {
  if (key === null || key === undefined) return null;
  const tag = key.slice(0, 2);
  const body = key.slice(2);
  if (tag === 'n:') return Number(body);
  if (tag === 'b:') return body === '1';
  return body;
}

export function windowKey(groupKey, start, end) {
  return `${groupKey}\u0000${start}\u0000${end}`;
}

export function resultKey(result) {
  return windowKey(result.groupKey, result.windowStart, result.windowEnd);
}

/**
 * Window bounds containing an event time.
 * offset shifts all boundaries; hopping windows repeat every slideMs.
 */
export function windowsForEvent(eventTime, window) {
  const { kind, sizeMs, slideMs, offsetMs } = window;
  const slide = kind === 'tumbling' ? sizeMs : slideMs;
  const shifted = eventTime - offsetMs;
  const rem = ((shifted % slide) + slide) % slide;
  const latestStart = shifted - rem + offsetMs;
  const count = kind === 'tumbling' ? 1 : sizeMs / slide;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const start = latestStart - i * slide;
    out.push({ start, end: start + sizeMs });
  }
  return out;
}

export function digestContributions(contributions) {
  const hash = createHash('sha256');
  hash.update(contributions.join(','));
  return hash.digest('hex').slice(0, 32);
}

export class Aggregator {
  /**
   * @param {object} options
   * @param {object} options.spec                   normalized spec
   * @param {object} options.parsed                 ASTs for filter/group/dedup/measure
   * @param {number} [options.coverageStartSeq=1]   first seq this instance covers
   * @param {boolean} [options.retainResults=false] keep all closed results in memory
   */
  constructor({ spec, parsed, coverageStartSeq = 1, retainResults = false }) {
    this.spec = spec;
    this.parsed = parsed;
    this.coverageStartSeq = coverageStartSeq;
    this.retainResults = retainResults;
    this.window = spec.window;
    this.aggregate = spec.aggregate;
    this.state = new Map();
    /** null === -Infinity, kept JSON-safe for snapshots. */
    this.watermark = NO_WATERMARK;
    this.lastSeq = coverageStartSeq - 1;
    this.closedResults = [];
    this.counters = {
      observed: 0,
      accepted: 0,
      filtered: 0,
      duplicate: 0,
      late: 0,
      invalidGroup: 0,
      invalidDedup: 0,
      acceptedWindows: 0,
    };
  }

  get effectiveWatermark() {
    return this.watermark === NO_WATERMARK ? Number.NEGATIVE_INFINITY : this.watermark;
  }

  /** Clone live state for a zero-replay migration (aggregate-only changes). */
  adoptState(source) {
    this.state = new Map(
      [...source.state.entries()].map(([key, record]) => [
        key,
        { ...record, dedup: new Set(record.dedup), contributions: [...record.contributions] },
      ]),
    );
    this.watermark = source.watermark;
    this.lastSeq = source.lastSeq;
    this.counters = { ...source.counters };
    this.coverageStartSeq = source.coverageStartSeq;
  }

  /** Serialize to a JSON-safe snapshot. */
  snapshot() {
    return {
      watermark: this.watermark,
      lastSeq: this.lastSeq,
      coverageStartSeq: this.coverageStartSeq,
      counters: { ...this.counters },
      windows: [...this.state.values()].map((record) => ({
        groupKey: record.groupKey,
        start: record.start,
        end: record.end,
        count: record.count,
        sum: record.sum,
        min: record.min,
        max: record.max,
        dedup: [...record.dedup],
        contributions: [...record.contributions],
      })),
    };
  }

  /** Restore a snapshot produced by snapshot(). */
  restore(snapshot) {
    this.watermark = snapshot.watermark ?? NO_WATERMARK;
    this.lastSeq = snapshot.lastSeq;
    this.coverageStartSeq = snapshot.coverageStartSeq ?? this.coverageStartSeq;
    this.counters = { ...snapshot.counters };
    this.state = new Map();
    for (const record of snapshot.windows) {
      this.state.set(windowKey(record.groupKey, record.start, record.end), {
        groupKey: record.groupKey,
        start: record.start,
        end: record.end,
        count: record.count,
        sum: record.sum,
        min: record.min,
        max: record.max,
        dedup: new Set(record.dedup),
        contributions: [...record.contributions],
      });
    }
  }

  /**
   * Process one raw event. Results closed by the watermark are returned on
   * every path, including filtered/duplicate/late outcomes.
   */
  process(event) {
    if (event.seq <= this.lastSeq) {
      throw new Error(`事件顺序错误：seq ${event.seq} 不大于已处理游标 ${this.lastSeq}`);
    }
    this.lastSeq = event.seq;
    this.counters.observed += 1;

    // The watermark is a property of the source and advances for every event,
    // before filtering. Close windows first so the event never closes the
    // window it is about to land in: its latest window end is always strictly
    // greater than eventTime - allowedLateness.
    const candidateWatermark = event.eventTime - this.window.allowedLatenessMs;
    if (this.watermark === NO_WATERMARK || candidateWatermark > this.watermark) {
      this.watermark = candidateWatermark;
    }
    const closed = this.closeReadyWindows();

    const row = { ...event.payload, event_id: event.eventId, event_time: event.eventTime };
    const base = {
      seq: event.seq,
      eventId: event.eventId,
      eventTime: event.eventTime,
      closed,
      watermark: this.watermark,
    };

    const filterValue = this.parsed.filter ? evaluate(this.parsed.filter, row) : true;
    if (filterValue !== true) {
      this.counters.filtered += 1;
      return {
        ...base,
        outcome: 'filtered',
        reason: filterValue === null ? '过滤条件求值为空，按不通过处理' : '不满足过滤条件',
        groupKey: null,
        windows: [],
      };
    }

    const groupKey = canonicalScalar(evaluate(this.parsed.group, row));
    if (groupKey === null) {
      this.counters.invalidGroup += 1;
      return {
        ...base,
        outcome: 'invalid-group',
        reason: '分组键求值为空，事件被跳过',
        groupKey: null,
        windows: [],
      };
    }

    let dedupKey = null;
    if (this.parsed.dedup) {
      dedupKey = canonicalScalar(evaluate(this.parsed.dedup, row));
      if (dedupKey === null) {
        this.counters.invalidDedup += 1;
        return {
          ...base,
          outcome: 'invalid-dedup',
          reason: '去重键求值为空，事件被跳过',
          groupKey,
          windows: [],
        };
      }
    }

    const measureValue = this.parsed.measure ? evaluate(this.parsed.measure, row) : null;
    const numericMeasure = isNull(measureValue) ? null : measureValue;

    const candidates = windowsForEvent(event.eventTime, this.window);
    const acceptedWindows = [];
    let lateCount = 0;
    let dedupCount = 0;

    for (const bounds of candidates) {
      if (bounds.end <= this.effectiveWatermark) {
        lateCount += 1;
        continue;
      }
      const key = windowKey(groupKey, bounds.start, bounds.end);
      let record = this.state.get(key);
      if (!record) {
        record = {
          groupKey,
          start: bounds.start,
          end: bounds.end,
          count: 0,
          sum: 0,
          min: null,
          max: null,
          dedup: new Set(),
          contributions: [],
        };
        this.state.set(key, record);
      }
      if (dedupKey !== null && record.dedup.has(dedupKey)) {
        dedupCount += 1;
        continue;
      }
      if (dedupKey !== null) record.dedup.add(dedupKey);
      record.count += 1;
      if (numericMeasure !== null) {
        record.sum += numericMeasure;
        record.min = record.min === null ? numericMeasure : Math.min(record.min, numericMeasure);
        record.max = record.max === null ? numericMeasure : Math.max(record.max, numericMeasure);
      }
      record.contributions.push(event.seq);
      acceptedWindows.push({ start: bounds.start, end: bounds.end });
    }

    if (acceptedWindows.length === 0) {
      if (dedupCount > 0) {
        this.counters.duplicate += 1;
        return {
          ...base,
          outcome: 'duplicate',
          reason: '去重键在该窗口已出现过',
          groupKey,
          windows: candidates,
        };
      }
      this.counters.late += 1;
      return {
        ...base,
        outcome: 'late',
        reason: '窗口已关闭，事件超过允许迟到',
        groupKey,
        windows: candidates,
      };
    }

    this.counters.accepted += 1;
    this.counters.acceptedWindows += acceptedWindows.length;
    return {
      ...base,
      outcome: 'accepted',
      reason:
        lateCount > 0 && dedupCount > 0
          ? `部分窗口未计入（重复 ${dedupCount}，迟到 ${lateCount}）`
          : lateCount > 0
            ? `部分窗口已关闭（迟到 ${lateCount}）`
            : dedupCount > 0
              ? `部分窗口重复（重复 ${dedupCount}）`
              : null,
      groupKey,
      windows: acceptedWindows,
    };
  }

  closeReadyWindows() {
    const closed = [];
    for (const [key, record] of this.state) {
      if (record.end <= this.effectiveWatermark) {
        this.state.delete(key);
        const result = this.toResult(record);
        if (this.retainResults) this.closedResults.push(result);
        closed.push(result);
      }
    }
    return closed;
  }

  /**
   * Finalize every open window. Used only by previews and test baselines so
   * their output is comparable to an idle system; the live path never calls it,
   * because a window is final only once the watermark passes it.
   */
  flushAll() {
    const closed = [];
    for (const [key, record] of this.state) {
      this.state.delete(key);
      const result = this.toResult(record);
      if (this.retainResults) this.closedResults.push(result);
      closed.push(result);
    }
    return closed;
  }

  toResult(record) {
    return {
      groupKey: record.groupKey,
      windowStart: record.start,
      windowEnd: record.end,
      count: record.count,
      sum: record.sum,
      min: record.min,
      max: record.max,
      contributionsCount: record.contributions.length,
      contributionsDigest: digestContributions(record.contributions),
      contributionsSample: record.contributions.slice(0, SAMPLE_LIMIT),
      firstSeq: record.contributions[0] ?? null,
      lastSeq: record.contributions[record.contributions.length - 1] ?? null,
    };
  }

  displayValue(result) {
    switch (this.aggregate) {
      case 'count':
        return result.count;
      case 'avg':
        return result.count === 0 ? null : result.sum / result.count;
      case 'min':
        return result.min;
      case 'max':
        return result.max;
      case 'sum':
      default:
        return result.sum;
    }
  }

  openWindows() {
    return [...this.state.values()].map((record) => ({
      ...this.toResult(record),
      display: this.displayValue(record),
    }));
  }

  resultMap() {
    const map = new Map();
    for (const result of this.closedResults) map.set(resultKey(result), result);
    return map;
  }
}

/** Convert a raw_events DB row into the aggregator's event shape. */
export function rowToEvent(row) {
  return {
    seq: row.seq,
    eventId: row.event_id,
    eventTime: row.event_time,
    payload: JSON.parse(row.payload_json),
  };
}

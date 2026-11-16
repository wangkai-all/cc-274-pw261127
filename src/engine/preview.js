/**
 * Preview engine.
 *
 * Runs the *unpublished* candidate spec over retained raw events and over the
 * live spec with identical inputs, so operators can see exactly which rows
 * would change before publishing. Preview never touches live state.
 */

import { Aggregator, rowToEvent, displayScalar } from './aggregator.js';

const PREVIEW_EVENT_LIMIT = 50_000;

export function computePreview(db, { candidate, baseline, limitEvents = PREVIEW_EVENT_LIMIT }) {
  const rows = db.all(
    `SELECT seq, event_id, event_time, payload_json FROM raw_events ORDER BY seq DESC LIMIT ?`,
    limitEvents,
  );
  rows.reverse();
  const events = rows.map(rowToEvent);

  const candidateAggregator = new Aggregator({
    spec: candidate.spec,
    parsed: candidate.parsed,
    coverageStartSeq: events[0]?.seq ?? 1,
    retainResults: true,
  });

  const baselineAggregator = baseline
    ? new Aggregator({
        spec: baseline.spec,
        parsed: baseline.parsed,
        coverageStartSeq: events[0]?.seq ?? 1,
        retainResults: true,
      })
    : null;

  const adjudicationDiffs = [];
  let adjudicationChangeCount = 0;
  for (const event of events) {
    const next = candidateAggregator.process(event);
    const prev = baselineAggregator ? baselineAggregator.process(event) : null;
    if (prev && prev.outcome !== next.outcome) {
      adjudicationChangeCount += 1;
      // Cap the sample, never the processing: stopping early would leave both
      // aggregators with partial state and make the window diff misleading.
      if (adjudicationDiffs.length < 200) {
        adjudicationDiffs.push({
          seq: event.seq,
          eventId: event.eventId,
          from: prev.outcome,
          to: next.outcome,
          reason: next.reason,
        });
      }
    }
  }

  const candidateOpen = candidateAggregator.openWindows();
  const candidateClosed = candidateAggregator.closedResults;
  const baselineClosed = baselineAggregator ? baselineAggregator.closedResults : [];

  const candidateMap = new Map();
  for (const result of [...candidateClosed, ...candidateOpen]) {
    candidateMap.set(`${result.groupKey}\u0000${result.windowStart}\u0000${result.windowEnd}`, result);
  }
  const baselineMap = new Map();
  for (const result of [...baselineClosed, ...(baselineAggregator ? baselineAggregator.openWindows() : [])]) {
    baselineMap.set(`${result.groupKey}\u0000${result.windowStart}\u0000${result.windowEnd}`, result);
  }

  const allKeys = new Set([...candidateMap.keys(), ...baselineMap.keys()]);
  const diffs = [];
  let added = 0;
  let removed = 0;
  let changed = 0;
  let unchanged = 0;

  for (const key of [...allKeys].sort()) {
    const next = candidateMap.get(key);
    const prev = baselineMap.get(key);
    const nextValue = next ? candidateAggregator.displayValue(next) : null;
    const prevValue = prev ? baselineAggregator.displayValue(prev) : null;
    if (!prev) {
      added += 1;
      if (diffs.length < 100) {
        diffs.push({
          kind: 'added',
          group: displayScalar(next.groupKey),
          windowStart: next.windowStart,
          windowEnd: next.windowEnd,
          value: nextValue,
          previous: null,
          count: next.count,
          previousCount: null,
        });
      }
      continue;
    }
    if (!next) {
      removed += 1;
      if (diffs.length < 100) {
        diffs.push({
          kind: 'removed',
          group: displayScalar(prev.groupKey),
          windowStart: prev.windowStart,
          windowEnd: prev.windowEnd,
          value: null,
          previous: prevValue,
          count: null,
          previousCount: prev.count,
        });
      }
      continue;
    }
    const valueChanged = !valuesEqual(nextValue, prevValue);
    const countChanged = next.count !== prev.count;
    if (valueChanged || countChanged) {
      changed += 1;
      if (diffs.length < 100) {
        diffs.push({
          kind: 'changed',
          group: displayScalar(next.groupKey),
          windowStart: next.windowStart,
          windowEnd: next.windowEnd,
          value: nextValue,
          previous: prevValue,
          count: next.count,
          previousCount: prev.count,
        });
      }
    } else {
      unchanged += 1;
    }
  }

  return {
    scope: {
      events: events.length,
      firstSeq: events[0]?.seq ?? null,
      lastSeq: events[events.length - 1]?.seq ?? null,
      truncated: rows.length === limitEvents,
    },
    totals: {
      candidateGroups: candidateMap.size,
      baselineGroups: baselineMap.size,
      added,
      removed,
      changed,
      unchanged,
      adjudicationChanges: adjudicationChangeCount,
    },
    diffs,
    adjudicationDiffs,
    candidateCounters: candidateAggregator.counters,
    baselineCounters: baselineAggregator ? baselineAggregator.counters : null,
    openWindowWarning:
      candidateAggregator.state.size > 0
        ? `预览结束时仍有 ${candidateAggregator.state.size} 个窗口未关闭，其数值可能与后续事件有关`
        : null,
  };
}

function valuesEqual(a, b) {
  if (a === null || b === null) return a === b;
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  }
  return a === b;
}

export { valuesEqual };

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEngine, event, push, seed, specWith } from './helpers.js';
import { classifyChange } from '../src/spec.js';
import { Engine } from '../src/engine/engine.js';
import { openDatabase } from '../src/db.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function conflictCode(error) {
  return error && typeof error === 'object' ? error.code : null;
}

function expectConflict(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(conflictCode(error), code, `expected ${code}, got ${conflictCode(error)}: ${error?.message}`);
    return true;
  });
}

function openVersion(engine, patch, opts = {}) {
  return engine.createVersion({ ...specWith(engine, patch), ...(opts.label ? { label: opts.label } : {}) });
}

describe('fenced ingest', () => {
  test('accepts events, closes windows through the watermark and stores adjudications', () => {
    const { engine, close } = makeEngine();
    try {
      const result = push(engine, [
        event({ eventTime: 1_000, payload: { amount: 100 } }),
        event({ eventTime: 2_000, payload: { amount: 50 } }),
        event({ eventTime: 20_000, payload: { amount: 25 } }),
      ]);
      assert.equal(result.outcome, 'ok');
      assert.equal(result.accepted, 3);
      assert.equal(result.closed, 1, 'the 0..15000 window closed when the watermark passed 15000');

      const pages = engine.results();
      assert.equal(pages.total, 1);
      assert.equal(pages.rows[0].group, 'ios');
      assert.equal(pages.rows[0].sum, 150);
      assert.equal(pages.rows[0].count, 2);

      const log = engine.adjudications();
      assert.equal(log.rows.length, 3);
      const outcomes = log.rows.map((row) => row.outcome);
      assert.ok(outcomes.includes('accepted'));

      const state = engine.stateView();
      assert.equal(state.counts.rawEvents, 3);
      assert.equal(state.counts.closedResults, 1);
      assert.equal(state.counts.adjudications, 3);
    } finally {
      close();
    }
  });

  test('duplicate batch keys are idempotent', () => {
    const { engine, close } = makeEngine();
    try {
      const runtime = engine.runtime();
      const batch = [event({ eventTime: 1_000 }), event({ eventTime: 2_000 })];
      const first = engine.ingest({ ...runtime, workerId: 'w1', batchKey: 'batch-1', events: batch });
      assert.equal(first.outcome, 'ok');
      assert.equal(first.seqs.length, 2);
      const second = engine.ingest({ ...runtime, workerId: 'w1', batchKey: 'batch-1', events: batch });
      assert.equal(second.outcome, 'duplicate-batch');
      assert.equal(engine.stateView().counts.rawEvents, 2);
    } finally {
      close();
    }
  });

  test('structurally invalid events are quarantined, never written to raw_events', () => {
    const { engine, close } = makeEngine();
    try {
      const runtime = engine.runtime();
      const result = engine.ingest({
        ...runtime,
        events: [
          { eventId: 'bad-1', eventTime: 0, payload: {} },
          { eventId: '', eventTime: 1_000, payload: {} },
          event({ eventTime: 1_000 }),
        ],
      });
      assert.equal(result.outcome, 'ok');
      assert.equal(result.quarantined, 2);
      assert.equal(engine.stateView().counts.rawEvents, 1);
      const quarantine = engine.quarantine();
      assert.equal(quarantine.total, 1);
      assert.equal(quarantine.rows[0].itemCount, 2);
    } finally {
      close();
    }
  });

  test('a retired executor is rejected and recorded instead of contaminating results', () => {
    const { engine, close } = makeEngine();
    try {
      seed(engine, 2, 10, 1_000);
      const oldRuntime = engine.runtime();
      const oldVersionId = oldRuntime.versionId;

      push(engine, event({ eventTime: 50_000 }));
      const before = engine.stateView().counts.rawEvents;

      // Publishing a regrouped rule uses a rebuild (which bumps the fence on
      // cutover for shadow), so exercise the fence check directly with a pause,
      // which also bumps it immediately.
      engine.pause('测试旧执行器');
      expectConflict(
        () => push(engine, event({ eventTime: 60_000, eventId: 'stale-1' }), { workerId: 'legacy', ...oldRuntime }),
        'paused',
      );
      assert.equal(engine.stateView().counts.rawEvents, before, 'stale batch wrote nothing');

      engine.resume();
      const newRuntime = engine.runtime();
      assert.notEqual(newRuntime.fence, oldRuntime.fence, 'resume bumped the fence');

      expectConflict(
        () => push(engine, event({ eventTime: 60_000, eventId: 'stale-2' }), { workerId: 'legacy', ...oldRuntime }),
        'stale-fence',
      );
      // Same epoch and fence but an old rule version must also be refused.
      expectConflict(
        () =>
          engine.ingest({
            workerId: 'legacy',
            epochId: newRuntime.epochId,
            versionId: oldVersionId === newRuntime.versionId ? -1 : oldVersionId,
            fence: newRuntime.fence,
            events: [event({ eventTime: 60_000, eventId: 'stale-3' })],
          }),
        'stale-version',
      );

      const stale = engine.staleReports();
      const reasons = stale.byReason.map((row) => row.reason);
      assert.ok(reasons.includes('stale-fence'), `got ${reasons}`);
      assert.ok(reasons.includes('stale-version'), `got ${reasons}`);
      assert.equal(engine.stateView().counts.rawEvents, before, 'no stale event ever reached raw_events');
    } finally {
      close();
    }
  });
});

describe('change classification', () => {
  test('label-only edits are noop, aggregate edits migrate, semantics rebuild', () => {
    const { engine, close } = makeEngine();
    try {
      const base = engine.active.version.spec;
      const labelOnly = classifyChange(base, { ...base, label: '新名字' });
      assert.equal(labelOnly.classification, 'noop');
      assert.deepEqual(labelOnly.changes.map((c) => c.field), ['label']);

      const aggregateOnly = classifyChange(base, { ...base, aggregate: 'count' });
      assert.equal(aggregateOnly.classification, 'migrate');
      assert.equal(aggregateOnly.changes[0].field, 'aggregate');

      for (const [field, value] of [
        ['filter', 'amount > 50'],
        ['group', 'coalesce(region, "unknown")'],
        ['dedup', 'coalesce(user_id, event_id)'],
        ['measure', 'amount * 2'],
      ]) {
        const change = classifyChange(base, { ...base, [field]: value });
        assert.equal(change.classification, 'rebuild', `${field} must require a rebuild`);
        assert.ok(change.reasons.length > 0);
      }

      for (const window of [
        { ...base.window, sizeMs: 30_000, slideMs: 30_000 },
        { ...base.window, allowedLatenessMs: 0 },
        { ...base.window, offsetMs: 1_000 },
        { ...base.window, kind: 'hopping', sizeMs: 30_000, slideMs: 15_000 },
      ]) {
        assert.equal(classifyChange(base, { ...base, window }).classification, 'rebuild');
      }

      // Equivalent spelling of the same expression is not a change.
      assert.equal(classifyChange(base, { ...base, group: '(coalesce(device, "unknown"))' }).classification, 'noop');
    } finally {
      close();
    }
  });
});

describe('state migration (aggregate change)', () => {
  test('publishes with zero replay, copies results, keeps the event log and verifies', () => {
    const { engine, close } = makeEngine();
    try {
      seed(engine, 3, 20, 1_000);
      const rawBefore = engine.stateView().counts.rawEvents;
      const resultsBefore = engine.stateView().counts.closedResults;
      assert.ok(resultsBefore > 0);
      const oldEpochId = engine.active.epoch.id;

      const { version } = openVersion(engine, { aggregate: 'avg' }, { label: '平均金额' });
      const published = engine.publishVersion(version.id, { strategy: 'shadow' });

      assert.equal(published.change.classification, 'migrate');
      assert.equal(published.activation.mode, 'state-adopt');
      assert.equal(published.activation.replayEvents, 0);
      assert.equal(published.cancelledJobs.length, 0);
      assert.equal(engine.rebuild.hasRunning(), false, 'migration never starts a replay job');

      assert.equal(engine.active.version.id, version.id);
      assert.notEqual(engine.active.epoch.id, oldEpochId);
      assert.equal(engine.stateView().counts.rawEvents, rawBefore);
      assert.equal(engine.stateView().counts.closedResults, resultsBefore, 'every closed window was copied');

      const stored = engine.results();
      assert.equal(stored.rows.length, resultsBefore);
      assert.equal(stored.aggregate, 'avg');
      for (const row of stored.rows) {
        assert.equal(row.value, row.count === 0 ? null : row.sum / row.count);
      }

      // The new epoch inherits the prior adjudications, marked as inherited.
      const inherited = engine.adjudications();
      assert.ok(inherited.rows.some((row) => row.inherited === true));
      assert.ok(inherited.rows.every((row) => row.versionId === version.id));

      // Ingestion continues on the new epoch with the new fence.
      const next = push(engine, event({ eventTime: 500_000, payload: { amount: 10 } }));
      assert.equal(next.outcome, 'ok');

      const report = engine.verify();
      assert.equal(report.ok, true, JSON.stringify(report.mismatches));
      assert.equal(report.mismatchCount, 0);
      assert.ok(report.matched > 0);
    } finally {
      close();
    }
  });

  test('label-only publish is also zero-replay and keeps the same fence-independent state', () => {
    const { engine, close } = makeEngine();
    try {
      seed(engine, 1, 10, 1_000);
      const resultsBefore = engine.stateView().counts.closedResults;
      const { version } = openVersion(engine, { label: '换个名字' });
      const published = engine.publishVersion(version.id);
      assert.equal(published.change.classification, 'noop');
      assert.equal(published.activation.replayEvents, 0);
      assert.equal(engine.active.version.label, '换个名字');
      assert.equal(engine.stateView().counts.closedResults, resultsBefore);
      assert.equal(engine.verify().ok, true);
    } finally {
      close();
    }
  });
});

describe('shadow rebuild', () => {
  test('rebuilds from raw events while the old epoch keeps ingesting, then cuts over atomically', async () => {
    const { engine, close } = makeEngine({ replayRate: 8_000, chunkSize: 5 });
    try {
      seed(engine, 4, 20, 1_000);
      const oldEpochId = engine.active.epoch.id;
      const rawBefore = engine.stateView().counts.rawEvents;

      const { version, change } = openVersion(engine, { group: 'coalesce(region, "unknown")' }, { label: '按地区' });
      assert.equal(change.classification, 'rebuild');
      const plan = engine.planFor(change, 'shadow');
      assert.ok(plan.replayEvents > 0);
      assert.ok(plan.estimatedFreezeMs >= 2);

      const published = engine.publishVersion(version.id, { strategy: 'shadow' });
      assert.equal(published.activation.mode, 'shadow');
      assert.equal(engine.active.epoch.id, oldEpochId, 'old epoch still live during rebuild');

      // The old executor keeps receiving events while the shadow build runs.
      await sleep(4);
      const live = engine.runtime();
      assert.equal(live.epochId, oldEpochId);
      const during = push(engine, event({ eventTime: 300_000, payload: { device: 'ios', region: 'West' } }));
      assert.equal(during.outcome, 'ok');

      // A shadow epoch's results are not served before cutover.
      expectConflict(() => engine.results({ epochId: published.activation.epochId }), 'results-not-ready');

      await engine.rebuild.settle();
      assert.equal(engine.rebuild.hasRunning(), false);

      const active = engine.active;
      assert.equal(active.version.id, version.id);
      assert.equal(active.epoch.id, published.activation.epochId);
      assert.equal(active.epoch.status, 'active');

      const job = engine.rebuild.viewJobs(10).find((row) => row.id === published.activation.jobId);
      assert.equal(job.status, 'done');
      assert.equal(job.lagEvents, 0);
      assert.equal(job.metrics.lagAtCutover, 0);

      const state = engine.stateView();
      assert.equal(state.counts.rawEvents, rawBefore + 1, 'the concurrent event was appended once');
      assert.equal(state.activeVersion.id, version.id);

      // Results are grouped by the new key.
      const results = engine.results({ limit: 200 });
      assert.equal(results.version.id, version.id);
      assert.ok(results.rows.length > 0);
      for (const row of results.rows) {
        assert.ok(['East', 'West', 'unknown'].includes(row.group), `unexpected group ${row.group}`);
      }

      const report = engine.verify();
      assert.equal(report.ok, true, JSON.stringify(report.mismatches));
      assert.equal(report.versionId, version.id);
      assert.ok(report.rawEvents >= rawBefore + 1);
    } finally {
      close();
    }
  });

  test('publishing a newer version mid-rebuild aborts the older build and only the newest goes live', async () => {
    const { engine, close } = makeEngine({ replayRate: 8_000, chunkSize: 5 });
    try {
      seed(engine, 3, 20, 1_000);
      const v2 = openVersion(engine, { group: 'coalesce(region, "unknown")' }, { label: 'v2 按地区' }).version;
      const first = engine.publishVersion(v2.id, { strategy: 'shadow' });

      // No await: the first build has not ticked yet.
      const v3 = engine.createVersion({ ...specWith(engine, { group: 'coalesce(plan, "none")' }), label: 'v3 按套餐' }).version;
      const second = engine.publishVersion(v3.id, { strategy: 'shadow' });

      assert.deepEqual(second.cancelledJobs, [first.activation.jobId]);

      await engine.rebuild.settle();

      assert.equal(engine.active.version.id, v3.id, 'v2 must never swap itself live');
      assert.equal(engine.active.epoch.id, second.activation.epochId);

      const jobs = engine.rebuild.viewJobs(10);
      const v2job = jobs.find((row) => row.id === first.activation.jobId);
      assert.equal(v2job.status, 'aborted');
      const v2epoch = engine.stateView().epochs.find((epoch) => epoch.id === first.activation.epochId);
      assert.equal(v2epoch.status, 'aborted');

      const v3epoch = engine.stateView().epochs.find((epoch) => epoch.id === second.activation.epochId);
      assert.equal(v3epoch.status, 'active');

      const report = engine.verify();
      assert.equal(report.ok, true, JSON.stringify(report.mismatches));
      assert.equal(report.versionId, v3.id);
    } finally {
      close();
    }
  });
});

describe('stop-the-world rebuild', () => {
  test('freezes ingestion, refuses resume, then cuts over and accepts the new fence', async () => {
    const { engine, close } = makeEngine({ replayRate: 10_000, chunkSize: 5 });
    try {
      seed(engine, 2, 20, 1_000);
      const oldEpochId = engine.active.epoch.id;
      const { version, change } = openVersion(engine, { filter: 'ok && amount > 20' }, { label: '阈值 20' });
      assert.equal(change.classification, 'rebuild');

      const plan = engine.planFor(change, 'stop-the-world');
      assert.ok(plan.estimatedFreezeMs >= 5);
      assert.equal(plan.strategy, 'stop-the-world');

      const published = engine.publishVersion(version.id, { strategy: 'stop-the-world' });
      assert.equal(published.activation.mode, 'stop-the-world');
      assert.equal(engine.runtime().paused, true);
      assert.equal(engine.stateView().pauseOwner, 'rebuild');

      expectConflict(() => push(engine, event({ eventTime: 300_000, eventId: 'during-freeze' })), 'paused');
      expectConflict(() => engine.resume(), 'paused-by-rebuild');
      assert.equal(engine.active.epoch.id, oldEpochId, 'old epoch stays active but paused');
      assert.equal(engine.stateView().counts.rawEvents, 40, 'frozen ingest wrote nothing');

      await engine.rebuild.settle();

      assert.equal(engine.runtime().paused, false);
      assert.equal(engine.stateView().pauseOwner, null);
      assert.equal(engine.active.version.id, version.id);
      assert.equal(engine.active.epoch.id, published.activation.epochId);

      const after = push(engine, event({ eventTime: 300_000, payload: { amount: 100 } }));
      assert.equal(after.outcome, 'ok', 'new fence is accepted');

      const report = engine.verify();
      assert.equal(report.ok, true, JSON.stringify(report.mismatches));
      assert.equal(report.rawEvents, 41);
    } finally {
      close();
    }
  });

  test('cancelling a frozen rebuild restores the old epoch and its fence', async () => {
    const { engine, close } = makeEngine({ replayRate: 8_000, chunkSize: 4 });
    try {
      seed(engine, 2, 20, 1_000);
      const oldEpochId = engine.active.epoch.id;
      const oldVersionId = engine.active.version.id;
      const { version } = openVersion(engine, { group: 'coalesce(region, "unknown")' }, { label: '地区' });

      const published = engine.publishVersion(version.id, { strategy: 'stop-the-world' });
      assert.equal(engine.runtime().paused, true);
      const cancelled = engine.cancelRebuild(published.activation.jobId);
      assert.equal(cancelled.cancelled, published.activation.jobId);

      assert.equal(engine.active.epoch.id, oldEpochId);
      assert.equal(engine.active.version.id, oldVersionId);
      assert.equal(engine.runtime().paused, false);
      assert.equal(engine.stateView().pauseOwner, null);
      assert.equal(engine.stateView().epochs.find((e) => e.id === published.activation.epochId).status, 'aborted');

      const resumed = push(engine, event({ eventTime: 300_000, eventId: 'after-cancel' }));
      assert.equal(resumed.outcome, 'ok');

      await sleep(20);
      assert.equal(engine.active.version.id, oldVersionId, 'the aborted build never activates');
    } finally {
      close();
    }
  });
});

describe('rollback and verification', () => {
  test('rollback derives a new version and rebuilds from the target version snapshot', async () => {
    const { engine, close } = makeEngine({ replayRate: 20_000, chunkSize: 10 });
    try {
      seed(engine, 3, 20, 1_000);
      const v1 = engine.active.version;
      const rawBefore = engine.stateView().counts.rawEvents;

      const v2 = openVersion(engine, { group: 'coalesce(region, "unknown")' }, { label: 'v2 按地区' }).version;
      engine.publishVersion(v2.id, { strategy: 'shadow' });
      await engine.rebuild.settle();
      assert.equal(engine.active.version.id, v2.id);

      // New events arrive under v2 before the rollback.
      push(engine, event({ eventTime: 400_000, payload: { region: 'West' } }));
      const rawAtRollback = engine.stateView().counts.rawEvents;

      const rolled = engine.rollback(v1.id, { strategy: 'shadow' });
      assert.equal(rolled.change.classification, 'rebuild', 'grouping changes back');
      assert.ok(rolled.fromSnapshot, 'rollback reused the target version snapshot');
      assert.notEqual(rolled.version.id, v1.id, 'rollback creates a new immutable version');
      assert.equal(rolled.version.sourceVersionId, v1.id);

      await engine.rebuild.settle();

      assert.equal(engine.active.version.id, rolled.version.id);
      assert.equal(engine.active.version.semanticHash, v1.semanticHash, 'same semantics as v1');

      const report = engine.verify();
      assert.equal(report.ok, true, JSON.stringify(report.mismatches));
      assert.ok(report.rawEvents >= rawAtRollback, 'all events, including v2-era ones, are covered');

      const versions = engine.listVersions();
      const original = versions.find((version) => version.id === v1.id);
      assert.equal(original.status, 'retired');
      assert.equal(versions.find((version) => version.id === v2.id).status, 'retired');
      assert.ok(rawBefore < report.rawEvents);
    } finally {
      close();
    }
  });

  test('the verifier detects tampered results instead of rubber-stamping them', () => {
    const { engine, db, close } = makeEngine();
    try {
      seed(engine, 2, 20, 1_000);
      assert.equal(engine.verify().ok, true);

      const row = db.get('SELECT id, sum FROM results ORDER BY id LIMIT 1');
      db.run('UPDATE results SET sum = ? WHERE id = ?', row.sum + 1, row.id);

      const report = engine.verify();
      assert.equal(report.ok, false);
      assert.ok(report.mismatchCount >= 1);
      assert.equal(report.mismatches[0].kind, 'value-mismatch');
      assert.ok(report.mismatches[0].problems.some((problem) => problem.includes('sum')));
    } finally {
      close();
    }
  });

  test('the verifier flags missing stored windows', () => {
    const { engine, db, close } = makeEngine();
    try {
      seed(engine, 2, 20, 1_000);
      db.run('DELETE FROM results WHERE id = (SELECT MIN(id) FROM results)');
      const report = engine.verify();
      assert.equal(report.ok, false);
      assert.ok(report.mismatches.some((item) => item.kind === 'missing-in-store'));
    } finally {
      close();
    }
  });

  test('preview reports the impact of a candidate rule without publishing it', () => {
    const { engine, close } = makeEngine();
    try {
      seed(engine, 2, 20, 1_000);
      const activeId = engine.active.version.id;
      const draft = engine.createVersion({
        ...specWith(engine, { filter: 'ok && amount > 60' }),
        label: '高额事件',
      }).version;
      const preview = engine.previewVersion(draft.id);
      assert.equal(preview.change.classification, 'rebuild');
      assert.equal(preview.scope.events, 40, 'preview covered every retained event');
      assert.ok(preview.totals.candidateGroups < preview.totals.baselineGroups, 'a stricter filter drops groups');
      assert.ok(preview.totals.changed > 0 || preview.totals.removed > 0);
      assert.ok(
        preview.candidateCounters.filtered > preview.baselineCounters.filtered,
        'more events are filtered under the stricter rule',
      );
      assert.ok(Array.isArray(preview.diffs));
      assert.ok(preview.plan.replayEvents > 0);
      assert.equal(engine.active.version.id, activeId, 'preview is read-only');
      assert.equal(engine.runtime().versionId, activeId);
    } finally {
      close();
    }
  });
});

describe('queries keep epochs separate', () => {
  test('archived epoch results stay queryable and live epoch results reflect ingestion', () => {
    const { engine, close } = makeEngine();
    try {
      seed(engine, 2, 20, 1_000);
      const oldEpochId = engine.active.epoch.id;
      const { version } = openVersion(engine, { aggregate: 'count' });
      engine.publishVersion(version.id);
      const newEpochId = engine.active.epoch.id;

      const archived = engine.results({ epochId: oldEpochId });
      assert.equal(archived.availability, 'archived');
      assert.equal(archived.openCount, 0, 'old epoch no longer serves open windows');
      assert.ok(archived.rows.every((row) => row.versionId !== version.id));

      const live = engine.results();
      assert.equal(live.availability, 'live');
      assert.equal(live.epoch.id, newEpochId);
      assert.ok(live.openCount > 0, 'live epoch exposes its open windows');
      assert.equal(live.aggregate, 'count');

      const adjudications = engine.adjudications({ epochId: oldEpochId });
      assert.ok(adjudications.rows.length > 0);
      assert.ok(adjudications.rows.every((row) => row.epochId === oldEpochId));
      assert.ok(engine.adjudications().rows.every((row) => row.epochId === newEpochId));
    } finally {
      close();
    }
  });
});

describe('durability and restart', () => {
  test('a fresh process restores the snapshot, replays the tail and keeps answering', () => {
    const dir = mkdtempSync(join(tmpdir(), 'driftfield-'));
    const path = join(dir, 'state.db');
    try {
      const first = openDatabase(path);
      const engine = new Engine({ db: first, replayRate: 200_000 });
      engine.boot();
      seed(engine, 2, 20, 1_000);
      const before = engine.stateView();
      const runtime = engine.runtime();
      // The snapshot is written in the ingest transaction, so a second
      // connection sees a consistent derived state.
      const snapshotSeq = first.get('SELECT seq FROM epoch_snapshots WHERE epoch_id = ?', runtime.epochId).seq;
      first.close();

      const second = openDatabase(path);
      const revived = new Engine({ db: second, replayRate: 200_000 });
      revived.boot();
      assert.equal(revived.runtime().epochId, runtime.epochId);
      assert.equal(revived.runtime().versionId, runtime.versionId);
      assert.equal(revived.active.aggregator.lastSeq, snapshotSeq);
      assert.equal(revived.stateView().counts.rawEvents, before.counts.rawEvents);
      assert.equal(revived.stateView().counts.closedResults, before.counts.closedResults);

      // Continued ingestion on the new process reproduces the same answer the
      // uninterrupted path would have produced.
      const next = push(revived, event({ eventTime: 300_000, payload: { amount: 42 } }));
      assert.equal(next.outcome, 'ok');
      const report = revived.verify();
      assert.equal(report.ok, true, JSON.stringify(report.mismatches));
      second.close();

      // A third boot is idempotent: tail replay must not duplicate results.
      const third = openDatabase(path);
      const again = new Engine({ db: third, replayRate: 200_000 });
      again.boot();
      assert.equal(again.stateView().counts.closedResults, report.storedWindows);
      assert.equal(again.verify().ok, true);
      third.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('restart marks in-flight rebuild jobs failed and keeps the old epoch serving', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'driftfield-'));
    const path = join(dir, 'state.db');
    try {
      const first = openDatabase(path);
      const engine = new Engine({ db: first, replayRate: 400_000, chunkSize: 2 });
      engine.boot();
      seed(engine, 2, 20, 1_000);
      const { version } = openVersion(engine, { group: 'coalesce(region, "unknown")' });
      const published = engine.publishVersion(version.id, { strategy: 'shadow' });
      const oldEpochId = engine.active.epoch.id;
      // Crash simulation: stop the in-process timers without letting the
      // rebuild finish, leaving the job row 'running' in the database.
      for (const timer of engine.rebuild.timers) clearTimeout(timer);
      engine.rebuild.timers.clear();
      engine.rebuild.sessions.clear();
      first.close();

      const second = openDatabase(path);
      const revived = new Engine({ db: second, replayRate: 200_000 });
      revived.boot();
      assert.equal(revived.active.epoch.id, oldEpochId, 'old epoch remains the live one');
      const job = revived.rebuild.viewJobs(10).find((row) => row.id === published.activation.jobId);
      assert.equal(job.status, 'failed');
      assert.match(job.error, /进程重启/);
      const epoch = revived.stateView().epochs.find((row) => row.id === published.activation.epochId);
      assert.equal(epoch.status, 'failed');
      assert.equal(revived.verify().ok, true);

      const next = push(revived, event({ eventTime: 300_000, eventId: 'after-restart' }));
      assert.equal(next.outcome, 'ok', 'the revived epoch accepts events again');
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

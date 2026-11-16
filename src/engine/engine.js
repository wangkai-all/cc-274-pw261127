/**
 * Engine: rule versions, active epochs, fenced ingestion, pause/resume,
 * rollback, lineage, read models and verification entry points.
 *
 * Invariants:
 *  1. raw_events is append-only and is the only source of new derived results.
 *  2. Derived rows and per-event adjudications are epoch-scoped. Only the
 *     active epoch is served as live.
 *  3. Every ingest is checked against the active epoch and the current fence.
 *     A retired executor's report is recorded and rejected, never aggregated.
 *  4. Publishing a newer version cancels in-flight rebuilds and advances a
 *     build token; an older build can never swap itself live.
 *  5. Cutover runs synchronously in the Node event loop; no ingest can
 *     interleave between the final catch-up and the pointer swap.
 */

import { Aggregator } from './aggregator.js';
import { DEFAULT_SPEC, classifyChange, normalizeSpec, summarizeSpec } from '../spec.js';
import { FIELD_INFO } from '../expr/functions.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { LIMITS, json, parseJson } from '../db.js';
import {
  EPOCH_STATUS,
  VERSION_STATUS,
  activeEpoch,
  audit,
  copyAdjudications,
  copyResults,
  countResults,
  getEpoch,
  getMeta,
  getSnapshot,
  getVersion,
  insertAdjudications,
  insertResults,
  latestSnapshotForVersion,
  listEpochs,
  listResults,
  listVersions,
  recordQuarantine,
  recordStaleReport,
  saveSnapshot,
  setMeta,
} from './repository.js';
import { RebuildRunner, PAUSE_OWNER } from './rebuild.js';
import { Verifier } from './verify.js';
import { computePreview } from './preview.js';
import { displayScalar } from './aggregator.js';

export const META_KEYS = Object.freeze({
  ACTIVE_EPOCH: 'active_epoch_id',
  ACTIVE_VERSION: 'active_version_id',
  FENCE: 'fence_generation',
  BUILD_GENERATION: 'build_generation',
  PAUSED_REASON: 'pause_reason',
  BOOTED_AT: 'booted_at',
  VERIFY_COUNT: 'verify_count',
  LAST_VERIFY: 'last_verify',
});

const STRATEGIES = Object.freeze(['stop-the-world', 'shadow']);
const VERIFY_SAMPLE = 20;

export class Engine {
  constructor({ db, now = () => Date.now(), chunkSize = 500, replayRate = 20_000 } = {}) {
    this.db = db;
    this.now = now;
    this.chunkSize = chunkSize;
    this.replayRate = replayRate;
    this.active = null;
    this.booted = false;
    this.rebuild = new RebuildRunner(this);
    this.verifier = new Verifier(this);
    this.listeners = new Set();
    this.staleThrottle = new Map();
    this.suppressedStale = 0;
  }

  // ------------------------------------------------------------- lifecycle

  boot() {
    let epoch = activeEpoch(this.db);
    if (!epoch) {
      this.bootstrap();
      epoch = activeEpoch(this.db);
    }
    this.loadActive(epoch);
    if (!getMeta(this.db, META_KEYS.BOOTED_AT)) setMeta(this.db, META_KEYS.BOOTED_AT, this.now());
    this.booted = true;
    this.rebuild.failOrphanedJobs('进程重启，重建任务中断');
    return this;
  }

  bootstrap() {
    const at = this.now();
    const normalized = normalizeSpec(DEFAULT_SPEC);
    const versionId = this.db.run(
      `INSERT INTO rule_versions(label, spec_json, semantic_hash, status, note, created_at, published_at, activated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      normalized.spec.label,
      json(normalized.spec),
      normalized.semanticHash,
      VERSION_STATUS.ACTIVE,
      '初始规则',
      at,
      at,
      at,
    ).lastInsertRowid;
    const epochId = this.db.run(
      `INSERT INTO epochs(version_id, status, strategy, coverage_start_seq, checkpoint_seq, watermark, created_at, activated_at, note)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      versionId,
      EPOCH_STATUS.ACTIVE,
      'bootstrap',
      1,
      0,
      null,
      at,
      at,
      '初始执行器',
    ).lastInsertRowid;
    setMeta(this.db, META_KEYS.ACTIVE_EPOCH, epochId);
    setMeta(this.db, META_KEYS.ACTIVE_VERSION, versionId);
    setMeta(this.db, META_KEYS.FENCE, 1);
    saveSnapshot(this.db, epochId, 0, this.emptySnapshot(), at);
    audit(this.db, 'bootstrap', { versionId, epochId }, at);
  }

  emptySnapshot() {
    return { watermark: null, lastSeq: 0, coverageStartSeq: 1, counters: emptyCounters(), windows: [] };
  }

  loadActive(epochRow) {
    if (!epochRow) throw new Error('活动 epoch 缺失');
    const versionId = epochRow.versionId ?? epochRow.version_id;
    const version = getVersion(this.db, versionId);
    if (!version) throw new Error(`规则版本 ${versionId} 缺失`);
    const normalized = normalizeSpec(version.spec);
    const aggregator = new Aggregator({
      spec: normalized.spec,
      parsed: normalized.parsed,
      coverageStartSeq: epochRow.coverageStartSeq,
    });
    const snapshot = getSnapshot(this.db, epochRow.id);
    let restoredSeq = 0;
    if (snapshot?.snapshot) {
      aggregator.restore(snapshot.snapshot);
      restoredSeq = snapshot.seq;
    }
    // Replay events committed after the last persisted snapshot. Results were
    // written in the same transaction as that snapshot, so no duplicates.
    const tail = this.db.all('SELECT * FROM raw_events WHERE seq > ? ORDER BY seq ASC', restoredSeq);
    for (const row of tail) {
      const outcome = aggregator.process({
        seq: row.seq,
        eventId: row.event_id,
        eventTime: row.event_time,
        payload: parseJson(row.payload_json, {}),
      });
      if (outcome.closed.length > 0) {
        insertResults(this.db, epochRow.id, version.id, outcome.closed, this.now());
      }
    }
    if (tail.length > 0) {
      saveSnapshot(this.db, epochRow.id, aggregator.lastSeq, aggregator.snapshot(), this.now());
    }
    this.active = {
      epoch: epochRow,
      version,
      spec: normalized.spec,
      parsed: normalized.parsed,
      aggregator,
      fence: this.currentFence(),
    };
  }

  // ---------------------------------------------------------------- runtime

  currentFence() {
    return Number(getMeta(this.db, META_KEYS.FENCE, 1));
  }

  bumpFence() {
    const next = this.currentFence() + 1;
    setMeta(this.db, META_KEYS.FENCE, next);
    if (this.active) this.active.fence = next;
    return next;
  }

  requireActiveEpoch() {
    const epoch = activeEpoch(this.db);
    if (!epoch) throw conflict('no-active-epoch', '当前没有活动执行器');
    return epoch;
  }

  runtime() {
    const epoch = this.requireActiveEpoch();
    return {
      epochId: epoch.id,
      versionId: epoch.versionId,
      versionLabel: this.active?.version.label ?? null,
      fence: this.currentFence(),
      paused: epoch.status === EPOCH_STATUS.PAUSED,
      status: epoch.status,
      serverTime: this.now(),
    };
  }

  // ----------------------------------------------------------------- ingest

  /**
   * Fenced ingest. A caller must present the epoch, version and fence it
   * believes are current. Mismatches are rejected and recorded in
   * stale_reports, which is how a retired executor's reports are kept out of
   * live results.
   */
  ingest({ workerId = 'unknown', epochId, versionId, fence, batchKey = null, events = [] } = {}) {
    if (!Array.isArray(events) || events.length === 0) {
      throw badRequest('empty-batch', '上报批次不能为空');
    }
    if (events.length > LIMITS.batchEvents) {
      throw badRequest('batch-too-large', `单批最多 ${LIMITS.batchEvents} 条事件`);
    }

    const epoch = this.requireActiveEpoch();
    const activeVersionId = epoch.versionId;
    const currentFence = this.currentFence();
    const claim = {
      workerId,
      epochId: epochId === undefined ? null : Number(epochId),
      claimedVersion: versionId === undefined ? null : Number(versionId),
      fence: fence === undefined ? null : Number(fence),
      activeEpoch: epoch.id,
      activeVersion: activeVersionId,
    };

    if (epoch.status === EPOCH_STATUS.PAUSED) {
      this.rejectStale({ ...claim, reason: 'paused', payload: { batchKey, events: events.length } });
      throw conflict('paused', '执行器已暂停，事件未写入', {
        activeEpoch: epoch.id,
        activeVersion: activeVersionId,
        fence: currentFence,
        pauseReason: getMeta(this.db, META_KEYS.PAUSED_REASON, '') || null,
      });
    }

    if (claim.epochId !== epoch.id || claim.fence !== currentFence) {
      this.rejectStale({ ...claim, reason: 'stale-fence', payload: { batchKey, events: events.length } });
      throw conflict('stale-fence', '上报凭据已过期，事件未写入', {
        activeEpoch: epoch.id,
        activeVersion: activeVersionId,
        fence: currentFence,
        hint: '请重新读取 /api/runtime 获取 epoch 与 fence 后重试',
      });
    }

    if (claim.claimedVersion !== null && claim.claimedVersion !== activeVersionId) {
      this.rejectStale({ ...claim, reason: 'stale-version', payload: { batchKey, events: events.length } });
      throw conflict('stale-version', '上报的规则版本已不是活动版本，事件未写入', {
        activeEpoch: epoch.id,
        activeVersion: activeVersionId,
        fence: currentFence,
      });
    }

    if (batchKey && this.db.get('SELECT 1 AS x FROM ingest_batches WHERE epoch_id = ? AND batch_key = ?', epoch.id, batchKey)) {
      return { outcome: 'duplicate-batch', accepted: 0, quarantined: 0, closed: 0, seqs: [], runtime: this.runtime() };
    }

    const accepted = [];
    const rejected = [];
    for (const event of events) {
      const problem = validateEvent(event);
      if (problem) rejected.push({ eventId: event?.eventId ?? null, reason: problem });
      else accepted.push(event);
    }
    if (rejected.length > 0) {
      recordQuarantine(
        this.db,
        {
          epochId: epoch.id,
          versionId: activeVersionId,
          kind: 'invalid-event',
          reason: '结构不合法的事件被隔离，不会写入原始数据',
          detail: { samples: rejected.slice(0, 10), count: rejected.length },
          itemCount: rejected.length,
        },
        this.now(),
      );
    }

    if (accepted.length === 0) {
      return { outcome: 'rejected-all', accepted: 0, quarantined: rejected.length, closed: 0, seqs: [], runtime: this.runtime() };
    }

    const at = this.now();
    const outcome = this.db.transaction(() => {
      const rows = [];
      for (const event of accepted) {
        const inserted = this.db.run(
          `INSERT INTO raw_events(event_id, event_time, received_at, source, payload_json) VALUES(?, ?, ?, ?, ?)`,
          event.eventId,
          event.eventTime,
          at,
          workerId,
          JSON.stringify(event.payload),
        );
        rows.push({ seq: inserted.lastInsertRowid, eventId: event.eventId, eventTime: event.eventTime, payload: event.payload });
      }
      if (batchKey) {
        this.db.run('INSERT INTO ingest_batches(epoch_id, batch_key, received_at) VALUES(?, ?, ?)', epoch.id, batchKey, at);
      }

      const closedResults = [];
      const adjudications = [];
      const tally = { accepted: 0, filtered: 0, duplicate: 0, late: 0, invalidGroup: 0, invalidDedup: 0 };
      for (const row of rows) {
        const result = this.active.aggregator.process(row);
        if (tally[result.outcome] === undefined) tally[result.outcome] = 0;
        tally[result.outcome] += 1;
        if (result.closed.length > 0) closedResults.push(...result.closed);
        adjudications.push({
          seq: row.seq,
          outcome: result.outcome,
          reason: result.reason,
          groupKey: result.groupKey,
          windows: result.windows,
          eventTime: row.eventTime,
          at,
        });
      }

      if (closedResults.length > 0) {
        insertResults(this.db, epoch.id, activeVersionId, closedResults, at);
      }
      insertAdjudications(this.db, epoch.id, activeVersionId, adjudications);

      const aggregator = this.active.aggregator;
      this.db.run(
        'UPDATE epochs SET checkpoint_seq = ?, watermark = ? WHERE id = ?',
        aggregator.lastSeq,
        aggregator.watermark,
        epoch.id,
      );
      saveSnapshot(this.db, epoch.id, aggregator.lastSeq, aggregator.snapshot(), at);
      return { tally, closedResults: closedResults.length, seqs: rows.map((row) => row.seq) };
    });

    this.emit({ type: 'ingest', epochId: epoch.id, versionId: activeVersionId, count: outcome.seqs.length });
    return {
      outcome: 'ok',
      ...outcome.tally,
      closed: outcome.closedResults,
      quarantined: rejected.length,
      seqs: outcome.seqs,
      watermark: this.active.aggregator.watermark,
      runtime: this.runtime(),
    };
  }

  rejectStale(report) {
    // A paused or superseded executor retries every tick. Persist the first
    // rejection per (worker, epoch, version, fence, reason) and then at most one
    // summary per second, so the audit trail stays useful instead of flooding.
    const key = [
      report.workerId,
      report.epochId,
      report.claimedVersion,
      report.fence,
      report.reason,
    ].join('|');
    const at = this.now();
    const last = this.staleThrottle.get(key);
    this.staleThrottle.set(key, at);
    if (last !== undefined && at - last < 1000) {
      this.suppressedStale += 1;
      return;
    }
    recordStaleReport(this.db, { ...report, payload: { ...report.payload, suppressedSinceLast: this.suppressedStale } }, at);
    this.suppressedStale = 0;
    this.emit({ type: 'stale', reason: report.reason });
  }

  // ------------------------------------------------------------------ rules

  createVersion(input, { sourceVersionId = null } = {}) {
    const normalized = normalizeSpec(input);
    const change = classifyChange(this.active.version.spec, normalized.spec);
    const at = this.now();
    const versionId = this.db.run(
      `INSERT INTO rule_versions(label, spec_json, semantic_hash, status, note, source_version_id, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
      normalized.spec.label,
      json(normalized.spec),
      normalized.semanticHash,
      VERSION_STATUS.DRAFT,
      input.note ?? null,
      sourceVersionId ?? this.active.version.id,
      at,
    ).lastInsertRowid;
    audit(this.db, 'version.create', { versionId, classification: change.classification, hash: normalized.semanticHash }, at);
    return { version: getVersion(this.db, versionId), change };
  }

  updateDraft(versionId, input) {
    const version = getVersion(this.db, versionId);
    if (!version) throw notFound('规则版本不存在');
    if (version.status !== VERSION_STATUS.DRAFT) {
      throw conflict('version-immutable', '只有草稿可以编辑；已发布版本不可修改');
    }
    const normalized = normalizeSpec(input);
    const change = classifyChange(this.active.version.spec, normalized.spec);
    const at = this.now();
    this.db.run(
      'UPDATE rule_versions SET label = ?, spec_json = ?, semantic_hash = ?, note = ? WHERE id = ?',
      normalized.spec.label,
      json(normalized.spec),
      normalized.semanticHash,
      input.note ?? version.note,
      versionId,
    );
    audit(this.db, 'version.update', { versionId, classification: change.classification }, at);
    return { version: getVersion(this.db, versionId), change };
  }

  previewVersion(versionId) {
    const version = getVersion(this.db, versionId);
    if (!version) throw notFound('规则版本不存在');
    const candidate = normalizeSpec(version.spec);
    const change = classifyChange(this.active.version.spec, candidate.spec);
    const result = computePreview(this.db, {
      candidate,
      baseline: { spec: this.active.spec, parsed: this.active.parsed },
    });
    return { version: summarizeVersion(version), change, plan: this.planFor(change, 'shadow'), ...result };
  }

  planFor(change, strategy) {
    const retained = this.db.get('SELECT COUNT(*) AS n FROM raw_events').n;
    const rows = this.db.get('SELECT COUNT(*) AS n FROM results WHERE epoch_id = ?', this.active.epoch.id).n;
    const rate = this.replayRate;
    if (change.classification === 'noop') {
      return {
        classification: 'noop',
        strategy: 'state-adopt',
        replayEvents: 0,
        estimatedReplayMs: 0,
        estimatedFreezeMs: 1,
        estimatedTotalMs: 1,
        latency: '规则语义未变化（可能只改了名称），只需切换指针，不重放、不影响结果。',
      };
    }
    if (change.classification === 'migrate') {
      return {
        classification: 'migrate',
        strategy: 'state-adopt',
        replayEvents: 0,
        estimatedReplayMs: 0,
        estimatedFreezeMs: Math.max(2, Math.ceil(rows / 500)),
        estimatedTotalMs: Math.max(2, Math.ceil(rows / 500)),
        latency: `只改变聚合口径：状态中的 count/sum/min/max 可直接换算，${rows} 条已关闭结果只需复制，不重放原始事件，冻结仅数毫秒。`,
      };
    }
    if (strategy === 'stop-the-world') {
      const freeze = Math.ceil((retained / rate) * 1000) + 5;
      return {
        classification: 'rebuild',
        strategy,
        replayEvents: retained,
        replayRate: rate,
        estimatedReplayMs: Math.ceil((retained / rate) * 1000),
        estimatedFreezeMs: freeze,
        estimatedTotalMs: freeze,
        latency: `停流切换：发布即冻结上报，按留存原始数据全量重放 ${retained} 条事件；冻结约 ${freeze}ms。期间查询仍返回旧 epoch 结果，但新事件会被拒绝并记录为过期上报。`,
      };
    }
    const replayMs = Math.ceil((retained / rate) * 1000);
    const catchupEvents = Math.ceil((replayMs / 1000) * 120);
    return {
      classification: 'rebuild',
      strategy: 'shadow',
      replayEvents: retained,
      replayRate: rate,
      estimatedReplayMs: replayMs,
      catchupEvents,
      estimatedFreezeMs: Math.max(2, Math.ceil((catchupEvents / rate) * 1000)),
      estimatedTotalMs: replayMs + 10,
      latency: `影子追赶：旧规则继续服务并接收事件，同时在留存原始数据上重建 ${retained} 条事件；重建到尾部后于切换瞬间追平新增事件（约 ${catchupEvents} 条），冻结约数毫秒。切换前新规则结果不作为线上结果提供。`,
    };
  }

  publishVersion(versionId, { strategy = 'shadow' } = {}) {
    if (!STRATEGIES.includes(strategy)) throw badRequest('invalid-strategy', '切换策略必须是 stop-the-world 或 shadow');
    const version = getVersion(this.db, versionId);
    if (!version) throw notFound('规则版本不存在');
    if (version.status === VERSION_STATUS.ACTIVE) throw conflict('already-active', '该版本已经是活动版本');
    if (version.status === VERSION_STATUS.RETIRED) {
      throw conflict('version-retired', '该版本已退役；请使用回滚（会派生新版本）');
    }
    if (version.status !== VERSION_STATUS.DRAFT && version.status !== VERSION_STATUS.PUBLISHED) {
      throw conflict('version-not-publishable', `版本状态 ${version.status} 不可发布`);
    }

    const normalized = normalizeSpec(version.spec);
    const change = classifyChange(this.active.version.spec, normalized.spec);
    const cancelled = this.rebuild.abortAll(`被新发布 v${version.id} 取代`);
    const plan = this.planFor(change, strategy);
    const at = this.now();

    this.db.transaction(() => {
      this.db.run(
        'UPDATE rule_versions SET status = ?, published_at = ? WHERE id = ?',
        VERSION_STATUS.PUBLISHED,
        at,
        version.id,
      );
      audit(
        this.db,
        'version.publish',
        { versionId: version.id, classification: change.classification, strategy, cancelledJobs: cancelled },
        at,
      );
    });

    const activation =
      change.classification === 'rebuild'
        ? this.rebuild.start(version, normalized, change, strategy, at)
        : this.migrateState(version, normalized, at);

    return {
      version: summarizeVersion(getVersion(this.db, version.id)),
      change,
      plan,
      activation,
      cancelledJobs: cancelled,
    };
  }

  /**
   * Zero-replay state migration. Only safe when the change is classified as
   * migrate/noop: group, filter, dedup, measure and window semantics are
   * identical, only the aggregate formula or label differs.
   */
  migrateState(version, normalized, at) {
    const oldEpoch = this.active.epoch;
    const epochId = this.db.transaction(() => {
      const nextEpochId = this.db.run(
        `INSERT INTO epochs(version_id, status, strategy, coverage_start_seq, checkpoint_seq, watermark, parent_epoch_id, created_at, activated_at, note)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        version.id,
        EPOCH_STATUS.ACTIVE,
        'state-adopt',
        this.active.aggregator.coverageStartSeq,
        this.active.aggregator.lastSeq,
        this.active.aggregator.watermark,
        oldEpoch.id,
        at,
        at,
        `从 epoch ${oldEpoch.id} 直接迁移状态`,
      ).lastInsertRowid;

      this.db.run(
        'UPDATE epochs SET status = ?, retired_at = ?, note = ? WHERE id = ?',
        EPOCH_STATUS.RETIRED,
        at,
        `由 v${version.id} 迁移取代`,
        oldEpoch.id,
      );
      this.db.run('UPDATE rule_versions SET status = ?, retired_at = ? WHERE id = ?', VERSION_STATUS.RETIRED, at, this.active.version.id);
      this.db.run('UPDATE rule_versions SET status = ?, activated_at = ? WHERE id = ?', VERSION_STATUS.ACTIVE, at, version.id);
      setMeta(this.db, META_KEYS.ACTIVE_EPOCH, nextEpochId);
      setMeta(this.db, META_KEYS.ACTIVE_VERSION, version.id);

      const maxSeq = this.active.aggregator.lastSeq;
      copyResults(this.db, oldEpoch.id, nextEpochId, version.id, maxSeq);
      copyAdjudications(this.db, oldEpoch.id, nextEpochId, version.id, maxSeq);

      const nextAggregator = new Aggregator({
        spec: normalized.spec,
        parsed: normalized.parsed,
        coverageStartSeq: this.active.aggregator.coverageStartSeq,
      });
      nextAggregator.adoptState(this.active.aggregator);
      saveSnapshot(this.db, nextEpochId, maxSeq, nextAggregator.snapshot(), at);

      const fence = this.bumpFence();
      audit(
        this.db,
        'epoch.migrate',
        { fromEpoch: oldEpoch.id, toEpoch: nextEpochId, versionId: version.id, fence, aggregate: normalized.spec.aggregate },
        at,
      );

      this.active = {
        epoch: getEpoch(this.db, nextEpochId),
        version: getVersion(this.db, version.id),
        spec: normalized.spec,
        parsed: normalized.parsed,
        aggregator: nextAggregator,
        fence,
      };
      return nextEpochId;
    });

    this.emit({ type: 'activate', mode: 'migrate', epochId, versionId: version.id });
    return {
      mode: 'state-adopt',
      epochId,
      strategy: 'state-adopt',
      replayEvents: 0,
      latencyMs: 0,
      fence: this.currentFence(),
    };
  }

  // ------------------------------------------------------------ pause/resume

  pause(reason = '操作员暂停') {
    const epoch = this.requireActiveEpoch();
    if (epoch.status === EPOCH_STATUS.PAUSED) {
      return { paused: true, alreadyPaused: true, epochId: epoch.id, fence: this.currentFence() };
    }
    if (this.rebuild.hasRunning()) {
      const jobs = this.rebuild.viewJobs(5).filter((job) => job.status === 'running');
      throw conflict('rebuild-running', '重建进行中，不能手动暂停；请等待切换或取消重建', {
        jobs: jobs.map((job) => ({ id: job.id, strategy: job.strategy })),
      });
    }
    const at = this.now();
    this.db.transaction(() => {
      this.db.run('UPDATE epochs SET status = ?, note = ? WHERE id = ?', EPOCH_STATUS.PAUSED, reason, epoch.id);
      setMeta(this.db, META_KEYS.PAUSED_REASON, reason);
      setMeta(this.db, PAUSE_OWNER, 'operator');
      const fence = this.bumpFence();
      audit(this.db, 'executor.pause', { epochId: epoch.id, reason, fence }, at);
    });
    this.emit({ type: 'pause', epochId: epoch.id, reason });
    return { paused: true, epochId: epoch.id, fence: this.currentFence(), reason };
  }

  resume() {
    const epoch = this.requireActiveEpoch();
    if (epoch.status !== EPOCH_STATUS.PAUSED) {
      return { paused: false, alreadyRunning: true, epochId: epoch.id, fence: this.currentFence() };
    }
    // A stop-the-world rebuild pauses the executor itself. "Resuming" it would
    // let new events into the old epoch mid-replay and turn a frozen cutover
    // into an implicit shadow rebuild; require an explicit cancel instead.
    if (getMeta(this.db, PAUSE_OWNER, '') === 'rebuild') {
      throw conflict('paused-by-rebuild', '当前暂停由停流重建触发；请取消重建，或等待其完成切换', {
        epochId: epoch.id,
      });
    }
    const at = this.now();
    this.db.transaction(() => {
      this.db.run('UPDATE epochs SET status = ?, note = NULL WHERE id = ?', EPOCH_STATUS.ACTIVE, epoch.id);
      setMeta(this.db, META_KEYS.PAUSED_REASON, '');
      setMeta(this.db, PAUSE_OWNER, '');
      const fence = this.bumpFence();
      audit(this.db, 'executor.resume', { epochId: epoch.id, fence }, at);
    });
    this.emit({ type: 'resume', epochId: epoch.id });
    this.rebuild.maybeCutoverReady();
    return { paused: false, epochId: epoch.id, fence: this.currentFence() };
  }

  cancelRebuild(jobId) {
    const session = this.rebuild.sessions.get(jobId);
    if (session) {
      this.rebuild.abortSession(session, '操作员取消');
      return { cancelled: jobId };
    }
    const row = this.db.get('SELECT status FROM rebuild_jobs WHERE id = ?', jobId);
    if (!row) throw notFound('重建任务不存在');
    throw conflict('not-cancellable', '该任务已不在当前进程中运行（只有进行中或待切换的重建可以取消）', {
      status: row.status,
    });
  }

  // ---------------------------------------------------------------- rollback

  rollback(toVersionId, { strategy = 'shadow' } = {}) {
    const target = getVersion(this.db, toVersionId);
    if (!target) throw notFound('目标版本不存在');
    if (target.id === this.active.version.id) throw conflict('already-active', '目标版本已经是活动版本');
    if (!STRATEGIES.includes(strategy)) throw badRequest('invalid-strategy', '切换策略必须是 stop-the-world 或 shadow');
    const historicalStatuses = [VERSION_STATUS.RETIRED, VERSION_STATUS.PUBLISHED, VERSION_STATUS.ACTIVE];
    if (!historicalStatuses.includes(target.status)) {
      throw conflict('draft-rollback', '草稿版本没有历史状态，无法直接回滚；请发布为新版本');
    }

    const normalized = normalizeSpec(target.spec);
    const change = classifyChange(this.active.version.spec, normalized.spec);
    const cancelled = this.rebuild.abortAll(`被回滚到 v${target.id} 取代`);
    const at = this.now();

    // Versions are immutable history; a rollback derives a new published
    // version pointing at the target spec so lineage stays append-only.
    const newVersionId = this.db.run(
      `INSERT INTO rule_versions(label, spec_json, semantic_hash, status, note, source_version_id, created_at, published_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      target.spec.label,
      json(target.spec),
      target.semanticHash,
      VERSION_STATUS.PUBLISHED,
      `回滚到 v${target.id}`,
      target.id,
      at,
      at,
    ).lastInsertRowid;
    const newVersion = getVersion(this.db, newVersionId);
    const plan = this.planFor(change, strategy);

    if (change.classification !== 'rebuild') {
      const activation = this.migrateState(newVersion, normalized, at);
      audit(this.db, 'version.rollback', { toVersionId: target.id, newVersionId, mode: 'state-adopt' }, at);
      return { version: summarizeVersion(newVersion), change, plan, activation, cancelledJobs: cancelled, fromSnapshot: null };
    }

    // Reuse the most recent snapshot of the target version when available so a
    // rollback does not have to replay unchanged history.
    const snapshot = latestSnapshotForVersion(this.db, target.id);
    const activation = this.rebuild.start(newVersion, normalized, change, strategy, at, {
      snapshot,
      note: `回滚到 v${target.id}`,
    });
    audit(
      this.db,
      'version.rollback',
      {
        toVersionId: target.id,
        newVersionId,
        mode: strategy,
        fromSnapshotSeq: snapshot?.seq ?? null,
        cancelledJobs: cancelled,
      },
      at,
    );
    return {
      version: summarizeVersion(newVersion),
      change,
      plan,
      activation,
      cancelledJobs: cancelled,
      fromSnapshot: snapshot ? { epochId: snapshot.epochId, seq: snapshot.seq, createdAt: snapshot.createdAt } : null,
    };
  }

  // ------------------------------------------------------------------- views

  stateView() {
    const epoch = activeEpoch(this.db);
    const version = this.active?.version ?? null;
    const counts = this.db.get(
      `SELECT
         (SELECT COUNT(*) FROM raw_events) AS raw,
         (SELECT COUNT(*) FROM results WHERE epoch_id = ?) AS results,
         (SELECT COUNT(*) FROM adjudications WHERE epoch_id = ?) AS adjudications,
         (SELECT COUNT(*) FROM stale_reports) AS stale,
         (SELECT COUNT(*) FROM quarantine) AS quarantine,
         (SELECT COUNT(*) FROM rule_versions) AS versions`,
      epoch?.id ?? -1,
      epoch?.id ?? -1,
    );
    const paused = epoch?.status === EPOCH_STATUS.PAUSED;
    const lastVerify = parseJson(getMeta(this.db, META_KEYS.LAST_VERIFY, null), null);
    return {
      serverTime: this.now(),
      bootedAt: Number(getMeta(this.db, META_KEYS.BOOTED_AT, 0)),
      paused,
      pauseReason: getMeta(this.db, META_KEYS.PAUSED_REASON, '') || null,
      pauseOwner: getMeta(this.db, PAUSE_OWNER, '') || null,
      runtime: epoch ? this.runtime() : null,
      activeVersion: version ? summarizeVersion(version) : null,
      activeEpoch: epoch,
      counts: {
        rawEvents: counts.raw,
        closedResults: counts.results,
        adjudications: counts.adjudications,
        staleReports: counts.stale,
        quarantine: counts.quarantine,
        versions: counts.versions,
      },
      counters: this.active?.aggregator.counters ?? null,
      openWindows: this.active?.aggregator.openWindows().length ?? 0,
      watermark: this.active?.aggregator.watermark ?? null,
      jobs: this.rebuild.viewJobs(8),
      staleReports: this.db.all('SELECT * FROM stale_reports ORDER BY id DESC LIMIT 6').map((row) => ({
        id: row.id,
        reason: row.reason,
        workerId: row.worker_id,
        claimedEpoch: row.epoch_id,
        claimedVersion: row.claimed_version,
        activeEpoch: row.active_epoch,
        activeVersion: row.active_version,
        receivedAt: row.received_at,
      })),
      lastVerify,
      epochs: listEpochs(this.db, 12),
    };
  }

  listVersions() {
    const activeId = this.active?.version.id;
    const jobs = this.rebuild.viewJobs(50);
    return listVersions(this.db).map((version) => ({
      ...summarizeVersion(version),
      isActive: version.id === activeId,
      hasActiveJob: jobs.some(
        (job) => job.versionId === version.id && ['running', 'queued', 'ready'].includes(job.status),
      ),
    }));
  }

  getVersionDetail(versionId) {
    const version = getVersion(this.db, versionId);
    if (!version) throw notFound('规则版本不存在');
    const change =
      version.id === this.active?.version.id
        ? { classification: 'noop', changes: [], reasons: [], migratableReasons: [] }
        : classifyChange(this.active.version.spec, version.spec);
    const epochs = listEpochs(this.db, 200).filter((epoch) => epoch.versionId === versionId);
    return {
      version: summarizeVersion(version),
      summary: summarizeSpec(version.spec),
      changeVsActive: change,
      epochs,
      planOptions: STRATEGIES.map((strategy) => ({ strategy, ...this.planFor(change, strategy) })),
      lineage: this.lineage(version),
    };
  }

  /** Pairwise semantic comparison, independent of which version is active. */
  compareVersions(fromId, toId) {
    const from = getVersion(this.db, fromId);
    const to = getVersion(this.db, toId);
    if (!from) throw notFound('起始版本不存在');
    if (!to) throw notFound('目标版本不存在');
    const change = classifyChange(from.spec, to.spec);
    return {
      from: summarizeVersion(from),
      to: summarizeVersion(to),
      change,
      planOptions: STRATEGIES.map((strategy) => ({ strategy, ...this.planFor(change, strategy) })),
    };
  }

  /**
   * Manual rebuild of the active version (useful after suspected drift).
   * Creates a fresh epoch from retained raw events without changing the spec.
   */
  startManualRebuild({ strategy = 'shadow' } = {}) {
    if (!STRATEGIES.includes(strategy)) throw badRequest('invalid-strategy', '切换策略必须是 stop-the-world 或 shadow');
    if (this.rebuild.hasRunning()) throw conflict('rebuild-running', '已有重建在进行中');
    const version = this.active.version;
    const normalized = normalizeSpec(version.spec);
    const at = this.now();
    const change = {
      classification: 'rebuild',
      changes: [
        {
          field: 'rebuild',
          label: '全量重算',
          kind: 'semantic',
          from: null,
          to: null,
          why: '按留存原始数据重建当前规则，不改变规则语义。',
        },
      ],
      reasons: [],
      migratableReasons: [],
    };
    const activation = this.rebuild.start(version, normalized, change, strategy, at, {
      note: '手动全量重建（核对状态）',
    });
    audit(this.db, 'rebuild.manual', { jobId: activation.jobId, strategy }, at);
    return { activation, plan: this.planFor(change, strategy) };
  }

  lineage(version) {
    const chain = [];
    let current = version;
    const seen = new Set();
    while (current && !seen.has(current.id) && chain.length < 20) {
      seen.add(current.id);
      chain.push({ id: current.id, label: current.label, status: current.status, note: current.note });
      current = current.sourceVersionId ? getVersion(this.db, current.sourceVersionId) : null;
    }
    return chain;
  }

  results({ epochId = null, limit = 100, offset = 0, from = null, to = null } = {}) {
    const targetEpoch = epochId ?? this.active?.epoch.id;
    if (!targetEpoch) throw notFound('没有可查询的 epoch');
    const epoch = getEpoch(this.db, targetEpoch);
    if (!epoch) throw notFound('epoch 不存在');
    const version = getVersion(this.db, epoch.versionId);
    const normalized = normalizeSpec(version.spec);
    const isLive = targetEpoch === this.active?.epoch.id;
    if (!isLive && [EPOCH_STATUS.BUILDING, EPOCH_STATUS.SHADOW].includes(epoch.status)) {
      throw conflict('results-not-ready', '该 epoch 仍在构建中，结果在切换前不可查询', {
        epochId: targetEpoch,
        status: epoch.status,
      });
    }
    const rows = listResults(this.db, targetEpoch, {
      limit: Math.min(limit, LIMITS.pageSize),
      offset: Math.max(0, offset),
      from,
      to,
    });
    const open = isLive ? this.active.aggregator.openWindows() : [];
    return {
      epoch,
      version: summarizeVersion(version),
      rows: rows.map((row) => ({
        ...row,
        group: displayScalar(row.groupKey),
        value: displayValue(normalized.spec.aggregate, row),
        live: false,
      })),
      open: open
        .map((row) => ({
          groupKey: row.groupKey,
          group: displayScalar(row.groupKey),
          windowStart: row.windowStart,
          windowEnd: row.windowEnd,
          count: row.count,
          sum: row.sum,
          min: row.min,
          max: row.max,
          value: displayValue(normalized.spec.aggregate, row),
          live: true,
          contributionsCount: row.contributionsCount,
          contributionsSample: row.contributionsSample,
        }))
        .sort((a, b) => a.windowStart - b.windowStart || String(a.group).localeCompare(String(b.group))),
      total: countResults(this.db, targetEpoch),
      openCount: open.length,
      aggregate: normalized.spec.aggregate,
      window: normalized.spec.window,
      availability: isLive ? 'live' : 'archived',
    };
  }

  adjudications({ epochId = null, limit = 50, before = null, outcome = null } = {}) {
    const targetEpoch = epochId ?? this.active?.epoch.id;
    if (!targetEpoch) throw notFound('没有可查询的 epoch');
    const epoch = getEpoch(this.db, targetEpoch);
    if (!epoch) throw notFound('epoch 不存在');
    const clauses = ['a.epoch_id = ?'];
    const params = [targetEpoch];
    if (before !== null) {
      clauses.push('a.seq < ?');
      params.push(before);
    }
    if (outcome) {
      clauses.push('a.outcome = ?');
      params.push(outcome);
    }
    const pageSize = Math.min(limit, LIMITS.pageSize);
    const rows = this.db.all(
      `SELECT a.*, r.event_id, r.event_time, r.payload_json, r.received_at, e.parent_epoch_id, e.strategy
       FROM adjudications a
       JOIN raw_events r ON r.seq = a.seq
       JOIN epochs e ON e.id = a.epoch_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY a.seq DESC LIMIT ?`,
      ...params,
      pageSize,
    );
    return {
      epoch,
      version: summarizeVersion(getVersion(this.db, epoch.versionId)),
      rows: rows.map((row) => ({
        seq: row.seq,
        eventId: row.event_id,
        eventTime: row.event_time,
        outcome: row.outcome,
        reason: row.reason,
        group: displayScalar(row.group_key),
        windows: parseJson(row.windows_json, []),
        versionId: row.version_id,
        epochId: row.epoch_id,
        inherited: row.inherited === 1,
        inheritedFromEpoch: row.parent_epoch_id,
        epochStrategy: row.strategy,
        decidedAt: row.at,
        receivedAt: row.received_at,
        payload: parseJson(row.payload_json, {}),
      })),
      nextBefore: rows.length === pageSize ? rows[rows.length - 1].seq : null,
    };
  }

  rawEvents({ limit = 50, before = null } = {}) {
    const clauses = [];
    const params = [];
    if (before !== null) {
      clauses.push('seq < ?');
      params.push(before);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const pageSize = Math.min(limit, LIMITS.pageSize);
    const rows = this.db.all(
      `SELECT * FROM raw_events ${where} ORDER BY seq DESC LIMIT ?`,
      ...params,
      pageSize,
    );
    return {
      rows: rows.map((row) => ({
        seq: row.seq,
        eventId: row.event_id,
        eventTime: row.event_time,
        receivedAt: row.received_at,
        source: row.source,
        payload: parseJson(row.payload_json, {}),
      })),
      nextBefore: rows.length === pageSize ? rows[rows.length - 1].seq : null,
      total: this.db.get('SELECT COUNT(*) AS n FROM raw_events').n,
    };
  }

  staleReports({ limit = 50, before = null } = {}) {
    const clauses = [];
    const params = [];
    if (before !== null) {
      clauses.push('id < ?');
      params.push(before);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const pageSize = Math.min(limit, LIMITS.pageSize);
    const rows = this.db.all(`SELECT * FROM stale_reports ${where} ORDER BY id DESC LIMIT ?`, ...params, pageSize);
    const byReason = this.db.all('SELECT reason, COUNT(*) AS n FROM stale_reports GROUP BY reason ORDER BY n DESC');
    return {
      rows: rows.map((row) => ({
        id: row.id,
        reason: row.reason,
        workerId: row.worker_id,
        claimedEpoch: row.epoch_id,
        claimedFence: row.fence === null ? null : Number(row.fence),
        claimedVersion: row.claimed_version,
        activeEpoch: row.active_epoch,
        activeVersion: row.active_version,
        receivedAt: row.received_at,
        payload: parseJson(row.payload_json, null),
      })),
      byReason,
      total: this.db.get('SELECT COUNT(*) AS n FROM stale_reports').n,
      nextBefore: rows.length === pageSize ? rows[rows.length - 1].id : null,
    };
  }

  quarantine({ limit = 50 } = {}) {
    const rows = this.db.all('SELECT * FROM quarantine ORDER BY id DESC LIMIT ?', Math.min(limit, LIMITS.pageSize));
    return {
      rows: rows.map((row) => ({
        id: row.id,
        epochId: row.epoch_id,
        versionId: row.version_id,
        kind: row.kind,
        reason: row.reason,
        detail: parseJson(row.detail_json, null),
        itemCount: row.item_count,
        receivedAt: row.received_at,
      })),
      total: this.db.get('SELECT COUNT(*) AS n FROM quarantine').n,
    };
  }

  auditLog({ limit = 60 } = {}) {
    const rows = this.db.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', Math.min(limit, LIMITS.pageSize));
    return {
      rows: rows.map((row) => ({
        id: row.id,
        at: row.at,
        kind: row.kind,
        detail: parseJson(row.detail_json, null),
      })),
    };
  }

  verify(options = {}) {
    return this.verifier.run({ sampleLimit: VERIFY_SAMPLE, ...options });
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must not affect ingestion.
      }
    }
  }
}

function emptyCounters() {
  return {
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

export function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return '事件必须是对象';
  if (typeof event.eventId !== 'string' || event.eventId.length === 0 || event.eventId.length > 120) {
    return 'eventId 必须是非空字符串（≤120 字符）';
  }
  if (!Number.isInteger(event.eventTime) || event.eventTime <= 0) return 'eventTime 必须是正整数毫秒时间戳';
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    return 'payload 必须是对象';
  }
  let serialized;
  try {
    serialized = JSON.stringify(event.payload);
  } catch {
    return 'payload 无法序列化为 JSON';
  }
  if (serialized.length > LIMITS.payloadBytes) return `payload 超过 ${LIMITS.payloadBytes} 字节`;
  for (const [key, value] of Object.entries(event.payload)) {
    const info = FIELD_INFO[key];
    if (!info) continue; // Extra fields are retained but ignored by the rule.
    if (value === null || value === undefined) continue;
    const expected = info.type;
    if (expected === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
      return `字段 ${key} 必须是有限数字`;
    }
    if (expected === 'string' && typeof value !== 'string') return `字段 ${key} 必须是字符串`;
    if (expected === 'boolean' && typeof value !== 'boolean') return `字段 ${key} 必须是布尔值`;
  }
  return null;
}

export function summarizeVersion(version) {
  return {
    id: version.id,
    label: version.label,
    status: version.status,
    semanticHash: version.semanticHash,
    note: version.note,
    sourceVersionId: version.sourceVersionId,
    createdAt: version.createdAt,
    publishedAt: version.publishedAt,
    activatedAt: version.activatedAt,
    retiredAt: version.retiredAt,
    spec: version.spec,
    summary: summarizeSpec(version.spec),
  };
}

export function displayValue(aggregate, result) {
  switch (aggregate) {
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

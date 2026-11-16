/**
 * Rebuild coordinator.
 *
 * Two strategies:
 *  - stop-the-world: freeze ingestion (fence bump), replay retained raw events
 *    into a fresh epoch, cut over synchronously, then resume. Ingestion is
 *    unavailable for the duration; reads keep serving the old epoch.
 *  - shadow: the old epoch keeps serving and accepting events. Replay runs
 *    against retained raw events in a shadow epoch; live appends are simply
 *    part of raw_events, so the final catch-up is a short synchronous tail read
 *    at cutover. New-rule results are not readable as live until the swap.
 *
 * Every rebuild holds a build-generation token. Publishing a newer rule aborts
 * older builds, and a build whose token is stale can never swap itself live.
 * All state mutation happens on the Node event loop, so no write can interleave
 * with the final catch-up / cutover sequence.
 */

import { Aggregator } from './aggregator.js';
import {
  EPOCH_STATUS,
  VERSION_STATUS,
  audit,
  copyAdjudications,
  copyResults,
  getEpoch,
  getMeta,
  getVersion,
  insertAdjudications,
  insertResults,
  mapJob,
  saveSnapshot,
  setMeta,
} from './repository.js';
import { conflict } from '../errors.js';
import { json, parseJson } from '../db.js';

const BUILD_GENERATION = 'build_generation';
export const PAUSE_OWNER = 'pause_owner';

export class RebuildRunner {
  constructor(engine) {
    this.engine = engine;
    this.sessions = new Map();
    this.timers = new Set();
    this.waiters = new Set();
  }

  hasRunning() {
    return this.sessions.size > 0;
  }

  nextGeneration() {
    const next = Number(getMeta(this.engine.db, BUILD_GENERATION, 0)) + 1;
    setMeta(this.engine.db, BUILD_GENERATION, next);
    return next;
  }

  /**
   * @param {object} options
   * @param {object} [options.snapshot] {epochId, seq, snapshot} to seed from
   */
  start(version, normalized, change, strategy, at, { note = null, snapshot = null } = {}) {
    if (strategy !== 'stop-the-world' && strategy !== 'shadow') {
      throw conflict('invalid-strategy', '未知重建策略');
    }
    const engine = this.engine;
    const oldEpoch = engine.active.epoch;
    const generation = this.nextGeneration();
    const maxSeq = engine.db.get('SELECT COALESCE(MAX(seq), 0) AS n FROM raw_events').n;
    const seedSeq = snapshot ? snapshot.seq : 0;
    const fromSeq = seedSeq + 1;
    const coverageStartSeq = snapshot?.snapshot?.coverageStartSeq ?? 1;

    const built = engine.db.transaction(() => {
      const epochStatus = strategy === 'shadow' ? EPOCH_STATUS.SHADOW : EPOCH_STATUS.BUILDING;
      const epochId = engine.db.run(
        `INSERT INTO epochs(version_id, status, strategy, coverage_start_seq, checkpoint_seq, watermark, parent_epoch_id, created_at, note)
         VALUES(?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        version.id,
        epochStatus,
        strategy,
        coverageStartSeq,
        seedSeq,
        oldEpoch.id,
        at,
        note ??
          `${strategy === 'shadow' ? '影子重建' : '停流重建'}（留存原始数据 ${fromSeq}..${maxSeq}${
            snapshot ? `，自快照 epoch ${snapshot.epochId}@${snapshot.seq} 续建` : ''
          }）`,
      ).lastInsertRowid;

      if (snapshot) {
        copyResults(engine.db, snapshot.epochId, epochId, version.id, snapshot.seq);
        copyAdjudications(engine.db, snapshot.epochId, epochId, version.id, snapshot.seq);
      }

      if (strategy === 'stop-the-world') {
        engine.db.run(
          'UPDATE epochs SET status = ?, note = ? WHERE id = ?',
          EPOCH_STATUS.PAUSED,
          `停流重建：等待 v${version.id} 切换`,
          oldEpoch.id,
        );
        setMeta(engine.db, 'pause_reason', `停流重建：v${version.id}`);
        setMeta(engine.db, PAUSE_OWNER, 'rebuild');
        engine.bumpFence();
      }

      const jobId = engine.db.run(
        `INSERT INTO rebuild_jobs(version_id, epoch_id, from_seq, target_seq, cursor_seq, strategy, status,
                                  replayed, started_at, updated_at, metrics_json)
         VALUES(?, ?, ?, ?, ?, ?, 'running', 0, ?, ?, ?)`,
        version.id,
        epochId,
        fromSeq,
        maxSeq,
        seedSeq,
        strategy,
        at,
        at,
        json({ generation, maxSeq, seedEpochId: snapshot?.epochId ?? null, seedSeq }),
      ).lastInsertRowid;

      audit(
        engine.db,
        'rebuild.start',
        { jobId, epochId, versionId: version.id, strategy, fromSeq, generation, seedSeq },
        at,
      );
      return { epochId, jobId, generation };
    });

    const aggregator = new Aggregator({
      spec: normalized.spec,
      parsed: normalized.parsed,
      coverageStartSeq,
    });
    if (snapshot?.snapshot) {
      aggregator.restore(snapshot.snapshot);
    }

    const session = {
      jobId: built.jobId,
      epochId: built.epochId,
      versionId: version.id,
      normalized,
      strategy,
      generation,
      aggregator,
      fromSeq,
      targetSeq: maxSeq,
      phase: 'replaying',
      oldEpochId: oldEpoch.id,
      startedAt: at,
      timer: null,
      finished: false,
      replayed: 0,
      seedSeq,
    };
    this.sessions.set(built.jobId, session);
    engine.emit({ type: 'rebuild-start', jobId: session.jobId, strategy, versionId: version.id });
    this.schedule(session, 0);

    return {
      mode: strategy,
      jobId: session.jobId,
      epochId: session.epochId,
      strategy,
      fromSeq,
      targetSeq: maxSeq,
      generation,
      seedSeq,
      estimatedReplayMs: engine.planFor(change, strategy).estimatedReplayMs,
      note,
    };
  }

  schedule(session, delayMs) {
    if (session.finished) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      session.timer = null;
      try {
        this.tick(session);
      } catch (error) {
        this.fail(session, error);
      }
    }, delayMs);
    session.timer = timer;
    this.timers.add(timer);
  }

  tick(session) {
    if (session.finished) return;
    const engine = this.engine;

    if (session.phase === 'replaying') {
      const chunk = engine.db.all(
        'SELECT * FROM raw_events WHERE seq > ? ORDER BY seq ASC LIMIT ?',
        session.aggregator.lastSeq,
        engine.chunkSize,
      );
      if (chunk.length > 0) {
        const at = engine.now();
        engine.db.transaction(() => {
          const closed = [];
          const adjudications = [];
          for (const row of chunk) {
            const outcome = session.aggregator.process({
              seq: row.seq,
              eventId: row.event_id,
              eventTime: row.event_time,
              payload: parseJson(row.payload_json, {}),
            });
            if (outcome.closed.length > 0) closed.push(...outcome.closed);
            adjudications.push({
              seq: row.seq,
              outcome: outcome.outcome,
              reason: outcome.reason,
              groupKey: outcome.groupKey,
              windows: outcome.windows,
              eventTime: row.event_time,
              at,
            });
            session.replayed += 1;
          }
          if (closed.length > 0) insertResults(engine.db, session.epochId, session.versionId, closed, at);
          insertAdjudications(engine.db, session.epochId, session.versionId, adjudications);
          const currentMax = engine.db.get('SELECT COALESCE(MAX(seq), 0) AS n FROM raw_events').n;
          engine.db.run(
            'UPDATE rebuild_jobs SET cursor_seq = ?, target_seq = ?, replayed = ?, updated_at = ? WHERE id = ?',
            session.aggregator.lastSeq,
            currentMax,
            session.replayed,
            at,
            session.jobId,
          );
          engine.db.run(
            'UPDATE epochs SET checkpoint_seq = ?, watermark = ? WHERE id = ?',
            session.aggregator.lastSeq,
            session.aggregator.watermark,
            session.epochId,
          );
        });
        engine.emit({ type: 'rebuild-progress', jobId: session.jobId, cursor: session.aggregator.lastSeq });
        this.schedule(session, this.chunkDelay());
        return;
      }
      session.phase = 'following';
    }

    // Catch up any events appended since the last chunk. Re-read until the
    // cursor matches the current maximum; ingestion keeps running on the old
    // epoch during a shadow rebuild, so this can take a couple of passes.
    const maxSeq = engine.db.get('SELECT COALESCE(MAX(seq), 0) AS n FROM raw_events').n;
    if (session.aggregator.lastSeq < maxSeq) {
      this.schedule(session, 0);
      return;
    }

    saveSnapshot(engine.db, session.epochId, session.aggregator.lastSeq, session.aggregator.snapshot(), engine.now());
    engine.emit({ type: 'rebuild-caught-up', jobId: session.jobId, seq: session.aggregator.lastSeq });

    const oldEpoch = getEpoch(engine.db, session.oldEpochId);
    const pauseOwner = getMeta(engine.db, PAUSE_OWNER, '');
    if (oldEpoch?.status === EPOCH_STATUS.PAUSED && pauseOwner === 'operator') {
      // An operator pause takes precedence: stay ready, cut over on resume.
      this.markReady(session);
      return;
    }
    this.cutover(session);
  }

  chunkDelay() {
    if (!this.engine.replayRate) return 0;
    return Math.max(0, Math.round((this.engine.chunkSize / this.engine.replayRate) * 1000));
  }

  markReady(session) {
    if (session.finished) return;
    session.phase = 'ready';
    const at = this.engine.now();
    this.engine.db.run(
      "UPDATE rebuild_jobs SET status = 'ready', cursor_seq = ?, updated_at = ? WHERE id = ?",
      session.aggregator.lastSeq,
      at,
      session.jobId,
    );
    this.engine.db.run('UPDATE epochs SET status = ? WHERE id = ?', EPOCH_STATUS.SHADOW, session.epochId);
    this.engine.emit({ type: 'rebuild-ready', jobId: session.jobId });
  }

  /**
   * Synchronous cutover: final tail catch-up and the active-pointer swap happen
   * in one task, so no ingest can interleave. The build token is checked after
   * the catch-up and again conceptually by the synchronous call itself.
   */
  cutover(session) {
    if (session.finished) return;
    const engine = this.engine;
    const job = engine.db.get('SELECT * FROM rebuild_jobs WHERE id = ?', session.jobId);
    if (!job) return this.finish(session);
    if (job.status === 'aborted') return this.finish(session);

    const currentGeneration = Number(getMeta(engine.db, BUILD_GENERATION, 0));
    if (currentGeneration !== session.generation) {
      this.abortSession(session, '构建令牌已失效（有更新的规则发布或回滚）');
      return;
    }

    const maxSeq = engine.db.get('SELECT COALESCE(MAX(seq), 0) AS n FROM raw_events').n;
    if (session.aggregator.lastSeq < maxSeq) {
      const tail = engine.db.all(
        'SELECT * FROM raw_events WHERE seq > ? ORDER BY seq ASC',
        session.aggregator.lastSeq,
      );
      const at = engine.now();
      engine.db.transaction(() => {
        const closed = [];
        const adjudications = [];
        for (const row of tail) {
          const outcome = session.aggregator.process({
            seq: row.seq,
            eventId: row.event_id,
            eventTime: row.event_time,
            payload: parseJson(row.payload_json, {}),
          });
          if (outcome.closed.length > 0) closed.push(...outcome.closed);
          adjudications.push({
            seq: row.seq,
            outcome: outcome.outcome,
            reason: outcome.reason,
            groupKey: outcome.groupKey,
            windows: outcome.windows,
            eventTime: row.event_time,
            at,
          });
          session.replayed += 1;
        }
        if (closed.length > 0) insertResults(engine.db, session.epochId, session.versionId, closed, at);
        insertAdjudications(engine.db, session.epochId, session.versionId, adjudications);
      });
      if (session.aggregator.lastSeq < maxSeq) {
        // Extremely unlikely (would require a synchronous append from a DB
        // trigger); defer rather than swap with a gap.
        this.schedule(session, 0);
        return;
      }
    }

    const at = engine.now();
    const oldEpoch = getEpoch(engine.db, session.oldEpochId);
    if (!oldEpoch || [EPOCH_STATUS.RETIRED, EPOCH_STATUS.ABORTED, EPOCH_STATUS.FAILED].includes(oldEpoch.status)) {
      this.abortSession(session, '原执行器已退役，取消切换');
      return;
    }

    engine.db.transaction(() => {
      engine.db.run(
        'UPDATE epochs SET status = ?, retired_at = ?, note = ? WHERE id = ?',
        EPOCH_STATUS.RETIRED,
        at,
        `由 v${session.versionId} 的${session.strategy === 'shadow' ? '影子' : '停流'}重建取代`,
        session.oldEpochId,
      );
      engine.db.run(
        'UPDATE epochs SET status = ?, activated_at = ?, checkpoint_seq = ?, watermark = ? WHERE id = ?',
        EPOCH_STATUS.ACTIVE,
        at,
        session.aggregator.lastSeq,
        session.aggregator.watermark,
        session.epochId,
      );
      engine.db.run(
        'UPDATE rule_versions SET status = ?, retired_at = ? WHERE id = ?',
        VERSION_STATUS.RETIRED,
        at,
        engine.active.version.id,
      );
      engine.db.run(
        'UPDATE rule_versions SET status = ?, activated_at = ? WHERE id = ?',
        VERSION_STATUS.ACTIVE,
        at,
        session.versionId,
      );
      setMeta(engine.db, 'active_epoch_id', session.epochId);
      setMeta(engine.db, 'active_version_id', session.versionId);
      setMeta(engine.db, 'pause_reason', '');
      setMeta(engine.db, PAUSE_OWNER, '');
      const fence = engine.bumpFence();
      saveSnapshot(engine.db, session.epochId, session.aggregator.lastSeq, session.aggregator.snapshot(), at);
      const metrics = {
        generation: session.generation,
        replayed: session.replayed,
        fromSeq: session.fromSeq,
        finalSeq: session.aggregator.lastSeq,
        durationMs: at - session.startedAt,
        counters: session.aggregator.counters,
        lagAtCutover: maxSeq - session.aggregator.lastSeq,
      };
      engine.db.run(
        "UPDATE rebuild_jobs SET status = 'done', cursor_seq = ?, target_seq = ?, finished_at = ?, updated_at = ?, metrics_json = ? WHERE id = ?",
        session.aggregator.lastSeq,
        session.aggregator.lastSeq,
        at,
        at,
        json(metrics),
        session.jobId,
      );
      audit(
        engine.db,
        'rebuild.cutover',
        {
          jobId: session.jobId,
          fromEpoch: session.oldEpochId,
          toEpoch: session.epochId,
          versionId: session.versionId,
          fence,
          replayed: session.replayed,
        },
        at,
      );

      engine.active = {
        epoch: getEpoch(engine.db, session.epochId),
        version: getVersion(engine.db, session.versionId),
        spec: session.normalized.spec,
        parsed: session.normalized.parsed,
        aggregator: session.aggregator,
        fence,
      };
    });

    session.finished = true;
    this.clearTimer(session);
    this.sessions.delete(session.jobId);
    engine.emit({
      type: 'activate',
      mode: session.strategy,
      epochId: session.epochId,
      versionId: session.versionId,
    });
    this.resolveWaiters();
  }

  /** Called after a resume to cut over builds that caught up while paused. */
  maybeCutoverReady() {
    const active = getEpoch(this.engine.db, this.engine.active.epoch.id);
    if (!active || active.status === EPOCH_STATUS.PAUSED) return;
    for (const session of [...this.sessions.values()]) {
      const job = this.engine.db.get('SELECT status FROM rebuild_jobs WHERE id = ?', session.jobId);
      if (job?.status === 'ready') {
        try {
          this.cutover(session);
        } catch (error) {
          this.fail(session, error);
        }
      }
    }
  }

  abortAll(reason) {
    const aborted = [];
    for (const session of [...this.sessions.values()]) {
      this.abortSession(session, reason);
      aborted.push(session.jobId);
    }
    return aborted;
  }

  abortSession(session, reason) {
    if (session.finished) return;
    const engine = this.engine;
    const at = engine.now();
    session.finished = true;
    engine.db.transaction(() => {
      engine.db.run(
        "UPDATE rebuild_jobs SET status = 'aborted', finished_at = ?, updated_at = ?, error = ? WHERE id = ?",
        at,
        at,
        reason,
        session.jobId,
      );
      engine.db.run(
        'UPDATE epochs SET status = ?, retired_at = ?, note = ? WHERE id = ?',
        EPOCH_STATUS.ABORTED,
        at,
        `重建中止：${reason}`,
        session.epochId,
      );
      if (session.strategy === 'stop-the-world') {
        const old = getEpoch(engine.db, session.oldEpochId);
        if (old?.status === EPOCH_STATUS.PAUSED) {
          engine.db.run('UPDATE epochs SET status = ?, note = NULL WHERE id = ?', EPOCH_STATUS.ACTIVE, old.id);
          setMeta(engine.db, 'pause_reason', '');
          setMeta(engine.db, PAUSE_OWNER, '');
          engine.bumpFence();
        }
      }
      audit(engine.db, 'rebuild.abort', { jobId: session.jobId, reason }, at);
    });
    this.clearTimer(session);
    this.sessions.delete(session.jobId);
    engine.emit({ type: 'rebuild-abort', jobId: session.jobId, reason });
    this.resolveWaiters();
  }

  fail(session, error) {
    if (session.finished) return;
    const engine = this.engine;
    const at = engine.now();
    const message = String(error?.message ?? error);
    session.finished = true;
    engine.db.transaction(() => {
      engine.db.run(
        "UPDATE rebuild_jobs SET status = 'failed', finished_at = ?, updated_at = ?, error = ? WHERE id = ?",
        at,
        at,
        message,
        session.jobId,
      );
      engine.db.run(
        'UPDATE epochs SET status = ?, retired_at = ?, note = ? WHERE id = ?',
        EPOCH_STATUS.FAILED,
        at,
        `重建失败：${message}`,
        session.epochId,
      );
      if (session.strategy === 'stop-the-world') {
        const old = getEpoch(engine.db, session.oldEpochId);
        if (old?.status === EPOCH_STATUS.PAUSED) {
          engine.db.run('UPDATE epochs SET status = ?, note = NULL WHERE id = ?', EPOCH_STATUS.ACTIVE, old.id);
          setMeta(engine.db, 'pause_reason', '');
          setMeta(engine.db, PAUSE_OWNER, '');
          engine.bumpFence();
        }
      }
      audit(engine.db, 'rebuild.fail', { jobId: session.jobId, error: message }, at);
    });
    this.clearTimer(session);
    this.sessions.delete(session.jobId);
    engine.emit({ type: 'rebuild-fail', jobId: session.jobId, error: message });
    this.resolveWaiters();
  }

  finish(session) {
    session.finished = true;
    this.clearTimer(session);
    this.sessions.delete(session.jobId);
    this.resolveWaiters();
  }

  clearTimer(session) {
    if (session.timer) {
      clearTimeout(session.timer);
      this.timers.delete(session.timer);
      session.timer = null;
    }
  }

  failOrphanedJobs(reason) {
    const rows = this.engine.db.all("SELECT * FROM rebuild_jobs WHERE status IN ('queued','running','ready')");
    const at = this.engine.now();
    for (const row of rows) {
      this.engine.db.run(
        "UPDATE rebuild_jobs SET status = 'failed', finished_at = ?, updated_at = ?, error = ? WHERE id = ?",
        at,
        at,
        reason,
        row.id,
      );
      const epoch = getEpoch(this.engine.db, row.epoch_id);
      if (epoch && ![EPOCH_STATUS.ACTIVE, EPOCH_STATUS.RETIRED].includes(epoch.status)) {
        this.engine.db.run(
          'UPDATE epochs SET status = ?, retired_at = ?, note = ? WHERE id = ?',
          EPOCH_STATUS.FAILED,
          at,
          reason,
          epoch.id,
        );
      }
    }
    if (rows.length > 0) {
      const paused = this.engine.db.get("SELECT * FROM epochs WHERE status = 'paused' ORDER BY id DESC LIMIT 1");
      if (paused) {
        this.engine.db.run('UPDATE epochs SET status = ?, note = NULL WHERE id = ?', EPOCH_STATUS.ACTIVE, paused.id);
        setMeta(this.engine.db, 'pause_reason', '');
        setMeta(this.engine.db, PAUSE_OWNER, '');
        this.engine.bumpFence();
      }
      audit(this.engine.db, 'rebuild.orphaned', { count: rows.length, reason }, at);
    }
  }

  viewJobs(limit = 8) {
    const rows = this.engine.db.all('SELECT * FROM rebuild_jobs ORDER BY id DESC LIMIT ?', limit);
    const maxSeq = this.engine.db.get('SELECT COALESCE(MAX(seq), 0) AS n FROM raw_events').n;
    return rows.map((row) => {
      const epoch = getEpoch(this.engine.db, row.epoch_id);
      const version = getVersion(this.engine.db, row.version_id);
      const live = this.sessions.get(row.id);
      const cursor = live ? live.aggregator.lastSeq : row.cursor_seq;
      const status = live ? 'running' : row.status;
      const span = row.target_seq - row.from_seq + 1;
      return {
        ...mapJob({ ...row, status }),
        versionLabel: version?.label ?? null,
        epochStatus: epoch?.status ?? null,
        progress: status === 'done' ? 1 : span > 0 ? Math.min(1, (cursor - row.from_seq + 1) / span) : 0,
        lagEvents: status === 'done' ? 0 : Math.max(0, maxSeq - cursor),
        phase: live?.phase ?? (row.status === 'done' ? 'done' : row.status),
        strategyLabel: row.strategy === 'stop-the-world' ? '停流切换' : '影子追赶',
      };
    });
  }

  /** Wait until all sessions finish (tests and graceful shutdown). */
  async settle({ timeoutMs = 30_000 } = {}) {
    const start = Date.now();
    while (this.sessions.size > 0) {
      if (Date.now() - start > timeoutMs) throw new Error('重建等待超时');
      await new Promise((resolve) => {
        const waiter = () => {
          this.waiters.delete(waiter);
          resolve();
        };
        this.waiters.add(waiter);
        setTimeout(waiter, 25);
      });
    }
  }

  resolveWaiters() {
    if (this.sessions.size > 0) return;
    for (const waiter of [...this.waiters]) waiter();
  }
}

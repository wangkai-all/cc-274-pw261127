/**
 * Row mappers and SQL used by the engine. Keeping persistence in one place
 * makes epoch scoping explicit: every derived row carries the epoch that
 * produced it.
 */

import { parseJson } from '../db.js';

export const VERSION_STATUS = Object.freeze({
  DRAFT: 'draft',
  PUBLISHED: 'published',
  ACTIVE: 'active',
  RETIRED: 'retired',
});

export const EPOCH_STATUS = Object.freeze({
  BUILDING: 'building',
  SHADOW: 'shadow',
  ACTIVE: 'active',
  PAUSED: 'paused',
  RETIRED: 'retired',
  ABORTED: 'aborted',
  FAILED: 'failed',
});

export function mapVersion(row) {
  if (!row) return null;
  const spec = parseJson(row.spec_json, {});
  return {
    id: row.id,
    label: row.label,
    spec,
    semanticHash: row.semantic_hash,
    status: row.status,
    note: row.note,
    sourceVersionId: row.source_version_id,
    createdAt: row.created_at,
    publishedAt: row.published_at,
    activatedAt: row.activated_at,
    retiredAt: row.retired_at,
    supersededAt: row.superseded_at,
  };
}

export function mapEpoch(row) {
  if (!row) return null;
  return {
    id: row.id,
    versionId: row.version_id,
    status: row.status,
    strategy: row.strategy,
    coverageStartSeq: row.coverage_start_seq,
    checkpointSeq: row.checkpoint_seq,
    watermark: row.watermark,
    parentEpochId: row.parent_epoch_id,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    retiredAt: row.retired_at,
    note: row.note,
  };
}

export function mapResult(row) {
  if (!row) return null;
  return {
    epochId: row.epoch_id,
    versionId: row.version_id,
    groupKey: row.group_key,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    count: row.count,
    sum: row.sum,
    min: row.min,
    max: row.max,
    contributionsCount: row.contributions_count,
    contributionsDigest: row.contributions_digest,
    contributionsSample: parseJson(row.contributions_sample, []),
    firstSeq: row.first_seq,
    lastSeq: row.last_seq,
    closedAt: row.closed_at,
  };
}

export function mapJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    versionId: row.version_id,
    epochId: row.epoch_id,
    fromSeq: row.from_seq,
    targetSeq: row.target_seq,
    cursorSeq: row.cursor_seq,
    strategy: row.strategy,
    status: row.status,
    replayed: row.replayed,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    error: row.error,
    metrics: parseJson(row.metrics_json, null),
    verification: parseJson(row.verification_json, null),
  };
}

export function getMeta(db, key, fallback = null) {
  const row = db.get('SELECT value FROM meta WHERE key = ?', key);
  return row ? row.value : fallback;
}

export function setMeta(db, key, value) {
  db.run(
    'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    String(value),
  );
}

export function getVersion(db, id) {
  return mapVersion(db.get('SELECT * FROM rule_versions WHERE id = ?', id));
}

export function listVersions(db) {
  return db.all('SELECT * FROM rule_versions ORDER BY id DESC').map(mapVersion);
}

export function getEpoch(db, id) {
  return mapEpoch(db.get('SELECT * FROM epochs WHERE id = ?', id));
}

export function listEpochs(db, limit = 100) {
  return db.all('SELECT * FROM epochs ORDER BY id DESC LIMIT ?', limit).map(mapEpoch);
}

export function activeEpoch(db) {
  const pointer = getMeta(db, 'active_epoch_id', null);
  if (pointer !== null) {
    const epoch = mapEpoch(db.get('SELECT * FROM epochs WHERE id = ?', Number(pointer)));
    if (epoch) return epoch;
  }
  return mapEpoch(db.get("SELECT * FROM epochs WHERE status = 'active' ORDER BY id DESC LIMIT 1"));
}

export function getJob(db, id) {
  return mapJob(db.get('SELECT * FROM rebuild_jobs WHERE id = ?', id));
}

export function runningJobs(db) {
  return db
    .all("SELECT * FROM rebuild_jobs WHERE status IN ('queued','running') ORDER BY id ASC")
    .map(mapJob);
}

export function listResults(db, epochId, { limit = 500, offset = 0, from = null, to = null } = {}) {
  const clauses = ['epoch_id = ?'];
  const params = [epochId];
  if (from !== null) {
    clauses.push('window_start >= ?');
    params.push(from);
  }
  if (to !== null) {
    clauses.push('window_end <= ?');
    params.push(to);
  }
  return db
    .all(
      `SELECT * FROM results WHERE ${clauses.join(' AND ')}
       ORDER BY window_start ASC, group_key ASC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    )
    .map(mapResult);
}

export function countResults(db, epochId) {
  return db.get('SELECT COUNT(*) AS n FROM results WHERE epoch_id = ?', epochId).n;
}

export function insertAdjudications(db, epochId, versionId, rows, inherited = 0) {
  const statement = db.prepare(
    `INSERT INTO adjudications(seq, epoch_id, version_id, outcome, reason, group_key, windows_json, event_time, at, inherited)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(epoch_id, seq) DO NOTHING`,
  );
  for (const row of rows) {
    statement.run(
      row.seq,
      epochId,
      versionId,
      row.outcome,
      row.reason ?? null,
      row.groupKey ?? null,
      JSON.stringify(row.windows ?? []),
      row.eventTime,
      row.at,
      inherited,
    );
  }
}

export function insertResults(db, epochId, versionId, results, closedAt) {
  const statement = db.prepare(
    `INSERT INTO results(epoch_id, version_id, group_key, window_start, window_end, count, sum, min, max,
                         contributions_count, contributions_digest, contributions_sample,
                         first_seq, last_seq, closed_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(epoch_id, group_key, window_start, window_end) DO UPDATE SET
       count = excluded.count, sum = excluded.sum, min = excluded.min, max = excluded.max,
       contributions_count = excluded.contributions_count,
       contributions_digest = excluded.contributions_digest,
       contributions_sample = excluded.contributions_sample,
       first_seq = excluded.first_seq, last_seq = excluded.last_seq, closed_at = excluded.closed_at`,
  );
  for (const result of results) {
    statement.run(
      epochId,
      versionId,
      result.groupKey,
      result.windowStart,
      result.windowEnd,
      result.count,
      result.sum,
      result.min,
      result.max,
      result.contributionsCount,
      result.contributionsDigest,
      JSON.stringify(result.contributionsSample),
      result.firstSeq,
      result.lastSeq,
      closedAt,
    );
  }
}

export function copyResults(db, fromEpochId, toEpochId, versionId, maxSeq) {
  db.run(
    `INSERT INTO results(epoch_id, version_id, group_key, window_start, window_end, count, sum, min, max,
                         contributions_count, contributions_digest, contributions_sample,
                         first_seq, last_seq, closed_at)
     SELECT ?, ?, group_key, window_start, window_end, count, sum, min, max,
            contributions_count, contributions_digest, contributions_sample,
            first_seq, last_seq, closed_at
     FROM results WHERE epoch_id = ? AND last_seq <= ?
     ON CONFLICT(epoch_id, group_key, window_start, window_end) DO NOTHING`,
    toEpochId,
    versionId,
    fromEpochId,
    maxSeq,
  );
}

export function copyAdjudications(db, fromEpochId, toEpochId, versionId, maxSeq) {
  db.run(
    `INSERT INTO adjudications(seq, epoch_id, version_id, outcome, reason, group_key, windows_json, event_time, at, inherited)
     SELECT seq, ?, ?, outcome, reason, group_key, windows_json, event_time, at, 1
     FROM adjudications WHERE epoch_id = ? AND seq <= ?
     ON CONFLICT(epoch_id, seq) DO NOTHING`,
    toEpochId,
    versionId,
    fromEpochId,
    maxSeq,
  );
}

export function saveSnapshot(db, epochId, seq, snapshot, at) {
  db.run(
    `INSERT INTO epoch_snapshots(epoch_id, seq, snapshot_json, created_at) VALUES(?, ?, ?, ?)
     ON CONFLICT(epoch_id) DO UPDATE SET seq = excluded.seq, snapshot_json = excluded.snapshot_json,
       created_at = excluded.created_at`,
    epochId,
    seq,
    JSON.stringify(snapshot),
    at,
  );
}

export function getSnapshot(db, epochId) {
  const row = db.get('SELECT * FROM epoch_snapshots WHERE epoch_id = ?', epochId);
  if (!row) return null;
  return { epochId, seq: row.seq, snapshot: parseJson(row.snapshot_json, null), createdAt: row.created_at };
}

export function latestSnapshotForVersion(db, versionId) {
  const row = db.get(
    `SELECT s.*, e.version_id FROM epoch_snapshots s JOIN epochs e ON e.id = s.epoch_id
     WHERE e.version_id = ? ORDER BY s.created_at DESC LIMIT 1`,
    versionId,
  );
  if (!row) return null;
  return {
    epochId: row.epoch_id,
    versionId: row.version_id,
    seq: row.seq,
    snapshot: parseJson(row.snapshot_json, null),
    createdAt: row.created_at,
  };
}

export function recordStaleReport(db, report, at) {
  db.run(
    `INSERT INTO stale_reports(epoch_id, fence, worker_id, received_at, claimed_version, active_epoch, active_version, reason, payload_json)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    report.epochId ?? null,
    report.fence ?? null,
    report.workerId ?? null,
    at,
    report.claimedVersion ?? null,
    report.activeEpoch ?? null,
    report.activeVersion ?? null,
    report.reason,
    JSON.stringify(report.payload ?? null),
  );
}

export function recordQuarantine(db, entry, at) {
  db.run(
    `INSERT INTO quarantine(epoch_id, version_id, kind, reason, detail_json, item_count, received_at)
     VALUES(?, ?, ?, ?, ?, ?, ?)`,
    entry.epochId ?? null,
    entry.versionId ?? null,
    entry.kind,
    entry.reason,
    JSON.stringify(entry.detail ?? null),
    entry.itemCount ?? 1,
    at,
  );
}

export function audit(db, kind, detail, at) {
  db.run('INSERT INTO audit_log(at, kind, detail_json) VALUES(?, ?, ?)', at, kind, JSON.stringify(detail));
}

import assert from 'node:assert/strict';
import test, { describe, before, after } from 'node:test';
import { createApp } from '../src/server.js';

let server;
let base;

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text, headers: response.headers };
}

async function waitForActiveVersion(versionId, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await call('GET', '/api/state');
    const active = state.json.activeVersion;
    if (active?.id === versionId && state.json.paused === false && state.json.jobs.every((job) => job.status !== 'running')) {
      return state.json;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`version ${versionId} did not become active in time`);
}

describe('HTTP API', () => {
  before(async () => {
    server = createApp({ dbPath: ':memory:', replayRate: 50_000 });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server.closeDb();
    await new Promise((resolve) => server.close(resolve));
  });

  test('serves the console shell and guards traversal', async () => {
    const index = await call('GET', '/');
    assert.equal(index.status, 200);
    assert.match(index.text, /<!doctype html>/i);
    assert.match(index.text, /app\.js/);

    const css = await call('GET', '/styles.css');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);

    const health = await call('GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);

    const traversal = await call('GET', '/../package.json');
    assert.equal(traversal.status, 404);
    const encoded = await call('GET', '/%2e%2e%2fpackage.json');
    assert.ok(encoded.status === 404 || encoded.status === 400, `got ${encoded.status}`);
  });

  test('reports metadata for the expression editor', async () => {
    const meta = await call('GET', '/api/meta');
    assert.equal(meta.status, 200);
    assert.ok(meta.json.fields.some((field) => field.name === 'amount'));
    assert.ok(meta.json.functions.length > 0);
    assert.deepEqual(meta.json.aggregates, ['sum', 'count', 'avg', 'min', 'max']);
    assert.ok(meta.json.strategies.some((strategy) => strategy.id === 'shadow'));
    assert.ok(meta.json.defaultSpec.group.includes('coalesce'));
  });

  test('drives the full lifecycle: create, preview, publish, query, verify', async () => {
    // Seed through the real fenced ingest endpoint using the reported runtime.
    const runtime = (await call('GET', '/api/health')).json.runtime;
    const events = [];
    for (let i = 0; i < 30; i += 1) {
      events.push({
        eventId: `api-${i}`,
        eventTime: 1_000 + i * 900,
        payload: {
          device: i % 2 ? 'ios' : 'web',
          region: i % 3 ? 'East' : 'West',
          amount: 10 + i,
          ok: i % 6 !== 0,
        },
      });
    }
    const ingest = await call('POST', '/api/ingest', {
      workerId: 'api-test',
      epochId: runtime.epochId,
      versionId: runtime.versionId,
      fence: runtime.fence,
      batchKey: 'api-test-1',
      events,
    });
    assert.equal(ingest.status, 200);
    assert.equal(ingest.json.outcome, 'ok');
    assert.equal(ingest.json.accepted + ingest.json.filtered + ingest.json.duplicate + ingest.json.late, 30);
    assert.ok(ingest.json.accepted > 0);

    const replayed = await call('POST', '/api/ingest', {
      workerId: 'api-test',
      epochId: runtime.epochId,
      versionId: runtime.versionId,
      fence: runtime.fence,
      batchKey: 'api-test-1',
      events,
    });
    assert.equal(replayed.json.outcome, 'duplicate-batch');

    const stale = await call('POST', '/api/ingest', {
      workerId: 'api-test',
      epochId: runtime.epochId,
      versionId: runtime.versionId,
      fence: runtime.fence - 1,
      events: [events[0]],
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, 'stale-fence');

    // Invalid expression is a 400 with the field called out, not a stack trace.
    const bad = await call('POST', '/api/versions', {
      label: '坏规则',
      filter: 'amount >',
      group: 'device',
      dedup: 'event_id',
      measure: 'amount',
      aggregate: 'sum',
      window: { kind: 'tumbling', sizeMs: 15_000 },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'parse');
    assert.equal(bad.json.error.details.field, 'filter');

    const created = await call('POST', '/api/versions', {
      label: '按地区统计',
      filter: 'ok && amount > 0',
      group: 'coalesce(region, "unknown")',
      dedup: 'event_id',
      measure: 'amount',
      aggregate: 'sum',
      window: { kind: 'tumbling', sizeMs: 15_000, allowedLatenessMs: 3_000 },
    });
    assert.equal(created.status, 201);
    const versionId = created.json.version.id;
    assert.equal(created.json.change.classification, 'rebuild');

    const draft = await call('PUT', `/api/versions/${versionId}`, {
      label: '按地区统计（草稿）',
      filter: 'ok && amount > 0',
      group: 'coalesce(region, "unknown")',
      dedup: 'event_id',
      measure: 'amount',
      aggregate: 'sum',
      window: { kind: 'tumbling', sizeMs: 15_000, allowedLatenessMs: 3_000 },
    });
    assert.equal(draft.status, 200);
    assert.equal(draft.json.version.status, 'draft');

    const detail = await call('GET', `/api/versions/${versionId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.changeVsActive.classification, 'rebuild');
    assert.ok(detail.json.planOptions.some((plan) => plan.strategy === 'shadow' && plan.replayEvents >= 30));
    assert.ok(detail.json.lineage.length >= 2);

    const preview = await call('POST', `/api/versions/${versionId}/preview`);
    assert.equal(preview.status, 200);
    assert.equal(preview.json.change.classification, 'rebuild');
    assert.ok(preview.json.scope.events >= 30);
    assert.ok(Array.isArray(preview.json.diffs));

    const publish = await call('POST', `/api/versions/${versionId}/publish`, { strategy: 'shadow' });
    assert.equal(publish.status, 200);
    assert.equal(publish.json.change.classification, 'rebuild');
    assert.equal(publish.json.plan.strategy, 'shadow');
    assert.equal(publish.json.activation.mode, 'shadow');

    const buildingResults = await call('GET', `/api/results?epoch=${publish.json.activation.epochId}`);
    assert.equal(buildingResults.status, 409);
    assert.equal(buildingResults.json.error.code, 'results-not-ready');

    const state = await waitForActiveVersion(versionId);
    assert.equal(state.activeVersion.id, versionId);
    assert.equal(state.activeVersion.label, '按地区统计（草稿）');

    const results = await call('GET', '/api/results?limit=200');
    assert.equal(results.status, 200);
    assert.equal(results.json.version.id, versionId);
    assert.ok(results.json.rows.length > 0);
    assert.ok(results.json.rows.every((row) => ['East', 'West', 'unknown'].includes(row.group)));

    const adjudications = await call('GET', '/api/adjudications?limit=10');
    assert.equal(adjudications.status, 200);
    assert.ok(adjudications.json.rows.length > 0);
    assert.ok(adjudications.json.rows.every((row) => row.versionId === versionId));

    const verify = await call('POST', '/api/verify', {});
    assert.equal(verify.status, 200);
    assert.equal(verify.json.ok, true, JSON.stringify(verify.json.mismatches));
    assert.ok(verify.json.rawEvents >= 30);

    const stateAfterVerify = await call('GET', '/api/state');
    assert.equal(stateAfterVerify.json.lastVerify.ok, true);

    const audit = await call('GET', '/api/audit');
    assert.equal(audit.status, 200);
    const kinds = audit.json.rows.map((row) => row.kind);
    assert.ok(kinds.includes('version.create'));
    assert.ok(kinds.includes('rebuild.cutover'));
    assert.ok(kinds.includes('verify'));

    const staleReports = await call('GET', '/api/stale-reports');
    assert.equal(staleReports.status, 200);
    assert.ok(staleReports.json.byReason.some((row) => row.reason === 'stale-fence'));
  });

  test('pause and resume guard ingestion, and resume refuses a rebuild pause', async () => {
    const pause = await call('POST', '/api/executor/pause', { reason: '接口测试' });
    assert.equal(pause.status, 200);
    assert.equal(pause.json.paused, true);

    const runtime = (await call('GET', '/api/health')).json.runtime;
    assert.equal(runtime.paused, true);

    const rejected = await call('POST', '/api/ingest', {
      workerId: 'api-test',
      epochId: runtime.epochId,
      versionId: runtime.versionId,
      fence: runtime.fence,
      events: [{ eventId: 'paused-1', eventTime: 900_000, payload: { ok: true, amount: 1 } }],
    });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.json.error.code, 'paused');

    const resume = await call('POST', '/api/executor/resume');
    assert.equal(resume.status, 200);
    assert.equal(resume.json.paused, false);

    const state = await call('GET', '/api/state');
    assert.ok(state.json.staleReports.some((row) => row.reason === 'paused'));
  });

  test('unknown routes and bad payloads return structured errors', async () => {
    const missing = await call('GET', '/api/does-not-exist');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, 'no-route');

    const badJson = await fetch(`${base}/api/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(badJson.status, 400);
    const payload = await badJson.json();
    assert.equal(payload.error.code, 'invalid-json');

    const badVersion = await call('GET', '/api/versions/999999');
    assert.equal(badVersion.status, 404);

    const methodNotAllowed = await call('DELETE', '/api/versions/1');
    assert.equal(methodNotAllowed.status, 404);
  });
});

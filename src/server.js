/**
 * HTTP API + static file server.
 *
 * No framework: the surface is small and this keeps the "no arbitrary code"
 * story auditable end to end.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from './errors.js';
import { SpecError } from './spec.js';
import { ExprError } from './expr/tokenizer.js';
import { openDatabase } from './db.js';
import { Engine } from './engine/engine.js';
import { FIELD_INFO, FUNCTION_HELP } from './expr/functions.js';
import { SPEC_HELP, SPEC_LIMITS, DEFAULT_SPEC } from './spec.js';
import { Simulator } from './simulator.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const BODY_LIMIT = 512 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function createApp({ dbPath = process.env.DRIFTFIELD_DB ?? join(ROOT, 'data', 'driftfield.db'), now, replayRate } = {}) {
  const db = openDatabase(dbPath);
  const engine = new Engine({ db, ...(now ? { now } : {}), ...(replayRate ? { replayRate } : {}) });
  engine.boot();
  const simulator = new Simulator(engine);
  const server = createServer((request, response) => {
    handle(request, response, { engine, simulator }).catch((error) => {
      sendError(response, error);
    });
  });
  server.engine = engine;
  server.simulator = simulator;
  server.db = db;
  server.closeDb = () => {
    simulator.stop();
    db.close();
  };
  return server;
}

async function handle(request, response, context) {
  const url = new URL(request.url, 'http://localhost');
  const path = url.pathname;

  if (path.startsWith('/api/')) {
    return handleApi(request, response, url, context);
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new AppError(405, 'method-not-allowed', '不支持的请求方法');
  }
  return serveStatic(request, response, path);
}

async function handleApi(request, response, url, { engine, simulator }) {
  const { pathname } = url;
  const method = request.method;
  const segments = pathname.split('/').filter(Boolean); // api, ...

  if (method === 'GET' && pathname === '/api/health') {
    return sendJson(response, 200, { ok: true, runtime: engine.runtime(), serverTime: engine.now() });
  }

  if (method === 'GET' && pathname === '/api/meta') {
    return sendJson(response, 200, {
      fields: Object.entries(FIELD_INFO).map(([name, info]) => ({ name, ...info })),
      functions: FUNCTION_HELP,
      aggregates: SPEC_HELP.aggregates,
      windowKinds: SPEC_HELP.windowKinds,
      limits: { ...SPEC_HELP.limits, ...pick(SPEC_LIMITS, ['label']) },
      strategies: [
        { id: 'shadow', label: '影子追赶', hint: '旧规则持续服务，重建完成后毫秒级切换' },
        { id: 'stop-the-world', label: '停流切换', hint: '冻结上报全量重放，期间新事件被拒绝' },
      ],
      defaultSpec: DEFAULT_SPEC,
      roles: SPEC_HELP.roles,
    });
  }

  if (method === 'GET' && pathname === '/api/state') {
    return sendJson(response, 200, { ...engine.stateView(), simulator: simulator.status() });
  }

  if (pathname === '/api/stream' && method === 'GET') {
    return streamEvents(request, response, engine);
  }

  if (method === 'GET' && pathname === '/api/versions') {
    return sendJson(response, 200, { versions: engine.listVersions() });
  }

  if (method === 'GET' && pathname === '/api/versions/compare') {
    const left = Number(url.searchParams.get('from'));
    const right = Number(url.searchParams.get('to'));
    return sendJson(response, 200, engine.compareVersions(left, right));
  }

  if (method === 'POST' && pathname === '/api/versions') {
    const body = await readJson(request);
    return sendJson(response, 201, engine.createVersion(body));
  }

  if (segments[0] === 'api' && segments[1] === 'versions' && segments[2]) {
    const versionId = Number(segments[2]);
    const rest = segments[3];
    if (method === 'GET' && !rest) {
      return sendJson(response, 200, engine.getVersionDetail(versionId));
    }
    if (method === 'PUT' && !rest) {
      const body = await readJson(request);
      return sendJson(response, 200, engine.updateDraft(versionId, body));
    }
    if (method === 'POST' && rest === 'preview') {
      return sendJson(response, 200, engine.previewVersion(versionId));
    }
    if (method === 'POST' && rest === 'publish') {
      const body = await readJson(request, { optional: true });
      return sendJson(response, 200, engine.publishVersion(versionId, body ?? {}));
    }
  }

  if (method === 'POST' && pathname === '/api/rollback') {
    const body = await readJson(request);
    return sendJson(response, 200, engine.rollback(Number(body.versionId), { strategy: body.strategy }));
  }

  if (method === 'POST' && pathname === '/api/executor/pause') {
    const body = await readJson(request, { optional: true });
    return sendJson(response, 200, engine.pause(body?.reason ?? '操作员暂停'));
  }

  if (method === 'POST' && pathname === '/api/executor/resume') {
    return sendJson(response, 200, engine.resume());
  }

  if (method === 'POST' && pathname === '/api/rebuilds/cancel') {
    const body = await readJson(request);
    return sendJson(response, 200, engine.cancelRebuild(Number(body.jobId)));
  }

  if (method === 'GET' && pathname === '/api/rebuilds') {
    return sendJson(response, 200, { jobs: engine.rebuild.viewJobs(50) });
  }

  if (method === 'POST' && pathname === '/api/rebuilds') {
    const body = await readJson(request);
    return sendJson(response, 200, engine.startManualRebuild(body));
  }

  if (method === 'POST' && pathname === '/api/ingest') {
    const body = await readJson(request);
    return sendJson(response, 200, engine.ingest(body));
  }

  if (method === 'GET' && pathname === '/api/results') {
    return sendJson(
      response,
      200,
      engine.results({
        epochId: intParam(url, 'epoch'),
        limit: intParam(url, 'limit') ?? 100,
        offset: intParam(url, 'offset') ?? 0,
        from: intParam(url, 'from'),
        to: intParam(url, 'to'),
      }),
    );
  }

  if (method === 'GET' && pathname === '/api/adjudications') {
    return sendJson(
      response,
      200,
      engine.adjudications({
        epochId: intParam(url, 'epoch'),
        limit: intParam(url, 'limit') ?? 50,
        before: intParam(url, 'before'),
        outcome: url.searchParams.get('outcome'),
      }),
    );
  }

  if (method === 'GET' && pathname === '/api/events') {
    return sendJson(
      response,
      200,
      engine.rawEvents({ limit: intParam(url, 'limit') ?? 50, before: intParam(url, 'before') }),
    );
  }

  if (method === 'GET' && pathname === '/api/stale-reports') {
    return sendJson(
      response,
      200,
      engine.staleReports({ limit: intParam(url, 'limit') ?? 50, before: intParam(url, 'before') }),
    );
  }

  if (method === 'GET' && pathname === '/api/quarantine') {
    return sendJson(response, 200, engine.quarantine({ limit: intParam(url, 'limit') ?? 50 }));
  }

  if (method === 'GET' && pathname === '/api/audit') {
    return sendJson(response, 200, engine.auditLog({ limit: intParam(url, 'limit') ?? 60 }));
  }

  if (method === 'GET' && pathname === '/api/verify') {
    return sendJson(response, 200, engine.verify({ epochId: intParam(url, 'epoch') }));
  }

  if (method === 'POST' && pathname === '/api/verify') {
    const body = await readJson(request, { optional: true });
    return sendJson(response, 200, engine.verify({ epochId: body?.epochId ? Number(body.epochId) : null }));
  }

  if (pathname === '/api/simulator') {
    if (method === 'GET') return sendJson(response, 200, simulator.status());
    if (method === 'POST') {
      const body = await readJson(request);
      return sendJson(response, 200, simulator.configure(body ?? {}));
    }
  }

  if (method === 'POST' && pathname === '/api/simulator/start') {
    const body = await readJson(request, { optional: true });
    return sendJson(response, 200, simulator.start(body ?? {}));
  }

  if (method === 'POST' && pathname === '/api/simulator/stop') {
    return sendJson(response, 200, simulator.stop());
  }

  if (method === 'POST' && pathname === '/api/simulator/step') {
    const body = await readJson(request, { optional: true });
    return sendJson(response, 200, simulator.step(body ?? {}));
  }

  if (method === 'POST' && pathname === '/api/simulator/legacy-executor') {
    const body = await readJson(request, { optional: true });
    return sendJson(response, 200, simulator.launchLegacyExecutor(body ?? {}));
  }

  if (method === 'POST' && pathname === '/api/admin/reset') {
    await readJson(request, { optional: true });
    return sendJson(response, 200, { requiresRestart: true, note: '清库请删除 data/ 后重启' });
  }

  throw new AppError(404, 'no-route', `未知接口 ${method} ${pathname}`);
}

function intParam(url, name) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function pick(object, keys) {
  const out = {};
  for (const key of keys) out[key] = object[key];
  return out;
}

async function readJson(request, { optional = false } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new AppError(413, 'body-too-large', '请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    if (optional) return null;
    throw new AppError(400, 'empty-body', '请求体不能为空');
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new AppError(400, 'invalid-json', '请求体必须是 JSON 对象');
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendError(response, error) {
  let status = error.status ?? 500;
  let code = error.code ?? 'internal';
  let message = error.message ?? '服务器内部错误';
  let details = error.details;

  if (error instanceof SpecError) {
    status = 400;
    code = error.code;
    details = { field: error.field };
  } else if (error instanceof ExprError) {
    status = 400;
    code = error.code;
    details = { position: error.position };
  } else if (error instanceof AppError) {
    status = error.status;
  } else if (!(error instanceof SpecError) && !(error instanceof ExprError)) {
    message = '服务器内部错误';
  }

  if (status >= 500) console.error('[driftfield]', error);
  if (response.headersSent) {
    response.end();
    return;
  }
  sendJson(response, status, { error: { code, message, details } });
}

async function serveStatic(request, response, pathname) {
  const relative = pathname === '/' ? '/index.html' : pathname;
  const safe = normalize(relative).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR + sep) && filePath !== join(PUBLIC_DIR, 'index.html')) {
    throw new AppError(403, 'forbidden', '禁止访问');
  }
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new AppError(404, 'not-found', '文件不存在');
  }
  if (!info.isFile()) throw new AppError(404, 'not-found', '文件不存在');
  const body = await readFile(filePath);
  response.writeHead(200, {
    'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  if (request.method === 'HEAD') response.end();
  else response.end(body);
}

function streamEvents(request, response, engine) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.write(`event: hello\ndata: ${JSON.stringify({ at: engine.now() })}\n\n`);

  let closed = false;
  const unsubscribe = engine.onEvent((event) => {
    if (closed) return;
    response.write(`event: engine\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => {
    if (!closed) response.write(`: ping ${engine.now()}\n\n`);
  }, 15_000);
  heartbeat.unref?.();

  request.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  });
}

export { ROOT, PUBLIC_DIR };

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  const server = createApp();
  server.listen(port, host, () => {
    console.log(`Driftfield 控制台已启动： http://${host}:${port}`);
  });
  const shutdown = () => {
    server.closeDb?.();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

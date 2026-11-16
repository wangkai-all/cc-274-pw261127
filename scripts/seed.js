#!/usr/bin/env node
/**
 * Seed a local database with a deterministic week of activity so the console
 * has meaningful history to explore. Safe to re-run: events use stable ids and
 * the default window dedups on event_id.
 *
 *   npm run seed                 # data/driftfield.db
 *   npm run seed -- --reset      # delete the db first
 *   npm run seed -- --out x.db --events 2000 --seed 42
 */

import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openDatabase } from '../src/db.js';
import { Engine } from '../src/engine/engine.js';
import { DEFAULT_SPEC } from '../src/spec.js';

function parseArgs(argv) {
  const options = {
    out: resolve(process.cwd(), 'data', 'driftfield.db'),
    events: 1200,
    seed: 7,
    reset: false,
    batchSize: 100,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--reset') options.reset = true;
    else if (arg === '--out') options.out = resolve(process.cwd(), argv[++i]);
    else if (arg === '--events') options.events = Math.max(1, Number(argv[++i]) || options.events);
    else if (arg === '--seed') options.seed = Number(argv[++i]) || options.seed;
    else if (arg === '--batch') options.batchSize = Math.min(5000, Math.max(1, Number(argv[++i]) || 100));
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node scripts/seed.js [--out path] [--events n] [--seed n] [--batch n] [--reset]');
      process.exit(0);
    } else {
      console.error(`未知参数: ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

/** Deterministic xorshift PRNG so every seed run produces the same events. */
function prng(seed) {
  let x = seed || 0x9e3779b9;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0xffffffff;
  };
}

const DEVICES = ['ios', 'android', 'web', 'tablet'];
const REGIONS = ['East', 'West', 'North', 'South'];
const PLANS = ['free', 'pro', 'enterprise'];
const ACTIONS = ['view', 'checkout', 'signup', 'search'];
const CHANNELS = ['organic', 'ads', 'referral'];
const COUNTRIES = ['CN', 'US', 'JP', 'DE'];

function pick(list, rand) {
  return list[Math.floor(rand() * list.length) % list.length];
}

/**
 * Event time walks forward with jitter; a fraction of events are deliberately
 * late (behind the watermark) or duplicated, so the console shows all the
 * adjudication outcomes.
 */
function buildEvents({ count, seed, startTime, lateRate = 0.04, duplicateRate = 0.05 }) {
  const rand = prng(seed);
  const events = [];
  let cursor = startTime;
  for (let i = 0; i < count; i += 1) {
    const late = rand() < lateRate;
    if (late) {
      cursor += 40;
    } else {
      cursor += 300 + Math.floor(rand() * 2200);
    }
    const eventTime = late ? Math.max(1, cursor - 20_000 - Math.floor(rand() * 40_000)) : cursor;
    const duplicate = rand() < duplicateRate;
    const serial = i + 1;
    events.push({
      eventId: duplicate ? `seed-${Math.max(1, serial - 1)}` : `seed-${serial}`,
      eventTime,
      payload: {
        user_id: `u${1 + Math.floor(rand() * 400)}`,
        region: pick(REGIONS, rand),
        plan: pick(PLANS, rand),
        action: pick(ACTIONS, rand),
        amount: Math.round(rand() * 25_000) / 10,
        duration_ms: Math.round(rand() * 900),
        ok: rand() > 0.15,
        device: pick(DEVICES, rand),
        channel: pick(CHANNELS, rand),
        country: pick(COUNTRIES, rand),
      },
    });
  }
  return events;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.reset) {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${options.out}${suffix}`, { force: true });
    }
  }

  const db = openDatabase(options.out);
  const engine = new Engine({ db, replayRate: 200_000, chunkSize: 500 });
  engine.boot();

  const now = Date.now();
  const spanMs = 7 * 24 * 60 * 60 * 1000;
  const events = buildEvents({
    count: options.events,
    seed: options.seed,
    startTime: now - spanMs,
  });

  const startedAt = Date.now();
  let accepted = 0;
  let closed = 0;
  let filtered = 0;
  let duplicates = 0;
  let late = 0;
  for (let offset = 0; offset < events.length; offset += options.batchSize) {
    const batch = events.slice(offset, offset + options.batchSize);
    const runtime = engine.runtime();
    const result = engine.ingest({
      workerId: 'seed',
      epochId: runtime.epochId,
      versionId: runtime.versionId,
      fence: runtime.fence,
      events: batch,
    });
    accepted += result.accepted ?? 0;
    filtered += result.filtered ?? 0;
    duplicates += result.duplicate ?? 0;
    late += result.late ?? 0;
    closed += result.closed ?? 0;
  }

  const verify = engine.verify();
  const state = engine.stateView();
  const elapsed = Date.now() - startedAt;

  console.log(`数据库: ${options.out}`);
  console.log(`规则:   v${engine.active.version.id} ${engine.active.version.label} (${DEFAULT_SPEC.aggregate})`);
  console.log(`事件:   ${events.length} 条，用时 ${elapsed}ms`);
  console.log(`判定:   接受 ${accepted} / 过滤 ${filtered} / 重复 ${duplicates} / 迟到 ${late}`);
  console.log(`结果:   ${closed} 个窗口关闭，${state.openWindows} 个窗口仍打开`);
  console.log(`核对:   ${verify.ok ? '通过' : `失败（${verify.mismatchCount} 处差异）`}，比对 ${verify.matched} 个窗口`);
  console.log(`\n启动控制台: DRIFTFIELD_DB=${options.out} npm start`);
  db.close();
  if (!verify.ok) process.exitCode = 1;
}

main();

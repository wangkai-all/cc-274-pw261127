/**
 * Simulated event source and a deliberately stale "legacy executor".
 *
 * The simulator exists so the console can be driven end to end without an
 * external feed. The legacy executor captures a runtime credential snapshot at
 * launch and keeps reporting with it; after a publish its reports must be
 * rejected and archived, never merged into the active result.
 */

import { FIELD_INFO } from './expr/functions.js';

const REGIONS = ['East', 'West', 'North', 'South'];
const PLANS = ['free', 'pro', 'enterprise'];
const ACTIONS = ['view', 'checkout', 'signup', 'search'];
const DEVICES = ['ios', 'android', 'web', 'tablet'];
const CHANNELS = ['organic', 'ads', 'referral'];
const COUNTRIES = ['CN', 'US', 'JP', 'DE'];

const DEFAULTS = Object.freeze({
  tickMs: 800,
  batchSize: 6,
  stepMs: 1200,
  duplicateRate: 0.05,
  lateRate: 0.04,
});

function rand(seedRef) {
  // Deterministic xorshift so demo runs are reproducible from a seed.
  let x = seedRef.value || 0x9e3779b9;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  seedRef.value = x >>> 0;
  return seedRef.value / 0xffffffff;
}

function pick(list, seedRef) {
  return list[Math.floor(rand(seedRef) * list.length) % list.length];
}

export class Simulator {
  constructor(engine) {
    this.engine = engine;
    this.config = { ...DEFAULTS };
    this.timer = null;
    this.seed = { value: 123456789 };
    this.cursorTime = null;
    this.running = false;
    this.sent = 0;
    this.legacy = null;
    this.lastError = null;
    this.autoSeeded = false;
  }

  ensureClock() {
    if (this.cursorTime !== null) return;
    const latest = this.engine.db.get('SELECT COALESCE(MAX(event_time), 0) AS t FROM raw_events').t;
    this.cursorTime = latest > 0 ? latest : this.engine.now();
  }

  configure(patch) {
    const next = { ...this.config };
    const clampInt = (value, min, max, fallback) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, Math.round(n)));
    };
    if (patch.tickMs !== undefined) next.tickMs = clampInt(patch.tickMs, 100, 60_000, next.tickMs);
    if (patch.batchSize !== undefined) next.batchSize = clampInt(patch.batchSize, 1, 200, next.batchSize);
    if (patch.stepMs !== undefined) next.stepMs = clampInt(patch.stepMs, 100, 60_000, next.stepMs);
    if (patch.duplicateRate !== undefined) {
      next.duplicateRate = Math.min(0.9, Math.max(0, Number(patch.duplicateRate) || 0));
    }
    if (patch.lateRate !== undefined) next.lateRate = Math.min(0.9, Math.max(0, Number(patch.lateRate) || 0));
    this.config = next;
    return this.status();
  }

  generate(batchSize = this.config.batchSize) {
    this.ensureClock();
    const out = [];
    for (let i = 0; i < batchSize; i += 1) {
      const roll = rand(this.seed);
      let eventTime = this.cursorTime;
      if (roll < this.config.lateRate) {
        // Late: deliberately behind the watermark by 10-40s.
        eventTime = this.cursorTime - 10_000 - Math.floor(rand(this.seed) * 30_000);
      } else {
        this.cursorTime += Math.floor(rand(this.seed) * this.config.stepMs) + 50;
        eventTime = this.cursorTime;
      }
      const duplicate = rand(this.seed) < this.config.duplicateRate;
      const serial = this.sent + i + 1;
      const payload = {
        user_id: `u${1 + Math.floor(rand(this.seed) * 400)}`,
        region: pick(REGIONS, this.seed),
        plan: pick(PLANS, this.seed),
        action: pick(ACTIONS, this.seed),
        amount: Math.round(rand(this.seed) * 25_000) / 10,
        duration_ms: Math.round(rand(this.seed) * 900),
        ok: rand(this.seed) > 0.15,
        device: pick(DEVICES, this.seed),
        channel: pick(CHANNELS, this.seed),
        country: pick(COUNTRIES, this.seed),
      };
      out.push({
        eventId: duplicate ? `sim-${Math.max(1, serial - 1)}` : `sim-${serial}`,
        eventTime: Math.round(eventTime),
        payload,
      });
    }
    this.sent += batchSize;
    return out;
  }

  /** Send one batch through the real fenced ingest path. */
  step({ batchSize = this.config.batchSize, source = 'simulator', credentials = null } = {}) {
    const events = this.generate(batchSize);
    const runtime = this.engine.runtime();
    const claim = credentials ?? {
      workerId: source,
      epochId: runtime.epochId,
      versionId: runtime.versionId,
      fence: runtime.fence,
    };
    try {
      const result = this.engine.ingest({
        ...claim,
        workerId: source,
        batchKey: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        events,
      });
      this.lastError = null;
      return { outcome: result.outcome, accepted: result.accepted, closed: result.closed, runtime: result.runtime };
    } catch (error) {
      this.lastError = { code: error.code, message: error.message, at: this.engine.now() };
      return { outcome: 'rejected', error: { code: error.code, message: error.message }, runtime: this.engine.runtime() };
    }
  }

  start(patch = {}) {
    this.configure(patch);
    if (this.running) return this.status();
    this.running = true;
    this.autoSeeded = false;
    const tick = () => {
      if (!this.running) return;
      try {
        this.step({ batchSize: this.config.batchSize, source: 'simulator' });
      } catch (error) {
        this.lastError = { code: 'simulator', message: String(error?.message ?? error), at: this.engine.now() };
      }
      if (this.running) this.timer = setTimeout(tick, this.config.tickMs);
    };
    this.timer = setTimeout(tick, this.config.tickMs);
    this.timer.unref?.();
    return this.status();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.legacy) {
      this.legacy.running = false;
      if (this.legacy.timer) clearTimeout(this.legacy.timer);
      this.legacy.timer = null;
    }
    return this.status();
  }

  /**
   * Launch a legacy executor that captures current credentials and keeps
   * reporting them. After a publish every report fails with stale-fence,
   * which is exactly what must not enter current results.
   */
  launchLegacyExecutor({ tickMs = 700, batchSize = 3, label = '旧执行器' } = {}) {
    const runtime = this.engine.runtime();
    if (this.legacy?.timer) clearTimeout(this.legacy.timer);
    const legacy = {
      label,
      workerId: `legacy-${runtime.versionId}-${runtime.epochId}`,
      credentials: {
        epochId: runtime.epochId,
        versionId: runtime.versionId,
        fence: runtime.fence,
      },
      launchedAt: this.engine.now(),
      attempts: 0,
      rejected: 0,
      accepted: 0,
      lastCode: null,
      tickMs: Math.min(10_000, Math.max(200, tickMs)),
      batchSize: Math.min(50, Math.max(1, batchSize)),
      running: true,
      timer: null,
    };
    const tick = () => {
      if (!legacy.running) return;
      legacy.attempts += 1;
      const result = this.step({
        batchSize: legacy.batchSize,
        source: legacy.workerId,
        credentials: legacy.credentials,
      });
      if (result.outcome === 'rejected') {
        legacy.rejected += 1;
        legacy.lastCode = result.error.code;
      } else {
        legacy.accepted += 1;
      }
      if (legacy.running) legacy.timer = setTimeout(tick, legacy.tickMs);
    };
    legacy.timer = setTimeout(tick, legacy.tickMs);
    legacy.timer.unref?.();
    this.legacy = legacy;
    return this.status();
  }

  status() {
    const latest = this.engine.db.get('SELECT COALESCE(MAX(event_time), 0) AS t FROM raw_events').t;
    return {
      running: this.running,
      config: { ...this.config },
      sent: this.sent,
      cursorEventTime: this.cursorTime,
      latestEventTime: latest,
      lastError: this.lastError,
      legacy: this.legacy
        ? {
            label: this.legacy.label,
            workerId: this.legacy.workerId,
            credentials: this.legacy.credentials,
            attempts: this.legacy.attempts,
            accepted: this.legacy.accepted,
            rejected: this.legacy.rejected,
            lastCode: this.legacy.lastCode,
            running: this.legacy.running,
          }
        : null,
    };
  }
}

export const SIMULATOR_FIELDS = Object.keys(FIELD_INFO);

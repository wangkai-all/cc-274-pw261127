import { openDatabase } from '../src/db.js';
import { Engine } from '../src/engine/engine.js';
import { DEFAULT_SPEC } from '../src/spec.js';

export function makeEngine({ replayRate = 200_000, chunkSize = 50 } = {}) {
  const db = openDatabase(':memory:');
  const engine = new Engine({ db, replayRate, chunkSize });
  engine.boot();
  return { engine, db, close: () => db.close() };
}

let serial = 0;

export function event(overrides = {}) {
  serial += 1;
  return {
    eventId: overrides.eventId ?? `evt-${serial}`,
    eventTime: overrides.eventTime ?? 1000,
    payload: {
      device: 'ios',
      region: 'East',
      amount: 100,
      ok: true,
      ...overrides.payload,
    },
  };
}

export function push(engine, events, extra = {}) {
  const runtime = engine.runtime();
  return engine.ingest({
    workerId: extra.workerId ?? 'tester',
    epochId: extra.epochId ?? runtime.epochId,
    versionId: extra.versionId ?? runtime.versionId,
    fence: extra.fence ?? runtime.fence,
    events: Array.isArray(events) ? events : [events],
  });
}

export function seed(engine, batches = 4, size = 20, step = 1000) {
  for (let batch = 0; batch < batches; batch += 1) {
    const events = [];
    for (let i = 0; i < size; i += 1) {
      events.push(
        event({
          eventTime: 1000 + (batch * size + i) * step,
          payload: {
            device: i % 2 ? 'ios' : 'android',
            region: i % 3 ? 'East' : 'West',
            amount: 10 + i,
            ok: i % 7 !== 0,
          },
        }),
      );
    }
    push(engine, events);
  }
}

export function specWith(engine, patch) {
  return { ...engine.active.version.spec, ...patch };
}

export { DEFAULT_SPEC };

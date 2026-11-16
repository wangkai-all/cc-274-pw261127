/**
 * SQLite access layer.
 *
 * All derived state is epoch-scoped. `results` and `adjudications` rows carry
 * the epoch they belong to, which is how a retired executor's late writes are
 * kept out of the active result set.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA } from './schema.js';

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec(SCHEMA);
  return new Database(raw);
}

let SAVEPOINT_COUNTER = 0;

class Database {
  constructor(raw) {
    this.raw = raw;
    this.statements = new Map();
  }

  prepare(sql) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.raw.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  exec(sql) {
    this.raw.exec(sql);
  }

  run(sql, ...params) {
    const result = this.prepare(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  get(sql, ...params) {
    return this.prepare(sql).get(...params) ?? null;
  }

  all(sql, ...params) {
    return this.prepare(sql).all(...params);
  }

  transaction(fn) {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.raw.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        // A failed rollback means the transaction already ended; surface the
        // original error rather than the bookkeeping one.
      }
      throw error;
    }
  }

  /** Nested-safe write scope. Used for per-batch transactional ingestion. */
  savepoint(fn) {
    SAVEPOINT_COUNTER += 1;
    const name = `sp_${SAVEPOINT_COUNTER}`;
    this.raw.exec(`SAVEPOINT ${name}`);
    try {
      const value = fn();
      this.raw.exec(`RELEASE ${name}`);
      return value;
    } catch (error) {
      try {
        this.raw.exec(`ROLLBACK TO ${name}`);
        this.raw.exec(`RELEASE ${name}`);
      } catch {
        // Ignore unwind failures; the caller sees the original error.
      }
      throw error;
    }
  }

  close() {
    for (const statement of this.statements.values()) {
      try {
        statement.finalize?.();
      } catch {
        // Statements are finalized with the connection in most cases.
      }
    }
    this.statements.clear();
    this.raw.close();
  }
}

export function nowMs() {
  return Date.now();
}

export function json(value) {
  return JSON.stringify(value);
}

export function parseJson(text, fallback = null) {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export const LIMITS = Object.freeze({
  batchEvents: 5000,
  payloadBytes: 8 * 1024,
  pageSize: 200,
});

export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

import { existsSync } from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from '../../src/db/migrations.js';
import { Store } from '../../src/db/store.js';

export type DbState =
  | { ok: true; store: Store; path: string }
  | { ok: false; path: string; reason: 'missing' | 'schema' | 'error'; detail: string };

export function dbPath(): string {
  return process.env.DB_PATH ?? path.resolve(process.cwd(), '..', 'data', 'orderflow.db');
}

const g = globalThis as unknown as { __dash_store?: { path: string; store: Store } };

/**
 * Opens the collector's SQLite file read-only (one cached handle per process). The dashboard can never
 * write to it, create it, or migrate it, so it cannot interfere with the collector.
 */
export function openDb(): DbState {
  const p = dbPath();
  if (!existsSync(p)) {
    g.__dash_store = undefined;
    return { ok: false, path: p, reason: 'missing', detail: 'No database file yet. Start the collector (`npm run collect`) or seed demo data (`npm run seed-synthetic`).' };
  }
  try {
    if (!g.__dash_store || g.__dash_store.path !== p) g.__dash_store = { path: p, store: new Store(p, 'live', { readOnly: true }) };
    const v = g.__dash_store.store.schemaVersion;
    if (v < MIGRATIONS.length) {
      return { ok: false, path: p, reason: 'schema', detail: `Database schema is v${v}, this version needs v${MIGRATIONS.length}. Run the collector (or any \`npm run\` command that opens the DB) once to migrate it.` };
    }
    return { ok: true, store: g.__dash_store.store, path: p };
  } catch (e) {
    g.__dash_store = undefined;
    return { ok: false, path: p, reason: 'error', detail: (e as Error).message };
  }
}

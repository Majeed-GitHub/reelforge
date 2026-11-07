import { getDb } from '../../core/src/db.ts';

/**
 * Thin typed wrappers around node:sqlite's prepared statements.
 *
 * The driver is synchronous and `DatabaseSync` is a singleton (see core/db.ts),
 * so every service in the API can use these without passing a handle around.
 */
export type SqlParam = string | number | bigint | null | Uint8Array;

export function one<T>(sql: string, ...params: SqlParam[]): T | undefined {
  const stmt = getDb().prepare(sql) as unknown as {
    get: (...p: SqlParam[]) => unknown;
  };
  return stmt.get(...params) as T | undefined;
}

export function many<T>(sql: string, ...params: SqlParam[]): T[] {
  const stmt = getDb().prepare(sql) as unknown as {
    all: (...p: SqlParam[]) => unknown[];
  };
  return stmt.all(...params) as T[];
}

/** Returns the number of changed rows (SQLite reports bigint). */
export function run(sql: string, ...params: SqlParam[]): number {
  const stmt = getDb().prepare(sql) as unknown as {
    run: (...p: SqlParam[]) => { changes: number | bigint };
  };
  return Number(stmt.run(...params).changes);
}

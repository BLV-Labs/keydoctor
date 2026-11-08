// A D1Database stand-in backed by node:sqlite, with the real migrations applied.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { D1Database, D1PreparedStatement } from "../../src/env.ts";

export interface TestD1 extends D1Database {
  /** Every SQL statement run, in order. */
  log: string[];
  raw: DatabaseSync;
}

export function testD1(): TestD1 {
  const raw = new DatabaseSync(":memory:");
  const dir = join(import.meta.dirname, "..", "..", "migrations");
  for (const f of readdirSync(dir).sort()) raw.exec(readFileSync(join(dir, f), "utf8"));
  const log: string[] = [];
  const pending = new WeakMap<D1PreparedStatement, { query: string; values: unknown[] }>();
  const statement = (query: string, values: unknown[]): D1PreparedStatement => {
    const s: D1PreparedStatement = {
      bind: (...v: unknown[]) => statement(query, v),
      first: async <T>() => {
        log.push(query);
        return (raw.prepare(query).get(...(values as never[])) as T | undefined) ?? null;
      },
      all: async <T>() => {
        log.push(query);
        return { results: raw.prepare(query).all(...(values as never[])) as T[] };
      },
      run: async () => {
        log.push(query);
        return raw.prepare(query).run(...(values as never[]));
      },
    };
    pending.set(s, { query, values });
    return s;
  };
  // One log entry per batch: D1 sends a batch as one subrequest, in one transaction.
  const batch = async (statements: D1PreparedStatement[]) => {
    const parts = statements.map((st) => pending.get(st)!);
    log.push(parts.map((p) => p.query).join("; "));
    raw.exec("BEGIN");
    try {
      const out = parts.map((p) => raw.prepare(p.query).run(...(p.values as never[])));
      raw.exec("COMMIT");
      return out;
    } catch (e) {
      raw.exec("ROLLBACK");
      throw e;
    }
  };
  return { log, raw, prepare: (query: string) => statement(query, []), batch };
}

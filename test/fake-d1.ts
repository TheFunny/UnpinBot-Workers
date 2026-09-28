//! Minimal in-memory D1 double covering exactly the statements src/state.ts
//! runs. Not a SQL engine — it dispatches on statement shape.

export interface FakeD1 {
  db: D1Database;
  rows: Set<number>;
  /** Every statement prepared, in order — how the round-trip cost of a
   * state operation is asserted. */
  statements: string[];
  /** When true, inserts fail like an unavailable database. */
  failInserts: boolean;
}

export function fakeD1(): FakeD1 {
  const rows = new Set<number>();
  const fake: FakeD1 = {
    rows,
    statements: [],
    failInserts: false,
    db: undefined as unknown as D1Database,
  };

  const result = (changes: number) => ({ meta: { changes } });

  const statement = (sql: string, params: number[]) => ({
    first: async (): Promise<{ enabled: number } | null> => {
      fake.statements.push(sql);
      if (!sql.startsWith("SELECT")) {
        throw new Error(`fakeD1: first() on non-SELECT: ${sql}`);
      }
      const id = params[0];
      return id !== undefined && rows.has(id) ? { enabled: 1 } : null;
    },
    run: async () => {
      fake.statements.push(sql);
      if (sql.startsWith("CREATE")) return result(0);
      if (sql.startsWith("INSERT OR IGNORE")) {
        if (fake.failInserts) throw new Error("D1_ERROR: I/O error");
        const id = params[0];
        if (id === undefined) throw new Error("fakeD1: INSERT without id");
        if (rows.has(id)) return result(0);
        rows.add(id);
        return result(1);
      }
      if (sql.startsWith("DELETE")) {
        const id = params[0];
        if (id === undefined) throw new Error("fakeD1: DELETE without id");
        return result(rows.delete(id) ? 1 : 0);
      }
      throw new Error(`fakeD1: unhandled statement: ${sql}`);
    },
  });

  fake.db = {
    prepare(sql: string) {
      // Unbound too: real D1 runs a parameterless statement directly
      // (ensureTable's CREATE TABLE), which the fake used to reject.
      return {
        ...statement(sql, []),
        bind: (...params: number[]) => statement(sql, params),
      };
    },
    async batch(stmts: Array<{ run(): Promise<unknown> }>) {
      const results: unknown[] = [];
      for (const stmt of stmts) results.push(await stmt.run());
      return results;
    },
  } as unknown as D1Database;

  return fake;
}

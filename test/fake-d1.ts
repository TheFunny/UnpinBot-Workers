//! Minimal in-memory D1 double covering exactly the statements src/state.ts
//! runs. Not a SQL engine — it dispatches on statement shape.

export interface FakeD1 {
  db: D1Database;
  rows: Set<number>;
  /** When true, plain INSERTs fail like an unavailable database. */
  failInserts: boolean;
}

export function fakeD1(): FakeD1 {
  const rows = new Set<number>();
  const fake: FakeD1 = {
    rows,
    failInserts: false,
    db: undefined as unknown as D1Database,
  };

  const statement = (sql: string, params: number[]) => ({
    first: async (): Promise<{ enabled: number } | null> => {
      if (!sql.startsWith("SELECT")) {
        throw new Error(`fakeD1: first() on non-SELECT: ${sql}`);
      }
      const id = params[0];
      return id !== undefined && rows.has(id) ? { enabled: 1 } : null;
    },
    run: async () => {
      if (sql.startsWith("CREATE")) return {};
      if (sql.startsWith("INSERT OR IGNORE")) {
        const id = params[0];
        if (id !== undefined) rows.add(id);
        return {};
      }
      if (sql.startsWith("INSERT INTO")) {
        if (fake.failInserts) throw new Error("D1_ERROR: I/O error");
        const id = params[0];
        if (id === undefined) throw new Error("fakeD1: INSERT without id");
        if (rows.has(id)) {
          throw new Error(
            "D1_ERROR: UNIQUE constraint failed: enabled_chats.chat_id",
          );
        }
        rows.add(id);
        return {};
      }
      if (sql.startsWith("DELETE")) {
        const id = params[0];
        if (id !== undefined) rows.delete(id);
        return {};
      }
      throw new Error(`fakeD1: unhandled statement: ${sql}`);
    },
  });

  fake.db = {
    prepare(sql: string) {
      return { bind: (...params: number[]) => statement(sql, params) };
    },
    async batch(stmts: Array<{ run(): Promise<unknown> }>) {
      const results: unknown[] = [];
      for (const stmt of stmts) results.push(await stmt.run());
      return results;
    },
  } as unknown as D1Database;

  return fake;
}

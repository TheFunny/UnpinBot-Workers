//! Enabled-chat persistence backed by a D1 table — the Workers replacement
//! for the Rust release's state.json, with the same set semantics.

const CREATE_TABLE =
  "CREATE TABLE IF NOT EXISTS enabled_chats (chat_id INTEGER PRIMARY KEY NOT NULL)";
const SELECT_ONE = "SELECT 1 AS enabled FROM enabled_chats WHERE chat_id = ?";
const INSERT = "INSERT INTO enabled_chats (chat_id) VALUES (?)";
const INSERT_OR_IGNORE =
  "INSERT OR IGNORE INTO enabled_chats (chat_id) VALUES (?)";
const DELETE = "DELETE FROM enabled_chats WHERE chat_id = ?";

/** Creates the state table. Called by POST /register, never on the hot path. */
export async function ensureTable(db: D1Database): Promise<void> {
  await db.prepare(CREATE_TABLE).run();
}

/** Whether `chatId` has auto-unpin enabled — the one read per channel post. */
export async function has(db: D1Database, chatId: number): Promise<boolean> {
  return (await db.prepare(SELECT_ONE).bind(chatId).first()) !== null;
}

/** Adds `chatId`; resolves false when it was already present (the caller
 * answers "already enabled"), rejects when D1 itself failed (the caller
 * answers retry_later). Nothing to roll back: a failed INSERT changes
 * nothing, and a lost race means another isolate already inserted the id. */
export async function insert(
  db: D1Database,
  chatId: number,
): Promise<boolean> {
  if (await has(db, chatId)) return false;
  try {
    await db.prepare(INSERT).bind(chatId).run();
    return true;
  } catch (err) {
    if (String(err).includes("UNIQUE constraint")) return false;
    throw err;
  }
}

/** Removes `chatId`; false when it was not enabled. */
export async function remove(db: D1Database, chatId: number): Promise<boolean> {
  if (!(await has(db, chatId))) return false;
  await db.prepare(DELETE).bind(chatId).run();
  return true;
}

/** Moves an enabled entry across a group→supergroup migration; false when
 * `oldId` was not enabled (`newId` untouched in that case).
 *
 * Inserts the new id before deleting the old one: if anything fails between
 * the two, unpinning keeps working on the new id and only a harmless stale
 * row remains. The opposite order could leave the chat silent forever — the
 * failure mode the Rust release guarded with its deliberately un-rolled-back
 * move. */
export async function replace(
  db: D1Database,
  oldId: number,
  newId: number,
): Promise<boolean> {
  if (!(await has(db, oldId))) return false;
  await db.batch([
    db.prepare(INSERT_OR_IGNORE).bind(newId),
    db.prepare(DELETE).bind(oldId),
  ]);
  return true;
}

/** Bulk-imports chat ids from the old state.json (POST /register body). */
export async function importChats(
  db: D1Database,
  chatIds: readonly number[],
): Promise<void> {
  if (chatIds.length === 0) return;
  await db.batch(chatIds.map((id) => db.prepare(INSERT_OR_IGNORE).bind(id)));
}

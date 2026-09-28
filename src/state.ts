//! Enabled-chat persistence backed by a D1 table — the Workers replacement
//! for the Rust release's state.json, with the same set semantics.

const CREATE_TABLE =
  "CREATE TABLE IF NOT EXISTS enabled_chats (chat_id INTEGER PRIMARY KEY NOT NULL)";
const SELECT_ONE = "SELECT 1 AS enabled FROM enabled_chats WHERE chat_id = ?";
const INSERT_OR_IGNORE = "INSERT OR IGNORE INTO enabled_chats (chat_id) VALUES (?)";
const DELETE = "DELETE FROM enabled_chats WHERE chat_id = ?";

/** Creates the state table. Called by POST /register, never on the hot path. */
export async function ensureTable(db: D1Database): Promise<void> {
  await db.prepare(CREATE_TABLE).run();
}

/** Whether `chatId` has auto-unpin enabled — the one read per channel post. */
export async function has(db: D1Database, chatId: number): Promise<boolean> {
  return (await db.prepare(SELECT_ONE).bind(chatId).first()) !== null;
}

/** Adds `chatId`; false when it was already present (the caller answers
 * "already enabled"). One statement, one round trip: the write reports
 * whether it changed a row, so no read has to precede it, and a lost race
 * is just another no-op. A D1 failure still rejects, and changes nothing. */
export async function insert(db: D1Database, chatId: number): Promise<boolean> {
  const result = await db.prepare(INSERT_OR_IGNORE).bind(chatId).run();
  return result.meta.changes === 1;
}

/** Removes `chatId`; false when it was not enabled. Racing disables of one
 * chat resolve as one removal and one no-op, instead of both answering
 * "disabled". */
export async function remove(db: D1Database, chatId: number): Promise<boolean> {
  const result = await db.prepare(DELETE).bind(chatId).run();
  return result.meta.changes === 1;
}

/** Moves an enabled entry across a group→supergroup migration; false when
 * `oldId` was not enabled (`newId` untouched in that case).
 *
 * Inserts the new id before deleting the old one: if anything fails between
 * the two, unpinning keeps working on the new id and only a harmless stale
 * row remains. The opposite order could leave the chat silent forever — the
 * failure mode the Rust release guarded with its deliberately un-rolled-back
 * move.
 *
 * The membership read stays here, unlike insert/remove: a group upgrade
 * happens once in the life of a chat, and a conditional insert would trade
 * a saved round trip for a subtler statement to preserve the same answer. */
export async function replace(db: D1Database, oldId: number, newId: number): Promise<boolean> {
  if (!(await has(db, oldId))) return false;
  await db.batch([db.prepare(INSERT_OR_IGNORE).bind(newId), db.prepare(DELETE).bind(oldId)]);
  return true;
}

/** Bulk-imports chat ids from the old state.json (POST /register body). */
export async function importChats(db: D1Database, chatIds: readonly number[]): Promise<void> {
  if (chatIds.length === 0) return;
  await db.batch(chatIds.map((id) => db.prepare(INSERT_OR_IGNORE).bind(id)));
}

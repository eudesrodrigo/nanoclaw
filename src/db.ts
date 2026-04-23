/**
 * WhatsApp channel compatibility shim.
 *
 * The WhatsApp channel adapter (src/channels/whatsapp.ts) needs a small set
 * of helpers for group-sync tracking and reply-context lookup. These live here
 * rather than in src/db/ to keep channel-specific state separate from the
 * central entity model.
 *
 * All functions use the central DB connection (getDb()) and lazily create
 * their own tables on first use via ensureWhatsappTables().
 */
import { getDb } from './db/connection.js';

let tablesEnsured = false;

function ensureWhatsappTables(): void {
  if (tablesEnsured) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_chat_meta (
      jid              TEXT PRIMARY KEY,
      name             TEXT,
      last_sync_time   TEXT
    );
    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id       TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      content  TEXT NOT NULL,
      PRIMARY KEY (id, chat_jid)
    );
  `);
  tablesEnsured = true;
}

/** Returns the ISO timestamp of the last group metadata sync, or null. */
export function getLastGroupSync(): string | null {
  ensureWhatsappTables();
  const row = getDb()
    .prepare(
      `SELECT last_sync_time FROM whatsapp_chat_meta WHERE jid = '__group_sync__'`,
    )
    .get() as { last_sync_time: string } | undefined;
  return row?.last_sync_time ?? null;
}

/** Records the current time as the last group metadata sync timestamp. */
export function setLastGroupSync(): void {
  ensureWhatsappTables();
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO whatsapp_chat_meta (jid, name, last_sync_time)
       VALUES ('__group_sync__', '__group_sync__', ?)`,
    )
    .run(new Date().toISOString());
}

/** Updates (or inserts) the display name for a WhatsApp chat JID. */
export function updateChatName(jid: string, name: string): void {
  ensureWhatsappTables();
  getDb()
    .prepare(
      `INSERT INTO whatsapp_chat_meta (jid, name) VALUES (?, ?)
       ON CONFLICT(jid) DO UPDATE SET name = excluded.name`,
    )
    .run(jid, name);
}

/**
 * Look up stored message content by Baileys message ID + chat JID.
 * Used to populate quoted-message context for reply rendering.
 * Returns undefined if the message was never stored (e.g. arrived before
 * NanoClaw started, or was pruned).
 */
export function getMessageContentById(
  id: string,
  chatJid: string,
): string | undefined {
  ensureWhatsappTables();
  const row = getDb()
    .prepare(
      `SELECT content FROM whatsapp_messages WHERE id = ? AND chat_jid = ?`,
    )
    .get(id, chatJid) as { content: string } | undefined;
  return row?.content;
}

/**
 * Store message content for later reply-context lookup.
 * Called by the WhatsApp adapter for every inbound message so that quoted
 * replies can be resolved later via getMessageContentById().
 */
export function storeWhatsappMessage(
  id: string,
  chatJid: string,
  content: string,
): void {
  ensureWhatsappTables();
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO whatsapp_messages (id, chat_jid, content) VALUES (?, ?, ?)`,
    )
    .run(id, chatJid, content);
}

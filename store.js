let Database;
let useMemoryStore = false;

try {
  ({ default: Database } = await import('better-sqlite3'));
} catch (error) {
  console.warn(`better-sqlite3 not available (${error.message}); using in-memory history store.`);
  useMemoryStore = true;
}

const DB_PATH = './history.db';
const DEFAULT_KEEP = Number.isInteger(Number.parseInt(process.env.HISTORY_LIMIT ?? '', 10))
  ? Math.max(1, Number.parseInt(process.env.HISTORY_LIMIT, 10))
  : 20;

let db;
let insertStmt;
let trimStmt;
let selectStmt;
let clearStmt;

const memoryStore = new Map();

function normalizeCount(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeId(value) {
  return value ?? null;
}

function getMemoryKey(userId, guildId, channelId) {
  return `${userId}|${guildId ?? ''}|${channelId ?? ''}`;
}

function initDatabase() {
  if (useMemoryStore || !Database) {
    useMemoryStore = true;
    return;
  }
  try {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS messages(
      user_id TEXT NOT NULL,
      guild_id TEXT,
      channel_id TEXT,
      role TEXT CHECK(role IN('user','assistant')) NOT NULL,
      content TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_user_guild_chan_ts
      ON messages(user_id, guild_id, channel_id, ts);`);

    insertStmt = db.prepare(`INSERT INTO messages(user_id, guild_id, channel_id, role, content, ts)
      VALUES (@user_id, @guild_id, @channel_id, @role, @content, @ts)`);

    trimStmt = db.prepare(`DELETE FROM messages
      WHERE rowid IN (
        SELECT rowid FROM messages
        WHERE user_id = @user_id
          AND ((@guild_id IS NULL AND guild_id IS NULL) OR guild_id = @guild_id)
          AND ((@channel_id IS NULL AND channel_id IS NULL) OR channel_id = @channel_id)
        ORDER BY ts DESC, rowid DESC
        LIMIT -1 OFFSET @keep
      )`);

    selectStmt = db.prepare(`SELECT role, content, ts FROM messages
      WHERE user_id = @user_id
        AND ((@guild_id IS NULL AND guild_id IS NULL) OR guild_id = @guild_id)
        AND ((@channel_id IS NULL AND channel_id IS NULL) OR channel_id = @channel_id)
      ORDER BY ts DESC, rowid DESC
      LIMIT @limit`);

    clearStmt = db.prepare(`DELETE FROM messages
      WHERE user_id = @user_id
        AND ((@guild_id IS NULL AND guild_id IS NULL) OR guild_id = @guild_id)
        AND ((@channel_id IS NULL AND channel_id IS NULL) OR channel_id = @channel_id)`);

    console.log(`Using SQLite history, last=${DEFAULT_KEEP} per user/channel.`);
  } catch (error) {
    console.error(`Failed to initialize SQLite history store, falling back to in-memory store: ${error.message}`);
    useMemoryStore = true;
  }
}

initDatabase();

export const isSQLiteStore = () => !useMemoryStore;

export function pushMessage({ userId, guildId, channelId, role, content, keep = DEFAULT_KEEP }) {
  const normalizedKeep = normalizeCount(keep, DEFAULT_KEEP);
  const entry = {
    role,
    content,
    ts: Date.now()
  };

  const normalizedGuildId = normalizeId(guildId);
  const normalizedChannelId = normalizeId(channelId);

  if (!useMemoryStore) {
    insertStmt.run({
      user_id: userId,
      guild_id: normalizedGuildId,
      channel_id: normalizedChannelId,
      role,
      content,
      ts: entry.ts
    });
    trimStmt.run({
      user_id: userId,
      guild_id: normalizedGuildId,
      channel_id: normalizedChannelId,
      keep: normalizedKeep
    });
    return;
  }

  const key = getMemoryKey(userId, normalizedGuildId, normalizedChannelId);
  if (!memoryStore.has(key)) {
    memoryStore.set(key, []);
  }
  const messages = memoryStore.get(key);
  messages.push(entry);
  while (messages.length > normalizedKeep) {
    messages.shift();
  }
}

export function getLastMessages({ userId, guildId, channelId, limit = DEFAULT_KEEP }) {
  const normalizedLimit = normalizeCount(limit, DEFAULT_KEEP);
  const normalizedGuildId = normalizeId(guildId);
  const normalizedChannelId = normalizeId(channelId);

  if (!useMemoryStore) {
    const rows = selectStmt.all({
      user_id: userId,
      guild_id: normalizedGuildId,
      channel_id: normalizedChannelId,
      limit: normalizedLimit
    });
    return rows.reverse();
  }

  const key = getMemoryKey(userId, normalizedGuildId, normalizedChannelId);
  const messages = memoryStore.get(key) || [];
  return messages.slice(-normalizedLimit);
}

export function clearHistory({ userId, guildId, channelId }) {
  const normalizedGuildId = normalizeId(guildId);
  const normalizedChannelId = normalizeId(channelId);

  if (!useMemoryStore) {
    clearStmt.run({
      user_id: userId,
      guild_id: normalizedGuildId,
      channel_id: normalizedChannelId
    });
    return;
  }

  const key = getMemoryKey(userId, normalizedGuildId, normalizedChannelId);
  memoryStore.delete(key);
}

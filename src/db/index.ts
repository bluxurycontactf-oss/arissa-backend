import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "../../data");
mkdirSync(dataDir, { recursive: true });

export const db = new Database(join(dataDir, "arissa.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'demo',
    kind TEXT NOT NULL DEFAULT 'support',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    matched_entry_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS knowledge_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'demo',
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT '',
    times_used INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'seed',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS unanswered_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'demo',
    question TEXT NOT NULL,
    occurrences INTEGER NOT NULL DEFAULT 1,
    resolved INTEGER NOT NULL DEFAULT 0,
    conversation_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_profile (
    tenant_id TEXT NOT NULL DEFAULT 'demo',
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (tenant_id, key)
  );

  CREATE TABLE IF NOT EXISTS memory_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'demo',
    content TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    importance INTEGER NOT NULL DEFAULT 1,
    embedding BLOB NOT NULL,
    times_used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
  );

  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'demo',
    title TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_ref TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS document_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id),
    tenant_id TEXT NOT NULL DEFAULT 'demo',
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    embedding BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'demo',
    title TEXT NOT NULL,
    instruction TEXT NOT NULL,
    frequency TEXT NOT NULL CHECK (frequency IN ('hourly','daily','weekly')),
    enabled INTEGER NOT NULL DEFAULT 1,
    conversation_id TEXT,
    last_run_at TEXT,
    last_result TEXT,
    next_run_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_knowledge_tenant ON knowledge_entries(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_unanswered_tenant ON unanswered_questions(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_memory_tenant ON memory_facts(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_documents_tenant ON documents(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_chunks_document ON document_chunks(document_id);
  CREATE INDEX IF NOT EXISTS idx_chunks_tenant ON document_chunks(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_tenant ON scheduled_tasks(tenant_id);

  CREATE TABLE IF NOT EXISTS whatsapp_conversations (
    tenant_id TEXT NOT NULL,
    jid TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    auto_reply INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (tenant_id, jid)
  );

  CREATE TABLE IF NOT EXISTS whatsapp_settings (
    tenant_id TEXT PRIMARY KEY,
    unlock_viewonce INTEGER NOT NULL DEFAULT 1,
    anti_delete INTEGER NOT NULL DEFAULT 1,
    appear_online INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS whatsapp_groups (
    tenant_id TEXT NOT NULL,
    group_jid TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    welcome_enabled INTEGER NOT NULL DEFAULT 0,
    welcome_message TEXT NOT NULL DEFAULT 'Bienvenue {nom} dans le groupe !',
    antispam_enabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (tenant_id, group_jid)
  );
`);

try { db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE whatsapp_conversations ADD COLUMN auto_reply INTEGER NOT NULL DEFAULT 1`); } catch {}

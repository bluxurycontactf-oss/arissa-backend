import { db } from "../db/index.js";
import { cosineSimilarity, embed, fromBuffer, toBuffer } from "../rag/embeddings.js";

export type MemoryFact = {
  id: number;
  tenant_id: string;
  content: string;
  category: string;
  importance: number;
  times_used: number;
  created_at: string;
  last_used_at: string | null;
};

export type RetrievedMemory = MemoryFact & { score: number };

const TOP_K = 4;
const MIN_SCORE = 0.35;

const upsertProfileStmt = db.prepare(
  `INSERT INTO user_profile (tenant_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
   ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
);

export function upsertProfile(tenantId: string, key: string, value: string) {
  upsertProfileStmt.run(tenantId, key, value);
}

export function getProfile(tenantId: string): Record<string, string> {
  const rows = db.prepare(`SELECT key, value FROM user_profile WHERE tenant_id = ?`).all(tenantId) as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function deleteProfileKey(tenantId: string, key: string) {
  db.prepare(`DELETE FROM user_profile WHERE tenant_id = ? AND key = ?`).run(tenantId, key);
}

const insertFact = db.prepare(
  `INSERT INTO memory_facts (tenant_id, content, category, importance, embedding) VALUES (?, ?, ?, ?, ?)`
);

export async function saveFact(tenantId: string, content: string, category = "general", importance = 1): Promise<number> {
  const vector = await embed(content);
  const result = insertFact.run(tenantId, content, category, importance, toBuffer(vector));
  return Number(result.lastInsertRowid);
}

export function listFacts(tenantId: string): MemoryFact[] {
  return db
    .prepare(`SELECT id, tenant_id, content, category, importance, times_used, created_at, last_used_at FROM memory_facts WHERE tenant_id = ? ORDER BY created_at DESC`)
    .all(tenantId) as MemoryFact[];
}

export function deleteFact(tenantId: string, id: number) {
  db.prepare(`DELETE FROM memory_facts WHERE tenant_id = ? AND id = ?`).run(tenantId, id);
}

const touchFact = db.prepare(
  `UPDATE memory_facts SET times_used = times_used + 1, last_used_at = datetime('now') WHERE id = ?`
);

export function retrieveMemories(tenantId: string, queryEmbedding: Float32Array, topK = TOP_K): RetrievedMemory[] {
  const rows = db
    .prepare(`SELECT * FROM memory_facts WHERE tenant_id = ?`)
    .all(tenantId) as (MemoryFact & { embedding: Buffer })[];

  const scored = rows.map((row) => ({
    ...row,
    score: cosineSimilarity(queryEmbedding, fromBuffer(row.embedding)),
  }));

  const matches = scored
    .filter((f) => f.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  for (const match of matches) {
    touchFact.run(match.id);
  }

  return matches.map(({ embedding, ...rest }) => rest);
}

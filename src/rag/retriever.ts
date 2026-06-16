import { db } from "../db/index.js";
import { cosineSimilarity, fromBuffer } from "./embeddings.js";

export type RetrievedChunk = {
  documentId: number;
  documentTitle: string;
  content: string;
  score: number;
};

const TOP_K = 4;
const MIN_SCORE = 0.35;

export function retrieveChunks(tenantId: string, queryEmbedding: Float32Array, topK = TOP_K): RetrievedChunk[] {
  const rows = db
    .prepare(
      `SELECT dc.id, dc.content, dc.embedding, d.id as document_id, d.title as document_title
       FROM document_chunks dc
       JOIN documents d ON d.id = dc.document_id
       WHERE dc.tenant_id = ?`
    )
    .all(tenantId) as { id: number; content: string; embedding: Buffer; document_id: number; document_title: string }[];

  const scored = rows.map((row) => ({
    documentId: row.document_id,
    documentTitle: row.document_title,
    content: row.content,
    score: cosineSimilarity(queryEmbedding, fromBuffer(row.embedding)),
  }));

  return scored
    .filter((c) => c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

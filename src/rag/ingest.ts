import * as cheerio from "cheerio";
import pdfParse from "pdf-parse";
import { db } from "../db/index.js";
import { chunkText } from "./chunk.js";
import { embed, toBuffer } from "./embeddings.js";

export type SourceType = "text" | "pdf" | "url";

export type DocumentRecord = {
  id: number;
  tenant_id: string;
  title: string;
  source_type: SourceType;
  source_ref: string | null;
  created_at: string;
};

async function extractText(sourceType: SourceType, payload: { content?: string; file?: Buffer; url?: string }): Promise<string> {
  if (sourceType === "text") {
    if (!payload.content) throw new Error("content est requis pour une source de type text");
    return payload.content;
  }

  if (sourceType === "pdf") {
    if (!payload.file) throw new Error("file est requis pour une source de type pdf");
    const result = await pdfParse(payload.file);
    return result.text;
  }

  if (sourceType === "url") {
    if (!payload.url) throw new Error("url est requis pour une source de type url");
    const res = await fetch(payload.url);
    if (!res.ok) throw new Error(`Impossible de récupérer ${payload.url} (HTTP ${res.status})`);
    const html = await res.text();
    const $ = cheerio.load(html);
    $("script, style, nav, header, footer, noscript").remove();
    return $("body").text().replace(/\s+/g, " ").trim();
  }

  throw new Error(`Type de source inconnu: ${sourceType}`);
}

const insertDocument = db.prepare(
  `INSERT INTO documents (tenant_id, title, source_type, source_ref) VALUES (?, ?, ?, ?)`
);
const insertChunk = db.prepare(
  `INSERT INTO document_chunks (document_id, tenant_id, chunk_index, content, embedding) VALUES (?, ?, ?, ?, ?)`
);

export async function ingestDocument(
  tenantId: string,
  options: { title: string; sourceType: SourceType; content?: string; file?: Buffer; url?: string }
): Promise<DocumentRecord> {
  const text = await extractText(options.sourceType, options);
  const chunks = chunkText(text);
  if (chunks.length === 0) throw new Error("Aucun contenu exploitable trouvé dans ce document.");

  const sourceRef = options.sourceType === "url" ? options.url ?? null : null;
  const result = insertDocument.run(tenantId, options.title, options.sourceType, sourceRef);
  const documentId = Number(result.lastInsertRowid);

  for (let i = 0; i < chunks.length; i++) {
    const vector = await embed(chunks[i]);
    insertChunk.run(documentId, tenantId, i, chunks[i], toBuffer(vector));
  }

  return db.prepare(`SELECT * FROM documents WHERE id = ?`).get(documentId) as DocumentRecord;
}

export function listDocuments(tenantId: string): (DocumentRecord & { chunk_count: number })[] {
  return db
    .prepare(
      `SELECT d.*, COUNT(dc.id) as chunk_count
       FROM documents d
       LEFT JOIN document_chunks dc ON dc.document_id = d.id
       WHERE d.tenant_id = ?
       GROUP BY d.id
       ORDER BY d.created_at DESC`
    )
    .all(tenantId) as (DocumentRecord & { chunk_count: number })[];
}

export function deleteDocument(tenantId: string, id: number) {
  db.prepare(`DELETE FROM document_chunks WHERE document_id = ? AND tenant_id = ?`).run(id, tenantId);
  db.prepare(`DELETE FROM documents WHERE id = ? AND tenant_id = ?`).run(id, tenantId);
}

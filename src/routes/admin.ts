import { Router } from "express";
import { db } from "../db/index.js";
import { addKnowledgeEntry, listKnowledge } from "../services/knowledgeBase.js";

export const adminRouter = Router();

adminRouter.get("/knowledge", (req, res) => {
  const tenantId = (req.query.tenantId as string) || "demo";
  res.json({ entries: listKnowledge(tenantId) });
});

adminRouter.post("/knowledge", (req, res) => {
  const { question, answer, tenantId } = req.body as { question?: string; answer?: string; tenantId?: string };

  if (!question || !answer) {
    return res.status(400).json({ error: "question et answer sont requis." });
  }

  const id = addKnowledgeEntry(tenantId || "demo", question, answer, "founder");
  res.status(201).json({ id });
});

adminRouter.get("/unanswered", (req, res) => {
  const tenantId = (req.query.tenantId as string) || "demo";
  const rows = db
    .prepare(
      `SELECT * FROM unanswered_questions WHERE tenant_id = ? AND resolved = 0 ORDER BY occurrences DESC, created_at DESC`
    )
    .all(tenantId);

  res.json({ questions: rows });
});

adminRouter.post("/unanswered/:id/resolve", (req, res) => {
  const { answer, tenantId } = req.body as { answer?: string; tenantId?: string };
  const row = db.prepare(`SELECT * FROM unanswered_questions WHERE id = ?`).get(req.params.id) as
    | { id: number; tenant_id: string; question: string }
    | undefined;

  if (!row) return res.status(404).json({ error: "Question introuvable." });

  if (answer) {
    addKnowledgeEntry(tenantId || row.tenant_id, row.question, answer, "founder");
  }
  db.prepare(`UPDATE unanswered_questions SET resolved = 1 WHERE id = ?`).run(row.id);

  res.json({ ok: true });
});

adminRouter.get("/stats", (req, res) => {
  const tenantId = (req.query.tenantId as string) || "demo";

  const knowledgeCount = (
    db.prepare(`SELECT COUNT(*) as c FROM knowledge_entries WHERE tenant_id = ?`).get(tenantId) as { c: number }
  ).c;
  const conversationCount = (
    db.prepare(`SELECT COUNT(*) as c FROM conversations WHERE tenant_id = ?`).get(tenantId) as { c: number }
  ).c;
  const messageCount = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.tenant_id = ?`
      )
      .get(tenantId) as { c: number }
  ).c;
  const pendingUnanswered = (
    db
      .prepare(`SELECT COUNT(*) as c FROM unanswered_questions WHERE tenant_id = ? AND resolved = 0`)
      .get(tenantId) as { c: number }
  ).c;

  res.json({ knowledgeCount, conversationCount, messageCount, pendingUnanswered });
});

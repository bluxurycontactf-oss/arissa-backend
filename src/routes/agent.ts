import { Router } from "express";
import multer from "multer";
import { db } from "../db/index.js";
import { deleteDocument, ingestDocument, listDocuments } from "../rag/ingest.js";
import {
  deleteFact,
  deleteProfileKey,
  getProfile,
  listFacts,
  upsertProfile,
} from "../memory/memoryStore.js";
import { getAgentConversationHistory, getOrCreateAgentConversation, respond } from "../agent/reasoningEngine.js";
import { computeNextRun, runTask, type Frequency, type ScheduledTask } from "../agent/scheduler.js";
import { disconnectWhatsApp, getWhatsAppStatus, requestPairingCode } from "../integrations/whatsapp.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const FREQUENCIES: Frequency[] = ["hourly", "daily", "weekly"];

export const agentRouter = Router();

agentRouter.post("/chat", async (req, res) => {
  const tenant = req.tenantId!;
  const { message, conversationId } = req.body as { message?: string; conversationId?: string };

  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Le message est requis." });
  }

  const convId = getOrCreateAgentConversation(conversationId, tenant);

  try {
    const reply = await respond(message.trim(), convId, tenant);
    res.json({ conversationId: convId, reply });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

agentRouter.get("/conversations/:id", (req, res) => {
  const tenant = req.tenantId!;
  const conversation = db
    .prepare(`SELECT id FROM conversations WHERE id = ? AND tenant_id = ?`)
    .get(req.params.id, tenant);
  if (!conversation) return res.status(404).json({ error: "Conversation introuvable." });

  res.json({ messages: getAgentConversationHistory(req.params.id) });
});

agentRouter.post("/documents", upload.single("file"), async (req, res) => {
  const tenant = req.tenantId!;
  const { title, sourceType, content, url } = req.body as {
    title?: string;
    sourceType?: "text" | "pdf" | "url";
    content?: string;
    url?: string;
  };

  if (!title || !sourceType) {
    return res.status(400).json({ error: "title et sourceType sont requis." });
  }

  try {
    const document = await ingestDocument(tenant, {
      title,
      sourceType,
      content,
      url,
      file: req.file?.buffer,
    });
    res.status(201).json({ document });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

agentRouter.get("/documents", (req, res) => {
  res.json({ documents: listDocuments(req.tenantId!) });
});

agentRouter.delete("/documents/:id", (req, res) => {
  deleteDocument(req.tenantId!, Number(req.params.id));
  res.json({ ok: true });
});

agentRouter.get("/memory", (req, res) => {
  res.json({ facts: listFacts(req.tenantId!) });
});

agentRouter.delete("/memory/:id", (req, res) => {
  deleteFact(req.tenantId!, Number(req.params.id));
  res.json({ ok: true });
});

agentRouter.get("/profile", (req, res) => {
  res.json({ profile: getProfile(req.tenantId!) });
});

agentRouter.put("/profile", (req, res) => {
  const { key, value } = req.body as { key?: string; value?: string };
  if (!key || !value) return res.status(400).json({ error: "key et value sont requis." });
  upsertProfile(req.tenantId!, key, value);
  res.json({ ok: true });
});

agentRouter.delete("/profile/:key", (req, res) => {
  deleteProfileKey(req.tenantId!, req.params.key);
  res.json({ ok: true });
});

agentRouter.get("/tasks", (req, res) => {
  const tasks = db
    .prepare(`SELECT * FROM scheduled_tasks WHERE tenant_id = ? ORDER BY created_at DESC`)
    .all(req.tenantId!);
  res.json({ tasks });
});

agentRouter.post("/tasks", (req, res) => {
  const tenant = req.tenantId!;
  const { title, instruction, frequency } = req.body as {
    title?: string;
    instruction?: string;
    frequency?: Frequency;
  };

  if (!title || !instruction || !frequency || !FREQUENCIES.includes(frequency)) {
    return res.status(400).json({ error: "title, instruction et frequency (hourly|daily|weekly) sont requis." });
  }

  const nextRunAt = computeNextRun(frequency);

  const result = db
    .prepare(`INSERT INTO scheduled_tasks (tenant_id, title, instruction, frequency, next_run_at) VALUES (?, ?, ?, ?, ?)`)
    .run(tenant, title, instruction, frequency, nextRunAt);

  const task = db.prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`).get(Number(result.lastInsertRowid));
  res.status(201).json({ task });
});

agentRouter.patch("/tasks/:id", (req, res) => {
  const tenant = req.tenantId!;
  const id = Number(req.params.id);
  const { title, instruction, frequency, enabled } = req.body as {
    title?: string;
    instruction?: string;
    frequency?: Frequency;
    enabled?: boolean;
  };

  const existing = db.prepare(`SELECT * FROM scheduled_tasks WHERE id = ? AND tenant_id = ?`).get(id, tenant) as
    | ScheduledTask
    | undefined;
  if (!existing) return res.status(404).json({ error: "Tâche introuvable." });

  if (frequency && !FREQUENCIES.includes(frequency)) {
    return res.status(400).json({ error: "frequency doit être hourly, daily ou weekly." });
  }

  db.prepare(
    `UPDATE scheduled_tasks SET title = ?, instruction = ?, frequency = ?, enabled = ? WHERE id = ? AND tenant_id = ?`
  ).run(
    title ?? existing.title,
    instruction ?? existing.instruction,
    frequency ?? existing.frequency,
    enabled === undefined ? existing.enabled : enabled ? 1 : 0,
    id,
    tenant
  );

  const task = db.prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`).get(id);
  res.json({ task });
});

agentRouter.delete("/tasks/:id", (req, res) => {
  db.prepare(`DELETE FROM scheduled_tasks WHERE id = ? AND tenant_id = ?`).run(Number(req.params.id), req.tenantId!);
  res.json({ ok: true });
});

agentRouter.get("/whatsapp/status", async (req, res) => {
  const status = await getWhatsAppStatus(req.tenantId!);
  res.json(status);
});

agentRouter.post("/whatsapp/pairing-code", async (req, res) => {
  const { phoneNumber } = req.body as { phoneNumber?: string };
  if (!phoneNumber) return res.status(400).json({ error: "phoneNumber est requis (format international, ex: 33612345678)." });
  try {
    const code = await requestPairingCode(req.tenantId!, phoneNumber);
    res.json({ code });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

agentRouter.post("/whatsapp/disconnect", async (req, res) => {
  await disconnectWhatsApp(req.tenantId!);
  res.json({ ok: true });
});

agentRouter.get("/stats", (req, res) => {
  const t = req.tenantId!;
  const messages = (db.prepare(`SELECT COUNT(*) as c FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.tenant_id=? AND c.kind='agent'`).get(t) as { c: number }).c;
  const memories = (db.prepare(`SELECT COUNT(*) as c FROM memory_facts WHERE tenant_id=?`).get(t) as { c: number }).c;
  const documents = (db.prepare(`SELECT COUNT(*) as c FROM documents WHERE tenant_id=?`).get(t) as { c: number }).c;
  const totalRuns = (db.prepare(`SELECT COALESCE(SUM(run_count),0) as c FROM scheduled_tasks WHERE tenant_id=?`).get(t) as { c: number }).c;
  const tasks = db.prepare(`SELECT id, title, run_count, last_run_at, enabled FROM scheduled_tasks WHERE tenant_id=? ORDER BY run_count DESC`).all(t);
  res.json({ messages, memories, documents, totalRuns, tasks });
});

agentRouter.post("/tasks/:id/run", async (req, res) => {
  const tenant = req.tenantId!;
  const id = Number(req.params.id);

  const task = db.prepare(`SELECT * FROM scheduled_tasks WHERE id = ? AND tenant_id = ?`).get(id, tenant) as
    | ScheduledTask
    | undefined;
  if (!task) return res.status(404).json({ error: "Tâche introuvable." });

  try {
    await runTask(task);
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }

  const updated = db.prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`).get(id);
  res.json({ task: updated });
});

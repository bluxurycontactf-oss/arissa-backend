import { Router } from "express";
import { getOrCreateConversation, getConversationHistory, respond } from "../services/supportAgent.js";

export const supportRouter = Router();

supportRouter.post("/chat", (req, res) => {
  const { message, conversationId, tenantId } = req.body as {
    message?: string;
    conversationId?: string;
    tenantId?: string;
  };

  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Le message est requis." });
  }

  const tenant = tenantId || "demo";
  const convId = getOrCreateConversation(conversationId, tenant);
  const reply = respond(message.trim(), convId, tenant);

  res.json({ conversationId: convId, reply });
});

supportRouter.get("/conversations/:id", (req, res) => {
  const messages = getConversationHistory(req.params.id);
  res.json({ messages });
});

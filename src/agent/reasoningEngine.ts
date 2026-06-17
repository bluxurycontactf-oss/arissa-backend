import { randomUUID } from "crypto";
import { db } from "../db/index.js";
import { llm } from "../llm/index.js";
import type { ChatMessage, ContentBlock, ToolUseBlock } from "../llm/types.js";
import { getProfile, retrieveMemories } from "../memory/memoryStore.js";
import { embed } from "../rag/embeddings.js";
import { retrieveChunks } from "../rag/retriever.js";
import { buildObserverSystemPrompt, buildSystemPrompt } from "./prompts.js";
import { executeTool, TOOLS } from "./tools.js";

const MAX_TOOL_ITERATIONS = 5;
const HISTORY_LIMIT = 12;

const insertMessage = db.prepare(
  `INSERT INTO messages (conversation_id, role, content, matched_entry_id) VALUES (?, ?, ?, ?)`
);
const touchConversation = db.prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`);

export function getOrCreateAgentConversation(conversationId: string | undefined, tenantId = "demo"): string {
  if (conversationId) {
    const existing = db.prepare(`SELECT id FROM conversations WHERE id = ?`).get(conversationId);
    if (existing) return conversationId;
  }

  const id = randomUUID();
  db.prepare(`INSERT INTO conversations (id, tenant_id, kind) VALUES (?, ?, 'agent')`).run(id, tenantId);
  return id;
}

export function getAgentConversationHistory(conversationId: string) {
  return db
    .prepare(`SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC`)
    .all(conversationId);
}

function extractText(content: ContentBlock[]): string {
  return content
    .filter((block): block is { type: "text"; text: string } => (block as { type?: string }).type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function extractToolUses(content: ContentBlock[]): ToolUseBlock[] {
  return content.filter((block): block is ToolUseBlock => (block as { type?: string }).type === "tool_use");
}

export async function respond(message: string, conversationId: string, tenantId = "demo"): Promise<string> {
  insertMessage.run(conversationId, "user", message, null);

  const queryEmbedding = await embed(message);
  const chunks = retrieveChunks(tenantId, queryEmbedding);
  const memories = retrieveMemories(tenantId, queryEmbedding);
  const profile = getProfile(tenantId);

  const system = buildSystemPrompt({ profile, memories, chunks });

  const historyRows = db
    .prepare(
      `SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(conversationId, HISTORY_LIMIT) as { role: "user" | "assistant"; content: string }[];

  const messages: ChatMessage[] = historyRows.reverse().map((row) => ({ role: row.role, content: row.content }));

  let finalReply = "";

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const result = await llm.chat({ system, messages, tools: TOOLS });

    if (result.stopReason !== "tool_use") {
      finalReply = extractText(result.content);
      break;
    }

    messages.push({ role: "assistant", content: result.content });

    const toolUses = extractToolUses(result.content);
    const toolResults: ContentBlock[] = [];

    for (const toolUse of toolUses) {
      const output = await executeTool(toolUse.name, toolUse.input, { tenantId, conversationId });
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: output,
      } as unknown as ContentBlock);
    }

    messages.push({ role: "user", content: toolResults });

    const textSoFar = extractText(result.content);
    if (textSoFar) finalReply = textSoFar;
  }

  if (!finalReply) {
    finalReply = "Désolé, je n'ai pas pu formuler de réponse complète. Pouvez-vous reformuler votre demande ?";
  }

  insertMessage.run(conversationId, "assistant", finalReply, null);
  touchConversation.run(conversationId);

  return finalReply;
}

export async function observeConversation(
  message: string,
  conversationId: string,
  tenantId: string,
  contactLabel: string
): Promise<string | null> {
  insertMessage.run(conversationId, "user", message, null);
  touchConversation.run(conversationId);

  const queryEmbedding = await embed(message);
  const memories = retrieveMemories(tenantId, queryEmbedding);
  const profile = getProfile(tenantId);

  const system = buildObserverSystemPrompt({ profile, memories, contactLabel });

  const historyRows = db
    .prepare(`SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`)
    .all(conversationId, HISTORY_LIMIT) as { role: "user" | "assistant"; content: string }[];

  const messages: ChatMessage[] = historyRows.reverse().map((row) => ({ role: row.role, content: row.content }));

  const result = await llm.chat({ system, messages, tools: [] });
  const text = extractText(result.content).trim();

  if (!text || text.toUpperCase().startsWith("RIEN")) return null;
  return text;
}

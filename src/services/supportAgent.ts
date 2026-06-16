import { randomUUID } from "crypto";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { findBestMatch, recordUsage } from "./knowledgeBase.js";
import { similarity } from "./nlp.js";

type SpecialIntent = {
  patterns: string[];
  respond: () => string;
};

const SPECIAL_INTENTS: SpecialIntent[] = [
  {
    patterns: [
      "qui t'a créé",
      "qui est ton créateur",
      "qui est ton fondateur",
      "qui t'a développé",
      "qui est derrière toi",
      "qui t'a fabriqué",
      "qui a créé arissa",
      "qui est le fondateur d'arissa",
    ],
    respond: () => `J'ai été créé(e) par ${config.founder.name}, le fondateur d'Arissa. ${config.founder.bio}`,
  },
  {
    patterns: [
      "qui es tu",
      "tu es qui",
      "présente toi",
      "que peux tu faire",
      "qu'est ce que arissa",
      "c'est quoi arissa",
    ],
    respond: () =>
      `Je suis ${config.agentName}, l'agent support client de votre jumeau numérique. J'ai été créé(e) par ${config.founder.name} pour répondre à vos questions sur Arissa, votre compte, vos agents et vos abonnements, 24h/24.`,
  },
  {
    patterns: ["bonjour", "salut", "bonsoir", "hello", "coucou"],
    respond: () => `Bonjour ! Je suis ${config.agentName}, votre agent support. Comment puis-je vous aider aujourd'hui ?`,
  },
  {
    patterns: ["merci", "merci beaucoup", "merci bien"],
    respond: () => `Avec plaisir ! N'hésitez pas si vous avez d'autres questions.`,
  },
];

const SPECIAL_THRESHOLD = 0.4;

const FALLBACK =
  "Je n'ai pas encore de réponse précise à cette question, mais je l'ai transmise au fondateur pour que je puisse apprendre à y répondre. En attendant, vous pouvez consulter la page Support ou nous écrire via la page Contact.";

const insertMessage = db.prepare(
  `INSERT INTO messages (conversation_id, role, content, matched_entry_id) VALUES (?, ?, ?, ?)`
);

const touchConversation = db.prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`);

export function getOrCreateConversation(conversationId: string | undefined, tenantId = "demo"): string {
  if (conversationId) {
    const existing = db.prepare(`SELECT id FROM conversations WHERE id = ?`).get(conversationId);
    if (existing) return conversationId;
  }

  const id = randomUUID();
  db.prepare(`INSERT INTO conversations (id, tenant_id) VALUES (?, ?)`).run(id, tenantId);
  return id;
}

function recordUnanswered(tenantId: string, question: string, conversationId: string) {
  const existing = db
    .prepare(`SELECT id FROM unanswered_questions WHERE tenant_id = ? AND question = ? AND resolved = 0`)
    .get(tenantId, question) as { id: number } | undefined;

  if (existing) {
    db.prepare(`UPDATE unanswered_questions SET occurrences = occurrences + 1 WHERE id = ?`).run(existing.id);
  } else {
    db.prepare(`INSERT INTO unanswered_questions (tenant_id, question, conversation_id) VALUES (?, ?, ?)`).run(
      tenantId,
      question,
      conversationId
    );
  }
}

export function respond(message: string, conversationId: string, tenantId = "demo"): string {
  insertMessage.run(conversationId, "user", message, null);

  let reply = "";
  let matchedEntryId: number | null = null;

  for (const intent of SPECIAL_INTENTS) {
    const score = Math.max(...intent.patterns.map((pattern) => similarity(message, pattern)));
    if (score >= SPECIAL_THRESHOLD) {
      reply = intent.respond();
      break;
    }
  }

  if (!reply) {
    const match = findBestMatch(tenantId, message);
    if (match) {
      reply = match.entry.answer;
      matchedEntryId = match.entry.id;
      recordUsage(match.entry.id);
    }
  }

  if (!reply) {
    reply = FALLBACK;
    recordUnanswered(tenantId, message, conversationId);
  }

  insertMessage.run(conversationId, "assistant", reply, matchedEntryId);
  touchConversation.run(conversationId);

  return reply;
}

export function getConversationHistory(conversationId: string) {
  return db
    .prepare(`SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC`)
    .all(conversationId);
}

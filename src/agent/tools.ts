import { embed } from "../rag/embeddings.js";
import { retrieveChunks } from "../rag/retriever.js";
import { retrieveMemories, saveFact, upsertProfile } from "../memory/memoryStore.js";
import { sendEmail } from "../integrations/email.js";
import { sendWhatsAppMessage } from "../integrations/whatsapp.js";
import type { ToolDefinition } from "../llm/types.js";

export type ToolContext = {
  tenantId: string;
  conversationId: string;
};

export type ToolHandler = (input: Record<string, unknown>, ctx: ToolContext) => Promise<string>;

export const TOOLS: ToolDefinition[] = [
  {
    name: "save_memory",
    description:
      "Enregistre durablement une information importante sur l'utilisateur ou son activité (préférence, objectif, fait marquant) pour t'en souvenir lors des prochaines conversations.",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Le fait à mémoriser, formulé clairement." },
        category: {
          type: "string",
          description: "Catégorie du fait (ex: business, préférence, objectif, contact).",
        },
        importance: { type: "integer", description: "Importance de 1 (faible) à 5 (critique).", minimum: 1, maximum: 5 },
      },
      required: ["content"],
    },
  },
  {
    name: "update_profile",
    description:
      "Met à jour une information structurée et durable du profil utilisateur (clé/valeur), par exemple le nom de l'entreprise, le secteur d'activité, ou un objectif principal.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Clé du profil (ex: business_name, secteur, objectif_principal)." },
        value: { type: "string", description: "Valeur à enregistrer." },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "search_knowledge",
    description:
      "Recherche dans les documents fournis par l'utilisateur et dans sa mémoire long terme des informations pertinentes pour répondre à une question précise.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "La requête de recherche." },
      },
      required: ["query"],
    },
  },
  {
    name: "send_email",
    description: "Envoie un email à un destinataire pour le compte de l'utilisateur.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Adresse email du destinataire." },
        subject: { type: "string", description: "Sujet de l'email." },
        body: { type: "string", description: "Corps du message." },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "send_whatsapp",
    description: "Envoie un message WhatsApp à un contact pour le compte de l'utilisateur.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Numéro de téléphone WhatsApp du destinataire (format international)." },
        message: { type: "string", description: "Contenu du message." },
      },
      required: ["to", "message"],
    },
  },
];

const handlers: Record<string, ToolHandler> = {
  async save_memory(input, ctx) {
    const content = String(input.content ?? "").trim();
    if (!content) return "Erreur : aucun contenu fourni.";
    const category = typeof input.category === "string" ? input.category : "general";
    const importance = typeof input.importance === "number" ? input.importance : 1;
    await saveFact(ctx.tenantId, content, category, importance);
    return `Information mémorisée : "${content}"`;
  },

  async update_profile(input, ctx) {
    const key = String(input.key ?? "").trim();
    const value = String(input.value ?? "").trim();
    if (!key || !value) return "Erreur : key et value sont requis.";
    upsertProfile(ctx.tenantId, key, value);
    return `Profil mis à jour : ${key} = ${value}`;
  },

  async search_knowledge(input, ctx) {
    const query = String(input.query ?? "").trim();
    if (!query) return "Erreur : query est requis.";

    const vector = await embed(query);
    const chunks = retrieveChunks(ctx.tenantId, vector);
    const memories = retrieveMemories(ctx.tenantId, vector);

    if (chunks.length === 0 && memories.length === 0) {
      return "Aucune information pertinente trouvée dans les documents ou la mémoire.";
    }

    const parts: string[] = [];
    for (const chunk of chunks) {
      parts.push(`[Document: ${chunk.documentTitle}] ${chunk.content}`);
    }
    for (const memory of memories) {
      parts.push(`[Mémoire: ${memory.category}] ${memory.content}`);
    }
    return parts.join("\n\n");
  },

  async send_email(input) {
    const to = String(input.to ?? "");
    const subject = String(input.subject ?? "");
    const body = String(input.body ?? "");
    if (!to || !subject || !body) return "Erreur : to, subject et body sont requis.";
    return sendEmail({ to, subject, body });
  },

  async send_whatsapp(input) {
    const to = String(input.to ?? "");
    const message = String(input.message ?? "");
    if (!to || !message) return "Erreur : to et message sont requis.";
    return sendWhatsAppMessage({ to, message });
  },
};

export async function executeTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const handler = handlers[name];
  if (!handler) return `Outil inconnu : ${name}`;
  try {
    return await handler(input, ctx);
  } catch (error) {
    return `Erreur lors de l'exécution de l'outil ${name} : ${(error as Error).message}`;
  }
}

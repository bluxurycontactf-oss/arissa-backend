import { config } from "../config.js";
import type { RetrievedMemory } from "../memory/memoryStore.js";
import type { RetrievedChunk } from "../rag/retriever.js";

export function buildSystemPrompt(options: {
  profile: Record<string, string>;
  memories: RetrievedMemory[];
  chunks: RetrievedChunk[];
}): string {
  const { profile, memories, chunks } = options;

  const sections: string[] = [
    `Tu es ${config.agentName}, le jumeau numérique et assistant IA autonome de l'utilisateur. Tu as été créé par ${config.founder.name}. ${config.founder.bio}`,
    `Ton rôle : aider l'utilisateur sur n'importe quel sujet (business, technologie, immobilier, marketing, finance, éducation, etc.), en raisonnant étape par étape, en proposant des stratégies concrètes et des plans d'action structurés — pas seulement des réponses courtes.`,
    `Règles importantes :
- Ne prétends jamais "tout savoir". Si une information précise sur l'activité de l'utilisateur n'est pas disponible dans le contexte ci-dessous, dis-le clairement et propose à l'utilisateur d'ajouter un document, une note ou une source pour que tu puisses l'utiliser.
- Distingue dans tes réponses ce qui vient du contexte fourni (mémoire, documents) de ta connaissance générale.
- Quand un problème est complexe, décompose-le en étapes claires et propose un plan concret avant de répondre dans le détail.
- Quand tu apprends une information durable et utile sur l'utilisateur ou son activité (nom de l'entreprise, secteur, objectif, préférence...), utilise l'outil update_profile (pour les faits structurés clé/valeur) ou save_memory (pour les autres faits importants).
- Si tu as besoin de chercher dans les documents fournis ou la mémoire pour répondre précisément, utilise l'outil search_knowledge.
- Réponds en français, de façon claire et actionnable.`,
  ];

  const profileEntries = Object.entries(profile);
  if (profileEntries.length > 0) {
    sections.push(
      `Profil connu de l'utilisateur :\n` + profileEntries.map(([key, value]) => `- ${key} : ${value}`).join("\n")
    );
  }

  if (memories.length > 0) {
    sections.push(
      `Faits mémorisés pertinents pour cette conversation :\n` +
        memories.map((m) => `- [${m.category}] ${m.content}`).join("\n")
    );
  }

  if (chunks.length > 0) {
    sections.push(
      `Extraits de documents fournis par l'utilisateur, pertinents pour cette conversation :\n` +
        chunks.map((c) => `--- ${c.documentTitle} ---\n${c.content}`).join("\n\n")
    );
  }

  return sections.join("\n\n");
}

export function buildObserverSystemPrompt(options: {
  profile: Record<string, string>;
  memories: RetrievedMemory[];
  contactLabel: string;
}): string {
  const { profile, memories, contactLabel } = options;

  const sections: string[] = [
    `Tu es ${config.agentName}, le jumeau numérique de l'utilisateur. Tu observes en silence une conversation WhatsApp entre l'utilisateur et son contact "${contactLabel}". Tu NE RÉPONDS JAMAIS directement à ce contact — tu n'es qu'un observateur.`,
    `Ton rôle : analyser les nouveaux messages de cette conversation et décider si quelque chose mérite d'être signalé à l'utilisateur en privé (opportunité commerciale, demande importante, problème à régler, information clé, ton inhabituel, urgence...).
- Si oui : rédige une remarque ou suggestion brève et actionnable, destinée à l'utilisateur lui-même (pas au contact).
- Si rien d'important ne justifie une remarque pour ce message, réponds strictement par le mot RIEN (rien d'autre).
- Ne commente pas les messages anodins (salutations, banalités) — réponds RIEN dans ce cas.`,
  ];

  const profileEntries = Object.entries(profile);
  if (profileEntries.length > 0) {
    sections.push(
      `Profil connu de l'utilisateur :\n` + profileEntries.map(([key, value]) => `- ${key} : ${value}`).join("\n")
    );
  }

  if (memories.length > 0) {
    sections.push(
      `Faits mémorisés pertinents :\n` + memories.map((m) => `- [${m.category}] ${m.content}`).join("\n")
    );
  }

  return sections.join("\n\n");
}

import { db } from "../db/index.js";
import { extractKeywords, similarity } from "./nlp.js";

export type KnowledgeEntry = {
  id: number;
  tenant_id: string;
  question: string;
  answer: string;
  keywords: string;
  times_used: number;
  source: string;
  created_at: string;
};

const SEED_ENTRIES: { question: string; answer: string }[] = [
  {
    question: "Qu'est-ce qu'un jumeau numérique ?",
    answer:
      "C'est une réplique intelligente de vous-même dans le monde digital. Il connaît votre activité, vos préférences et vos objectifs, et agit en continu pour les faire progresser grâce à des agents IA spécialisés.",
  },
  {
    question: "Comment créer mon compte Arissa ?",
    answer:
      "Rendez-vous sur la page Inscription, renseignez votre nom, votre email et un mot de passe, puis acceptez les conditions d'utilisation. Votre jumeau numérique est prêt en quelques minutes.",
  },
  {
    question: "Quels sont les plans tarifaires disponibles ?",
    answer:
      "Arissa propose 4 plans : Starter (gratuit), Pro (29$/mois), Business (99$/mois) et Enterprise (sur devis). Vous pouvez changer de plan à tout moment depuis votre tableau de bord.",
  },
  {
    question: "Quels moyens de paiement acceptez-vous ?",
    answer:
      "Tous les paiements sont traités de façon sécurisée par FedaPay : carte bancaire (Visa, Mastercard) et Mobile Money (MTN, Moov, Orange).",
  },
  {
    question: "Comment annuler mon abonnement ?",
    answer:
      "Vous pouvez mettre à niveau, rétrograder ou annuler votre abonnement à tout moment depuis la section Paramètres de votre tableau de bord, sans engagement.",
  },
  {
    question: "Mes données sont-elles en sécurité avec Arissa ?",
    answer:
      "Oui. Vos données sont chiffrées et ne sont jamais partagées avec des tiers. Vous gardez le contrôle total sur les actions que vos agents sont autorisés à effectuer.",
  },
  {
    question: "Quels agents IA sont disponibles ?",
    answer:
      "Six agents sont disponibles : Agent Commercial, Agent Support Client, Agent Marketing, Agent Comptable, Agent Recherche et Agent Opérations. Vous pouvez les activer ou les désactiver depuis votre tableau de bord.",
  },
  {
    question: "Comment contacter le support Arissa ?",
    answer:
      "Vous pouvez nous écrire via le formulaire de la page Contact, ou par email à support@arissa.ai. Notre équipe répond généralement en moins de 24h.",
  },
  {
    question: "Ai-je besoin de compétences techniques pour utiliser Arissa ?",
    answer:
      "Non. La création de votre jumeau numérique et l'activation de vos agents se font en quelques minutes, sans aucune compétence technique requise.",
  },
];

const insertEntry = db.prepare(
  `INSERT INTO knowledge_entries (tenant_id, question, answer, keywords, source) VALUES (?, ?, ?, ?, ?)`
);

export function seedKnowledgeBase(tenantId = "demo") {
  const count = (
    db.prepare(`SELECT COUNT(*) as c FROM knowledge_entries WHERE tenant_id = ?`).get(tenantId) as { c: number }
  ).c;
  if (count > 0) return;

  for (const entry of SEED_ENTRIES) {
    insertEntry.run(tenantId, entry.question, entry.answer, extractKeywords(entry.question).join(","), "seed");
  }
}

export function listKnowledge(tenantId = "demo"): KnowledgeEntry[] {
  return db
    .prepare(`SELECT * FROM knowledge_entries WHERE tenant_id = ? ORDER BY times_used DESC, id ASC`)
    .all(tenantId) as KnowledgeEntry[];
}

export function addKnowledgeEntry(tenantId: string, question: string, answer: string, source = "founder") {
  const keywords = extractKeywords(question).join(",");
  const result = insertEntry.run(tenantId, question, answer, keywords, source);
  return result.lastInsertRowid;
}

const MATCH_THRESHOLD = 0.28;

export function findBestMatch(tenantId: string, query: string): { entry: KnowledgeEntry; score: number } | null {
  const entries = listKnowledge(tenantId);
  let best: { entry: KnowledgeEntry; score: number } | null = null;

  for (const entry of entries) {
    const questionScore = similarity(query, entry.question);
    const keywordScore = similarity(query, entry.keywords.split(",").join(" "));
    const score = Math.max(questionScore, keywordScore);

    if (!best || score > best.score) {
      best = { entry, score };
    }
  }

  if (!best || best.score < MATCH_THRESHOLD) return null;
  return best;
}

export function recordUsage(entryId: number) {
  db.prepare(`UPDATE knowledge_entries SET times_used = times_used + 1 WHERE id = ?`).run(entryId);
}

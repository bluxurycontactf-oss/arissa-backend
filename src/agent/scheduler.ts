import { db } from "../db/index.js";
import { getOrCreateAgentConversation, respond } from "./reasoningEngine.js";

const CHECK_INTERVAL_MS = 60_000;

export type Frequency = "hourly" | "daily" | "weekly";

export type ScheduledTask = {
  id: number;
  tenant_id: string;
  title: string;
  instruction: string;
  frequency: Frequency;
  enabled: number;
  conversation_id: string | null;
  last_run_at: string | null;
  last_result: string | null;
  next_run_at: string;
  created_at: string;
};

const FREQUENCY_MS: Record<Frequency, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

export function computeNextRun(frequency: Frequency, from: Date = new Date()): string {
  return new Date(from.getTime() + FREQUENCY_MS[frequency]).toISOString();
}

const updateAfterRun = db.prepare(
  `UPDATE scheduled_tasks SET conversation_id = ?, last_run_at = datetime('now'), last_result = ?, next_run_at = ?, run_count = run_count + 1 WHERE id = ?`
);

export async function runTask(task: ScheduledTask): Promise<void> {
  const conversationId = getOrCreateAgentConversation(task.conversation_id ?? undefined, task.tenant_id);

  let result: string;
  try {
    result = await respond(task.instruction, conversationId, task.tenant_id);
  } catch (error) {
    result = `Erreur : ${(error as Error).message}`;
  }

  updateAfterRun.run(conversationId, result, computeNextRun(task.frequency), task.id);
}

export async function runDueTasks(): Promise<void> {
  const due = db
    .prepare(`SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at <= datetime('now')`)
    .all() as ScheduledTask[];

  for (const task of due) {
    await runTask(task);
  }
}

export function startScheduler(): void {
  setInterval(() => {
    runDueTasks().catch((error) => console.error("Erreur lors de l'exécution des tâches planifiées :", error));
  }, CHECK_INTERVAL_MS);
}

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";
import makeWASocket, { useMultiFileAuthState, DisconnectReason, jidNormalizedUser } from "@whiskeysockets/baileys";
import type { WASocket } from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { Boom } from "@hapi/boom";
import { db } from "../db/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sessionsDir = join(__dirname, "../../data/whatsapp_sessions");
mkdirSync(sessionsDir, { recursive: true });

const SESSION_EXPIRY_MS = 5 * 60 * 1000;

type Session = {
  sock: WASocket | null;
  qr: string | null;
  pairingCode: string | null;
  status: "disconnected" | "connecting" | "qr" | "pairing" | "connected" | "expired";
  connecting: Promise<void> | null;
  expiryTimer: NodeJS.Timeout | null;
};

const sessions = new Map<string, Session>();

function getSession(tenantId: string): Session {
  let session = sessions.get(tenantId);
  if (!session) {
    session = { sock: null, qr: null, pairingCode: null, status: "disconnected", connecting: null, expiryTimer: null };
    sessions.set(tenantId, session);
  }
  return session;
}

function clearExpiryTimer(session: Session) {
  if (session.expiryTimer) {
    clearTimeout(session.expiryTimer);
    session.expiryTimer = null;
  }
}

function startExpiryTimer(tenantId: string, session: Session) {
  clearExpiryTimer(session);
  session.expiryTimer = setTimeout(() => {
    expireSession(tenantId).catch(() => {});
  }, SESSION_EXPIRY_MS);
}

const getWaConversation = db.prepare(
  `SELECT conversation_id, auto_reply FROM whatsapp_conversations WHERE tenant_id = ? AND jid = ?`
);
const insertWaConversation = db.prepare(
  `INSERT INTO whatsapp_conversations (tenant_id, jid, conversation_id, auto_reply) VALUES (?, ?, ?, ?)`
);

export function listWhatsAppContacts(
  tenantId: string
): { jid: string; auto_reply: number; created_at: string }[] {
  return db
    .prepare(`SELECT jid, auto_reply, created_at FROM whatsapp_conversations WHERE tenant_id = ? ORDER BY created_at DESC`)
    .all(tenantId) as { jid: string; auto_reply: number; created_at: string }[];
}

export function setWhatsAppContactAutoReply(tenantId: string, jid: string, autoReply: boolean): void {
  db.prepare(`UPDATE whatsapp_conversations SET auto_reply = ? WHERE tenant_id = ? AND jid = ?`).run(
    autoReply ? 1 : 0,
    tenantId,
    jid
  );
}

type GroupSettings = {
  tenant_id: string;
  group_jid: string;
  name: string;
  welcome_enabled: number;
  welcome_message: string;
  antispam_enabled: number;
};

const getGroupSettings = db.prepare(
  `SELECT * FROM whatsapp_groups WHERE tenant_id = ? AND group_jid = ?`
);
const upsertGroup = db.prepare(
  `INSERT INTO whatsapp_groups (tenant_id, group_jid, name) VALUES (?, ?, ?)
   ON CONFLICT(tenant_id, group_jid) DO UPDATE SET name = excluded.name`
);

export function listWhatsAppGroups(tenantId: string): GroupSettings[] {
  return db
    .prepare(`SELECT * FROM whatsapp_groups WHERE tenant_id = ? ORDER BY name ASC`)
    .all(tenantId) as GroupSettings[];
}

export function updateWhatsAppGroupSettings(
  tenantId: string,
  groupJid: string,
  settings: { welcomeEnabled?: boolean; welcomeMessage?: string; antispamEnabled?: boolean }
): void {
  const current = getGroupSettings.get(tenantId, groupJid) as GroupSettings | undefined;
  if (!current) return;

  db.prepare(
    `UPDATE whatsapp_groups SET welcome_enabled = ?, welcome_message = ?, antispam_enabled = ? WHERE tenant_id = ? AND group_jid = ?`
  ).run(
    settings.welcomeEnabled === undefined ? current.welcome_enabled : settings.welcomeEnabled ? 1 : 0,
    settings.welcomeMessage ?? current.welcome_message,
    settings.antispamEnabled === undefined ? current.antispam_enabled : settings.antispamEnabled ? 1 : 0,
    tenantId,
    groupJid
  );
}

const SPAM_WINDOW_MS = 8_000;
const SPAM_MESSAGE_THRESHOLD = 5;
const SPAM_WARNING_COOLDOWN_MS = 60_000;

const spamTracker = new Map<string, number[]>();
const lastSpamWarning = new Map<string, number>();

async function checkGroupSpam(sock: WASocket, groupJid: string, senderJid: string, messageId: string | null | undefined): Promise<void> {
  const trackerKey = `${groupJid}:${senderJid}`;
  const now = Date.now();
  const timestamps = (spamTracker.get(trackerKey) ?? []).filter((t) => now - t < SPAM_WINDOW_MS);
  timestamps.push(now);
  spamTracker.set(trackerKey, timestamps);

  if (timestamps.length < SPAM_MESSAGE_THRESHOLD) return;

  if (messageId) {
    await sock
      .sendMessage(groupJid, { delete: { remoteJid: groupJid, fromMe: false, id: messageId, participant: senderJid } })
      .catch(() => {});
  }

  const lastWarn = lastSpamWarning.get(trackerKey) ?? 0;
  if (now - lastWarn > SPAM_WARNING_COOLDOWN_MS) {
    lastSpamWarning.set(trackerKey, now);
    await sock
      .sendMessage(groupJid, { text: `⚠️ @${senderJid.split("@")[0]} merci de ne pas envoyer de messages trop rapidement.`, mentions: [senderJid] })
      .catch(() => {});
  }
}

async function handleIncomingWhatsAppMessage(tenantId: string, sock: WASocket, jid: string, text: string): Promise<void> {
  const { respond, getOrCreateAgentConversation, observeConversation } = await import("../agent/reasoningEngine.js");

  const existing = getWaConversation.get(tenantId, jid) as
    | { conversation_id: string; auto_reply: number }
    | undefined;
  const conversationId = getOrCreateAgentConversation(existing?.conversation_id, tenantId);
  const autoReply = existing ? existing.auto_reply === 1 : true;
  if (!existing) insertWaConversation.run(tenantId, jid, conversationId, 1);

  try {
    if (autoReply) {
      const reply = await respond(text, conversationId, tenantId);
      await sock.sendMessage(jid, { text: reply });
      return;
    }

    const contactLabel = jid.split("@")[0];
    const note = await observeConversation(text, conversationId, tenantId, contactLabel);
    if (note && sock.user?.id) {
      const ownerJid = jidNormalizedUser(sock.user.id);
      await sock.sendMessage(ownerJid, {
        text: `🔎 À propos de votre discussion avec ${contactLabel} :\n\n${note}`,
      });
    }
  } catch (error) {
    console.error("Erreur lors du traitement d'un message WhatsApp entrant :", error);
  }
}

async function expireSession(tenantId: string): Promise<void> {
  const session = getSession(tenantId);
  if (session.status === "connected") return;
  clearExpiryTimer(session);
  session.sock?.end(undefined);
  session.sock = null;
  session.qr = null;
  session.pairingCode = null;
  session.status = "expired";
}

async function connect(tenantId: string, opts?: { isRetry?: boolean }): Promise<void> {
  const session = getSession(tenantId);
  session.status = "connecting";

  if (!opts?.isRetry) {
    startExpiryTimer(tenantId, session);
  }

  const { state, saveCreds } = await useMultiFileAuthState(join(sessionsDir, tenantId));
  const sock = makeWASocket({ auth: state });
  session.sock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      if (!jid || msg.key.fromMe || jid === "status@broadcast") continue;

      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";

      if (jid.endsWith("@g.us")) {
        const senderJid = msg.key.participant;
        if (!senderJid || !text.trim()) continue;
        const settings = getGroupSettings.get(tenantId, jid) as GroupSettings | undefined;
        if (settings?.antispam_enabled === 1) {
          checkGroupSpam(sock, jid, senderJid, msg.key.id).catch(() => {});
        }
        continue;
      }

      if (!text.trim()) continue;

      handleIncomingWhatsAppMessage(tenantId, sock, jid, text.trim()).catch((error) => {
        console.error("Erreur lors du traitement d'un message WhatsApp entrant :", error);
      });
    }
  });

  sock.ev.on("groups.upsert", (groups) => {
    for (const group of groups) {
      upsertGroup.run(tenantId, group.id, group.subject ?? "");
    }
  });

  sock.ev.on("group-participants.update", async ({ id: groupJid, participants, action }) => {
    if (action !== "add") return;
    const settings = getGroupSettings.get(tenantId, groupJid) as GroupSettings | undefined;
    if (!settings?.welcome_enabled) return;

    for (const participant of participants) {
      const name = participant.id.split("@")[0];
      const text = settings.welcome_message.replace(/\{nom\}/g, name);
      await sock.sendMessage(groupJid, { text, mentions: [participant.id] }).catch(() => {});
    }
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr && !session.pairingCode) {
      session.qr = await QRCode.toDataURL(qr);
      session.status = "qr";
    }

    if (connection === "open") {
      session.status = "connected";
      session.qr = null;
      session.pairingCode = null;
      clearExpiryTimer(session);
    }

    if (connection === "close") {
      session.sock = null;
      session.pairingCode = null;
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut && session.expiryTimer) {
        connect(tenantId, { isRetry: true }).catch(() => {});
      } else if (session.status !== "expired") {
        session.status = "disconnected";
      }
    }
  });
}

export async function getWhatsAppStatus(
  tenantId: string
): Promise<{ status: Session["status"]; qr: string | null; pairingCode: string | null }> {
  const session = getSession(tenantId);
  if (session.status === "disconnected" && !session.connecting) {
    session.connecting = connect(tenantId).finally(() => {
      session.connecting = null;
    });
  }
  return { status: session.status, qr: session.qr, pairingCode: session.pairingCode };
}

export async function reconnectWhatsApp(tenantId: string): Promise<void> {
  const session = getSession(tenantId);
  clearExpiryTimer(session);
  session.sock?.end(undefined);
  session.sock = null;
  session.qr = null;
  session.pairingCode = null;
  session.status = "disconnected";
  await connect(tenantId);
}

export async function requestPairingCode(tenantId: string, phoneNumber: string): Promise<string> {
  const session = getSession(tenantId);

  if (!session.sock || session.status === "expired") {
    await connect(tenantId);
  } else {
    startExpiryTimer(tenantId, session);
  }

  const sock = session.sock;
  if (!sock) throw new Error("Connexion WhatsApp non disponible, réessayez.");

  const digits = phoneNumber.replace(/\D/g, "");
  const code = await sock.requestPairingCode(digits);
  session.pairingCode = code;
  session.qr = null;
  session.status = "pairing";
  return code;
}

export async function disconnectWhatsApp(tenantId: string): Promise<void> {
  const session = getSession(tenantId);
  clearExpiryTimer(session);
  await session.sock?.logout().catch(() => {});
  session.sock = null;
  session.status = "disconnected";
  session.qr = null;
  session.pairingCode = null;
}

export async function sendWhatsAppMessage(
  tenantId: string,
  { to, message }: { to: string; message: string }
): Promise<string> {
  const session = getSession(tenantId);

  if (session.status !== "connected" || !session.sock) {
    return (
      `WhatsApp non connecté : impossible d'envoyer le message à ${to}. ` +
      `Rendez-vous dans Paramètres pour connecter votre WhatsApp.`
    );
  }

  const digits = to.replace(/\D/g, "");
  const jid = to.includes("@") ? to : `${digits}@s.whatsapp.net`;

  try {
    await session.sock.sendMessage(jid, { text: message });
    return `Message WhatsApp envoyé à ${to}.`;
  } catch (error) {
    return `Erreur lors de l'envoi du message WhatsApp à ${to} : ${(error as Error).message}`;
  }
}

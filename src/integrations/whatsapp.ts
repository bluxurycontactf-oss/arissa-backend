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
      if (!jid || msg.key.fromMe || jid.endsWith("@g.us") || jid === "status@broadcast") continue;

      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
      if (!text.trim()) continue;

      handleIncomingWhatsAppMessage(tenantId, sock, jid, text.trim()).catch((error) => {
        console.error("Erreur lors du traitement d'un message WhatsApp entrant :", error);
      });
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

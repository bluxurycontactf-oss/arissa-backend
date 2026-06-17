import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser,
  downloadMediaMessage,
  proto,
} from "@whiskeysockets/baileys";
import type { WASocket, WAMessage } from "@whiskeysockets/baileys";
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

type WhatsAppSettings = {
  tenant_id: string;
  unlock_viewonce: number;
  anti_delete: number;
  appear_online: number;
};

const DEFAULT_SETTINGS: Omit<WhatsAppSettings, "tenant_id"> = {
  unlock_viewonce: 1,
  anti_delete: 1,
  appear_online: 0,
};

export function getWhatsAppSettings(tenantId: string): WhatsAppSettings {
  const existing = db.prepare(`SELECT tenant_id, unlock_viewonce, anti_delete, appear_online FROM whatsapp_settings WHERE tenant_id = ?`).get(tenantId) as
    | WhatsAppSettings
    | undefined;
  if (existing) return existing;

  db.prepare(
    `INSERT INTO whatsapp_settings (tenant_id, unlock_viewonce, anti_delete, appear_online) VALUES (?, ?, ?, ?)`
  ).run(tenantId, DEFAULT_SETTINGS.unlock_viewonce, DEFAULT_SETTINGS.anti_delete, DEFAULT_SETTINGS.appear_online);

  return { tenant_id: tenantId, ...DEFAULT_SETTINGS };
}

export function updateWhatsAppSettings(
  tenantId: string,
  patch: { unlockViewonce?: boolean; antiDelete?: boolean; appearOnline?: boolean }
): WhatsAppSettings {
  const current = getWhatsAppSettings(tenantId);

  const next: WhatsAppSettings = {
    tenant_id: tenantId,
    unlock_viewonce: patch.unlockViewonce === undefined ? current.unlock_viewonce : patch.unlockViewonce ? 1 : 0,
    anti_delete: patch.antiDelete === undefined ? current.anti_delete : patch.antiDelete ? 1 : 0,
    appear_online: patch.appearOnline === undefined ? current.appear_online : patch.appearOnline ? 1 : 0,
  };

  db.prepare(
    `UPDATE whatsapp_settings SET unlock_viewonce = ?, anti_delete = ?, appear_online = ? WHERE tenant_id = ?`
  ).run(next.unlock_viewonce, next.anti_delete, next.appear_online, tenantId);

  const session = sessions.get(tenantId);
  if (session?.sock?.user?.id) {
    session.sock.sendPresenceUpdate(next.appear_online ? "available" : "unavailable").catch(() => {});
  }

  return next;
}

type CachedMessage = {
  jid: string;
  senderLabel: string;
  text?: string;
  mediaBuffer?: Buffer;
  mediaType?: "image" | "video" | "audio" | "sticker";
  caption?: string;
  cachedAt: number;
};

const ANTI_DELETE_TTL_MS = 30 * 60 * 1000;
const ANTI_DELETE_MAX_ENTRIES = 500;
const messageCache = new Map<string, CachedMessage>();

function pruneMessageCache() {
  const now = Date.now();
  for (const [id, cached] of messageCache) {
    if (now - cached.cachedAt > ANTI_DELETE_TTL_MS) messageCache.delete(id);
  }
  while (messageCache.size > ANTI_DELETE_MAX_ENTRIES) {
    const oldestKey = messageCache.keys().next().value;
    if (!oldestKey) break;
    messageCache.delete(oldestKey);
  }
}

function extractMediaInfo(message: proto.IMessage | null | undefined): { type: CachedMessage["mediaType"]; caption?: string } | null {
  if (!message) return null;
  if (message.imageMessage) return { type: "image", caption: message.imageMessage.caption ?? undefined };
  if (message.videoMessage) return { type: "video", caption: message.videoMessage.caption ?? undefined };
  if (message.audioMessage) return { type: "audio" };
  if (message.stickerMessage) return { type: "sticker" };
  return null;
}

function unwrapViewOnce(message: proto.IMessage | null | undefined): proto.IMessage | null {
  return message?.viewOnceMessage?.message || message?.viewOnceMessageV2?.message || message?.viewOnceMessageV2Extension?.message || null;
}

async function cacheIncomingMessage(msg: WAMessage, jid: string, senderLabel: string): Promise<void> {
  const content = unwrapViewOnce(msg.message) || msg.message;
  if (!msg.key.id || !content) return;

  const mediaInfo = extractMediaInfo(content);
  const text = content.conversation || content.extendedTextMessage?.text || "";

  const cached: CachedMessage = { jid, senderLabel, cachedAt: Date.now() };

  if (mediaInfo) {
    cached.mediaType = mediaInfo.type;
    cached.caption = mediaInfo.caption;
    if (mediaInfo.type === "image" || mediaInfo.type === "video") {
      try {
        cached.mediaBuffer = await downloadMediaMessage({ ...msg, message: content }, "buffer", {});
      } catch {
        // media unavailable, skip caching the buffer
      }
    }
  } else if (text.trim()) {
    cached.text = text.trim();
  } else {
    return;
  }

  messageCache.set(msg.key.id, cached);
  pruneMessageCache();
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

async function unlockViewOnce(sock: WASocket, msg: WAMessage, senderLabel: string): Promise<void> {
  const inner = unwrapViewOnce(msg.message);
  if (!inner) return;

  const mediaInfo = extractMediaInfo(inner);
  if (!mediaInfo || (mediaInfo.type !== "image" && mediaInfo.type !== "video")) return;

  const ownerJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
  if (!ownerJid) return;

  try {
    const buffer = await downloadMediaMessage({ ...msg, message: inner }, "buffer", {});
    const caption = `🔓 Vue unique de ${senderLabel}${mediaInfo.caption ? ` :\n${mediaInfo.caption}` : ""}`;
    if (mediaInfo.type === "video") {
      await sock.sendMessage(ownerJid, { video: buffer, caption });
    } else {
      await sock.sendMessage(ownerJid, { image: buffer, caption });
    }
  } catch (error) {
    console.error("Erreur lors du déblocage d'une vue unique WhatsApp :", error);
  }
}

async function handleDeletedMessage(sock: WASocket, messageId: string): Promise<void> {
  const cached = messageCache.get(messageId);
  if (!cached) return;

  const ownerJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
  if (!ownerJid) return;

  const header = `🗑️ Message supprimé par ${cached.senderLabel} :`;

  try {
    if (cached.mediaBuffer && cached.mediaType === "image") {
      await sock.sendMessage(ownerJid, { image: cached.mediaBuffer, caption: `${header}${cached.caption ? `\n${cached.caption}` : ""}` });
    } else if (cached.mediaBuffer && cached.mediaType === "video") {
      await sock.sendMessage(ownerJid, { video: cached.mediaBuffer, caption: `${header}${cached.caption ? `\n${cached.caption}` : ""}` });
    } else if (cached.mediaType) {
      await sock.sendMessage(ownerJid, { text: `${header} (média de type ${cached.mediaType}, non récupérable)` });
    } else if (cached.text) {
      await sock.sendMessage(ownerJid, { text: `${header}\n\n${cached.text}` });
    }
  } catch (error) {
    console.error("Erreur lors de l'envoi d'un message anti-suppression WhatsApp :", error);
  }
}

async function handleIncomingStatus(sock: WASocket, msg: WAMessage): Promise<void> {
  await sock.readMessages([msg.key]).catch((error) => {
    console.error("Erreur lors du visionnage automatique d'un statut WhatsApp :", error);
  });
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
  const initialSettings = getWhatsAppSettings(tenantId);
  const sock = makeWASocket({ auth: state, markOnlineOnConnect: initialSettings.appear_online === 1 });
  session.sock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    const settings = getWhatsAppSettings(tenantId);

    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      if (!jid) continue;

      if (jid === "status@broadcast") {
        if (!msg.key.fromMe) handleIncomingStatus(sock, msg).catch(() => {});
        continue;
      }

      if (msg.key.fromMe) continue;

      const senderJid = jid.endsWith("@g.us") ? msg.key.participant ?? undefined : jid;
      const senderLabel = (senderJid ?? jid).split("@")[0];

      const revokeKey = msg.message?.protocolMessage?.type === proto.Message.ProtocolMessage.Type.REVOKE
        ? msg.message.protocolMessage.key?.id
        : null;

      if (revokeKey) {
        if (settings.anti_delete === 1) handleDeletedMessage(sock, revokeKey).catch(() => {});
        continue;
      }

      if (settings.unlock_viewonce === 1) {
        unlockViewOnce(sock, msg, senderLabel).catch(() => {});
      }
      if (settings.anti_delete === 1 && senderJid) {
        cacheIncomingMessage(msg, jid, senderLabel).catch(() => {});
      }

      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";

      if (jid.endsWith("@g.us")) {
        if (!senderJid || !text.trim()) continue;
        const groupSettings = getGroupSettings.get(tenantId, jid) as GroupSettings | undefined;
        if (groupSettings?.antispam_enabled === 1) {
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

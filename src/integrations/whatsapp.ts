import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import type { WASocket } from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { Boom } from "@hapi/boom";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sessionsDir = join(__dirname, "../../data/whatsapp_sessions");
mkdirSync(sessionsDir, { recursive: true });

type Session = {
  sock: WASocket | null;
  qr: string | null;
  pairingCode: string | null;
  status: "disconnected" | "connecting" | "qr" | "pairing" | "connected";
  connecting: Promise<void> | null;
};

const sessions = new Map<string, Session>();

function getSession(tenantId: string): Session {
  let session = sessions.get(tenantId);
  if (!session) {
    session = { sock: null, qr: null, pairingCode: null, status: "disconnected", connecting: null };
    sessions.set(tenantId, session);
  }
  return session;
}

async function connect(tenantId: string): Promise<void> {
  const session = getSession(tenantId);
  session.status = "connecting";

  const { state, saveCreds } = await useMultiFileAuthState(join(sessionsDir, tenantId));
  const sock = makeWASocket({ auth: state });
  session.sock = sock;

  sock.ev.on("creds.update", saveCreds);

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
    }

    if (connection === "close") {
      session.status = "disconnected";
      session.sock = null;
      session.pairingCode = null;
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut) {
        connect(tenantId).catch(() => {});
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

export async function requestPairingCode(tenantId: string, phoneNumber: string): Promise<string> {
  const session = getSession(tenantId);

  if (!session.sock) {
    await connect(tenantId);
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
      `Rendez-vous dans Paramètres pour scanner le QR code et connecter votre WhatsApp.`
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

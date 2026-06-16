import { config } from "../config.js";

const GRAPH_API_VERSION = "v21.0";

export async function sendWhatsAppMessage({ to, message }: { to: string; message: string }): Promise<string> {
  if (!config.whatsapp.token || !config.whatsapp.phoneNumberId) {
    return (
      `Outil non configuré : impossible d'envoyer le message WhatsApp à ${to}. ` +
      `Pour activer l'envoi réel : créez une app sur https://developers.facebook.com, ajoutez le produit ` +
      `"WhatsApp", récupérez un numéro de test (ou votre numéro vérifié) et un token d'accès, puis ajoutez ` +
      `WHATSAPP_TOKEN et WHATSAPP_PHONE_NUMBER_ID dans .env.`
    );
  }

  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${config.whatsapp.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.whatsapp.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: message },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    return `Erreur lors de l'envoi du message WhatsApp à ${to} : ${detail}`;
  }

  return `Message WhatsApp envoyé à ${to}.`;
}

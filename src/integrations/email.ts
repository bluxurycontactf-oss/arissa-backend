import { Resend } from "resend";
import { config } from "../config.js";

export async function sendEmail({ to, subject, body }: { to: string; subject: string; body: string }): Promise<string> {
  if (!config.resend.apiKey || !config.resend.fromEmail) {
    return `Outil non configuré : impossible d'envoyer l'email à ${to}. Pour activer l'envoi réel, créez un compte sur https://resend.com, récupérez une clé API et ajoutez RESEND_API_KEY et RESEND_FROM_EMAIL dans .env.`;
  }

  const resend = new Resend(config.resend.apiKey);
  const { error } = await resend.emails.send({
    from: config.resend.fromEmail,
    to,
    subject,
    html: body,
  });

  if (error) {
    return `Erreur lors de l'envoi de l'email à ${to} : ${error.message}`;
  }

  return `Email envoyé à ${to}.`;
}

import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 4000),
  founder: {
    name: process.env.FOUNDER_NAME ?? "Didi Lolade",
    bio:
      process.env.FOUNDER_BIO ??
      "Didi Lolade a créé Arissa pour permettre à chaque entrepreneur de posséder son propre jumeau numérique et ses agents IA autonomes.",
  },
  agentName: process.env.AGENT_NAME ?? "Arissa",
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
    enableWebSearch: process.env.ENABLE_WEB_SEARCH === "true",
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    model: process.env.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-4-5",
  },
  resend: {
    apiKey: process.env.RESEND_API_KEY ?? "",
    fromEmail: process.env.RESEND_FROM_EMAIL ?? "",
  },
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN ?? "",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "",
  },
  firebase: {
    serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH ?? "",
    serviceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? "",
  },
};

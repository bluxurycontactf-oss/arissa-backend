import { config } from "../config.js";
import { AnthropicProvider } from "./anthropicProvider.js";
import type { LLMProvider } from "./types.js";

export const llm: LLMProvider = config.openrouter.apiKey
  ? new AnthropicProvider(
      config.openrouter.apiKey,
      "https://openrouter.ai/api/v1",
      config.openrouter.model
    )
  : new AnthropicProvider(config.anthropic.apiKey);

export * from "./types.js";

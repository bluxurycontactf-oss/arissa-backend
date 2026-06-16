import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import type { ChatParams, ChatResult, ContentBlock, LLMProvider, ToolDefinition } from "./types.js";

const MAX_TOKENS = 1536;

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;
  private isOpenRouter: boolean;

  constructor(apiKey: string, baseURL?: string, modelOverride?: string) {
    this.client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
    this.model = modelOverride ?? config.anthropic.model;
    this.isOpenRouter = !!baseURL;
  }

  async chat({ system, messages, tools }: ChatParams): Promise<ChatResult> {
    const allTools: (ToolDefinition | { type: string; name: string; max_uses?: number })[] = [...(tools ?? [])];

    if (config.anthropic.enableWebSearch && !this.isOpenRouter) {
      allTools.push({ type: "web_search_20250305", name: "web_search", max_uses: 3 });
    }

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system,
      messages: messages as Anthropic.MessageParam[],
      tools: allTools.length > 0 ? (allTools as Anthropic.Tool[]) : undefined,
    });

    return {
      content: response.content as unknown as ContentBlock[],
      stopReason: response.stop_reason,
    };
  }
}

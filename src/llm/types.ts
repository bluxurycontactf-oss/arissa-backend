export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type TextBlock = {
  type: "text";
  text: string;
};

export type ContentBlock = TextBlock | ToolUseBlock | Record<string, unknown>;

export type ChatMessage = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

export type ChatParams = {
  system: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
};

export type ChatResult = {
  content: ContentBlock[];
  stopReason: string | null;
};

export interface LLMProvider {
  chat(params: ChatParams): Promise<ChatResult>;
}

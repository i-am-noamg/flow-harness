import type { AgentResult, AgentUsage, ThinkingLevel } from "./types.js";

function textFromMessage(message: any): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content.filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n");
  return "";
}

export interface AgentSessionHandle {
  session: any;
  model?: string;
  writes: boolean;
}

export class AgentExecutionError extends Error {
  constructor(message: string, readonly agentResult: AgentResult) {
    super(message);
    this.name = "AgentExecutionError";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function addUsage(total: AgentUsage, usage: any): void {
  if (!usage) return;
  total.input += usage.input ?? 0;
  total.output += usage.output ?? 0;
  total.cacheRead += usage.cacheRead ?? 0;
  total.cacheWrite += usage.cacheWrite ?? 0;
  total.cacheWrite1h = (total.cacheWrite1h ?? 0) + (usage.cacheWrite1h ?? 0);
  total.reasoning = (total.reasoning ?? 0) + (usage.reasoning ?? 0);
  total.totalTokens += usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  if (usage.cost) {
    total.cost ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    total.cost.input += usage.cost.input ?? 0;
    total.cost.output += usage.cost.output ?? 0;
    total.cost.cacheRead += usage.cost.cacheRead ?? 0;
    total.cost.cacheWrite += usage.cost.cacheWrite ?? 0;
    total.cost.total += usage.cost.total ?? 0;
  }
}

function emptyUsage(): AgentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

export async function createAgentSession(cwd: string, profile?: string, writes = false, thinkingLevel?: ThinkingLevel): Promise<AgentSessionHandle> {
  const sdk: any = await import("@earendil-works/pi-coding-agent");
  const runtime = await sdk.ModelRuntime.create();
  let model: any;
  const requested = profile && (process.env[`FLOW_MODEL_${profile.toUpperCase()}`] || profile);
  if (requested && requested.includes("/")) {
    const [provider, ...rest] = requested.split("/");
    model = runtime.getModel(provider, rest.join("/"));
    if (!model) throw new Error(`Model not found: ${requested}`);
  }
  const { session } = await sdk.createAgentSession({
    cwd,
    model,
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    modelRuntime: runtime,
    sessionManager: sdk.SessionManager.inMemory(),
    tools: writes ? ["read", "bash", "edit", "write", "grep", "find", "ls"] : ["read", "grep", "find", "ls"],
  });
  return { session, model: requested, writes };
}

export async function runAgent(prompt: string, cwd: string, profile?: string, writes = false, quiet = false, shared?: AgentSessionHandle, promptPath = "", input_chars: Record<string, number> = {}, thinkingLevel?: ThinkingLevel): Promise<AgentResult> {
  const started = Date.now();
  const handle = shared ?? await createAgentSession(cwd, profile, writes, thinkingLevel);
  const session = handle.session;
  if (shared && thinkingLevel !== undefined) session.setThinkingLevel(thinkingLevel);
  const before = session.messages?.length ?? session.agent?.state?.messages?.length ?? 0;
  let retries = 0;
  let section: "thinking" | "output" | undefined;
  const printSection = (next: "thinking" | "output"): void => {
    if (section === next) return;
    section = next;
    console.log(`\n[model ${next}]`);
  };
  const unsubscribe = session.subscribe((event: any) => {
    if (event.type === "agent_end" && event.willRetry) retries++;
    if (event.type !== "message_update") return;
    const update = event.assistantMessageEvent;
    if (update.type === "thinking_delta" || update.type === "text_delta") {
      const next = update.type === "thinking_delta" ? "thinking" : "output";
      if (!quiet) {
        printSection(next);
        process.stdout.write(update.delta);
      }
    }
  });
  let promptError: unknown;
  try {
    await session.prompt(prompt);
  } catch (error) {
    promptError = error;
  } finally {
    unsubscribe?.();
    if (section && !quiet) process.stdout.write("\n");
    if (!shared) session.dispose?.();
  }
  const messages = session.messages ?? session.agent?.state?.messages ?? [];
  const newMessages = messages.slice(before);
  const usage = emptyUsage();
  for (const message of newMessages) if (message.role === "assistant") addUsage(usage, message.usage);
  const assistants = newMessages.filter((message: any) => message.role === "assistant");
  const assistant = [...assistants].reverse()[0];
  const output = textFromMessage(assistant);
  const toolCallParts = (message: any): any[] => Array.isArray(message.content) ? message.content.filter((part: any) => part.type === "toolCall") : [];
  const tool_calls = assistants.reduce((count: number, message: any) => count + toolCallParts(message).length, 0);
  const tool_names = assistants.flatMap((message: any) => toolCallParts(message).map((part: any) => part.name)).filter(Boolean);
  const toolResults = newMessages.filter((message: any) => message.role === "toolResult");
  const provider = assistant?.provider ?? session.model?.provider;
  const response_model = assistant?.responseModel ?? assistant?.model ?? session.model?.id;
  const thinking_level = session.thinkingLevel;
  const context_id = session.sessionId;
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (promptTokens > 0) usage.cache_hit_rate = usage.cacheRead / promptTokens;
  const turn_metrics = assistants.map((message: any) => {
    const turnUsage = emptyUsage();
    addUsage(turnUsage, message.usage);
    const turnPromptTokens = turnUsage.input + turnUsage.cacheRead + turnUsage.cacheWrite;
    if (turnPromptTokens > 0) turnUsage.cache_hit_rate = turnUsage.cacheRead / turnPromptTokens;
    return {
      api: message.api,
      provider: message.provider,
      model: message.model,
      response_model: message.responseModel ?? message.model,
      response_id: message.responseId,
      stop_reason: message.stopReason,
      raw_stop_reason: message.rawStopReason,
      error_message: message.errorMessage,
      usage: turnUsage,
      tool_names: toolCallParts(message).map((part: any) => part.name).filter(Boolean),
    };
  });
  const apis = assistants.map((message: any) => message.api).filter(Boolean);
  const raw_stop_reasons = assistants.map((message: any) => message.rawStopReason).filter(Boolean);
  const tool_failures = toolResults.filter((message: any) => message.isError === true).length;
  const result: AgentResult = {
    output,
    model: handle.model,
    duration: (Date.now() - started) / 1000,
    usage,
    provider,
    response_model,
    thinking_level,
    prompt_chars: prompt.length,
    prompt_path: promptPath,
    input_chars,
    context_id,
    turns: assistants.length,
    tool_calls,
    retries,
    stop_reasons: assistants.map((message: any) => message.stopReason).filter(Boolean),
    tool_names,
    tool_results: toolResults.length,
    tool_failures,
    turn_metrics,
    api: apis.at(-1),
    raw_stop_reason: raw_stop_reasons.at(-1),
    error_message: assistants.map((message: any) => message.errorMessage).filter(Boolean).at(-1) ?? (promptError ? errorText(promptError) : undefined),
  };
  if (promptError) throw new AgentExecutionError(result.error_message ?? "Agent prompt failed", result);
  return result;
}

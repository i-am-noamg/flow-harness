import type { AgentResult, AgentUsage, ThinkingLevel } from "./types.js";

export interface AgentLiveUpdate {
  /** Cumulative usage for this prompt invocation, when Pi has reported it. */
  usage?: AgentUsage;
  turns: number;
  tool_calls: number;
  retries: number;
}

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
  effective_tools: string[];
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

function toolEvidence(messages: any[]): AgentResult["tool_evidence"] {
  const events: Extract<AgentResult["tool_evidence"], { availability: "available" }>["events"] = [];
  const byCallId = new Map<string, (typeof events)[number]>();
  let sourceOrder = 0;
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type !== "toolCall" || typeof part.id !== "string") continue;
        const event = {
          call_id: part.id,
          name: part.name,
          arguments: part.arguments,
          source_order: sourceOrder++,
          ...(typeof message.timestamp === "number" ? { timestamp: message.timestamp } : {}),
        };
        events.push(event);
        byCallId.set(part.id, event);
      }
      continue;
    }
    if (message.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
    const event = byCallId.get(message.toolCallId);
    if (!event || event.result) continue;
    event.result = {
      content: message.content,
      ...(Object.hasOwn(message, "details") ? { details: message.details } : {}),
      is_error: message.isError === true,
      source_order: sourceOrder++,
      ...(typeof message.timestamp === "number" ? { timestamp: message.timestamp } : {}),
    };
  }
  return { availability: "available", events };
}

/** Capture only the stable Pi session snapshot; it is not cumulative run usage. */
function snapshotContextUsage(session: any): AgentResult["context_usage"] {
  if (typeof session.getContextUsage !== "function") return { availability: "unavailable", reason: "Pi session does not expose getContextUsage" };
  try {
    const usage = session.getContextUsage();
    if (!usage) return { availability: "unavailable", reason: "Pi did not report context usage" };
    const snapshot = {
      ...(typeof usage.tokens === "number" ? { tokens: usage.tokens } : {}),
      ...(typeof usage.contextWindow === "number" ? { context_window: usage.contextWindow } : {}),
      ...(typeof usage.percent === "number" ? { percent: usage.percent } : {}),
    };
    if (Object.keys(snapshot).length === 0) return { availability: "unavailable", reason: "Pi did not report context usage" };
    return { availability: "available", ...snapshot };
  } catch {
    return { availability: "unavailable", reason: "Pi context usage snapshot failed" };
  }
}

/** Resolve an agent's declared tool allowlist, preserving explicit empty lists. */
export function resolveEffectiveTools(tools: string[] | undefined, writes = false): string[] {
  if (tools !== undefined) return tools;
  return writes ? ["read", "bash", "edit", "write", "grep", "find", "ls"] : ["read", "grep", "find", "ls"];
}

export async function createAgentSession(cwd: string, profile?: string, writes = false, thinkingLevel?: ThinkingLevel, tools?: string[]): Promise<AgentSessionHandle> {
  const sdk: any = await import("@earendil-works/pi-coding-agent");
  const runtime = await sdk.ModelRuntime.create();
  let model: any;
  const requested = profile && (process.env[`FLOW_MODEL_${profile.toUpperCase()}`] || profile);
  if (requested && requested.includes("/")) {
    const [provider, ...rest] = requested.split("/");
    model = runtime.getModel(provider, rest.join("/"));
    if (!model) throw new Error(`Model not found: ${requested}`);
  }
  const effective_tools = resolveEffectiveTools(tools, writes);
  const { session } = await sdk.createAgentSession({
    cwd,
    model,
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    modelRuntime: runtime,
    sessionManager: sdk.SessionManager.inMemory(),
    tools: effective_tools,
  });
  return { session, model: requested, writes, effective_tools };
}

export async function runAgent(prompt: string, cwd: string, profile?: string, writes = false, quiet = false, shared?: AgentSessionHandle, promptPath = "", input_chars: Record<string, number> = {}, thinkingLevel?: ThinkingLevel, tools?: string[], onLiveUpdate?: (update: AgentLiveUpdate) => void): Promise<AgentResult> {
  const started = Date.now();
  const handle = shared ?? await createAgentSession(cwd, profile, writes, thinkingLevel, tools);
  const session = handle.session;
  if (shared && thinkingLevel !== undefined) session.setThinkingLevel(thinkingLevel);
  const beforeMessages = session.messages;
  const before = Array.isArray(beforeMessages) ? beforeMessages.length : undefined;
  let retries = 0;
  let lastLiveSignature = "";
  let section: "thinking" | "output" | undefined;
  const emitLiveUpdate = (): void => {
    if (!onLiveUpdate || !Array.isArray(session.messages)) return;
    const assistants = session.messages.slice(before ?? 0).filter((message: any) => message.role === "assistant");
    const tool_calls = assistants.reduce((count: number, message: any) => count + (Array.isArray(message.content) ? message.content.filter((part: any) => part.type === "toolCall").length : 0), 0);
    const hasUsage = assistants.some((message: any) => message.usage != null);
    const signature = `${assistants.length}:${tool_calls}:${retries}:${hasUsage ? JSON.stringify(assistants.map((message: any) => message.usage)) : ""}`;
    if (signature === lastLiveSignature) return;
    lastLiveSignature = signature;
    const usage = emptyUsage();
    if (hasUsage) for (const message of assistants) addUsage(usage, message.usage);
    // Keep the transient payload a faithful, compact snapshot of reported usage.
    // addUsage preserves optional final-result fields as zeroes, but do not invent
    // optional metrics that Pi did not report for this invocation.
    if (!assistants.some((message: any) => typeof message.usage?.cacheWrite1h === "number")) delete usage.cacheWrite1h;
    if (!assistants.some((message: any) => typeof message.usage?.reasoning === "number")) delete usage.reasoning;
    onLiveUpdate({ ...(hasUsage ? { usage } : {}), turns: assistants.length, tool_calls, retries });
  };
  const printSection = (next: "thinking" | "output"): void => {
    if (section === next) return;
    section = next;
    console.log(`\n[model ${next}]`);
  };
  const unsubscribe = session.subscribe((event: any) => {
    if (event.type === "agent_end" && event.willRetry) retries++;
    emitLiveUpdate();
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
  let context_usage: AgentResult["context_usage"];
  try {
    await session.prompt(prompt);
  } catch (error) {
    promptError = error;
  } finally {
    unsubscribe?.();
    if (section && !quiet) process.stdout.write("\n");
    context_usage = snapshotContextUsage(session);
    emitLiveUpdate();
    if (!shared) session.dispose?.();
  }
  const messages = session.messages;
  const messagesAvailable = Array.isArray(messages);
  const newMessages = messagesAvailable ? messages.slice(before ?? 0) : [];
  const tool_evidence: AgentResult["tool_evidence"] = messagesAvailable
    ? toolEvidence(newMessages)
    : { availability: "unavailable", reason: "Pi session does not expose public messages" };
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
    output_chars: output.length,
    prompt_path: promptPath,
    input_chars,
    context_id,
    context_usage: context_usage!,
    turns: assistants.length,
    tool_calls,
    retries,
    stop_reasons: assistants.map((message: any) => message.stopReason).filter(Boolean),
    tool_names,
    effective_tools: handle.effective_tools,
    tool_results: toolResults.length,
    tool_failures,
    tool_evidence,
    turn_metrics,
    api: apis.at(-1),
    raw_stop_reason: raw_stop_reasons.at(-1),
    error_message: assistants.map((message: any) => message.errorMessage).filter(Boolean).at(-1) ?? (promptError ? errorText(promptError) : undefined),
  };
  if (promptError) throw new AgentExecutionError(result.error_message ?? "Agent prompt failed", result);
  return result;
}

import type { AgentResult, AgentUsage } from "./types.js";

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

function addUsage(total: AgentUsage, usage: any): void {
  if (!usage) return;
  total.input += usage.input ?? 0;
  total.output += usage.output ?? 0;
  total.cacheRead += usage.cacheRead ?? 0;
  total.cacheWrite += usage.cacheWrite ?? 0;
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

export async function createAgentSession(cwd: string, profile?: string, writes = false): Promise<AgentSessionHandle> {
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
    modelRuntime: runtime,
    sessionManager: sdk.SessionManager.inMemory(),
    tools: writes ? ["read", "bash", "edit", "write", "grep", "find", "ls"] : ["read", "grep", "find", "ls"],
  });
  return { session, model: requested, writes };
}

export async function runAgent(prompt: string, cwd: string, profile?: string, writes = false, quiet = false, shared?: AgentSessionHandle): Promise<AgentResult> {
  const started = Date.now();
  const handle = shared ?? await createAgentSession(cwd, profile, writes);
  const session = handle.session;
  const before = session.messages?.length ?? session.agent?.state?.messages?.length ?? 0;
  let section: "thinking" | "output" | undefined;
  const printSection = (next: "thinking" | "output"): void => {
    if (section === next) return;
    section = next;
    console.log(`\n[model ${next}]`);
  };
  const unsubscribe = session.subscribe((event: any) => {
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
  try {
    await session.prompt(prompt);
  } finally {
    unsubscribe?.();
    if (section && !quiet) process.stdout.write("\n");
  }
  const messages = session.messages ?? session.agent?.state?.messages ?? [];
  const newMessages = messages.slice(before);
  const usage = emptyUsage();
  for (const message of newMessages) if (message.role === "assistant") addUsage(usage, message.usage);
  const assistant = [...messages].reverse().find((m: any) => m.role === "assistant");
  const output = textFromMessage(assistant);
  if (!shared) session.dispose?.();
  return { output, model: handle.model, duration: (Date.now() - started) / 1000, usage };
}

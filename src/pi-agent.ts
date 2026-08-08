import type { AgentResult } from "./types.js";

function textFromMessage(message: any): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content.filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n");
  return "";
}

export async function runAgent(prompt: string, cwd: string, profile?: string, writes = false): Promise<AgentResult> {
  const started = Date.now();
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
    // Read-only agents receive no bash/edit/write tools. `writes: true` opts into the full coding toolset.
    tools: writes ? ["read", "bash", "edit", "write"] : ["read", "grep", "find", "ls"],
  });
  let section: "thinking" | "output" | undefined;
  const printSection = (next: "thinking" | "output"): void => {
    if (section === next) return;
    section = next;
    console.log(`\n[model ${next}]`);
  };
  session.subscribe((event: any) => {
    if (event.type !== "message_update") return;
    const update = event.assistantMessageEvent;
    if (update.type === "thinking_delta" || update.type === "text_delta") {
      const next = update.type === "thinking_delta" ? "thinking" : "output";
      printSection(next);
      process.stdout.write(update.delta);
    }
  });
  try {
    await session.prompt(prompt);
  } finally {
    if (section) process.stdout.write("\n");
  }
  const messages = session.messages ?? session.agent?.state?.messages ?? [];
  const assistant = [...messages].reverse().find((m: any) => m.role === "assistant");
  const output = textFromMessage(assistant);
  session.dispose?.();
  return { output, model: requested, duration: (Date.now() - started) / 1000 };
}

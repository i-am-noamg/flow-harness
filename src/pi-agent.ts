import type { AgentResult } from "./types.js";

function textFromMessage(message: any): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content.filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n");
  return "";
}

export async function runAgent(prompt: string, cwd: string, profile?: string, writes = false, quiet = false): Promise<AgentResult> {
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
    // Read-only agents cannot mutate files or run commands. Write agents get the
    // complete built-in toolset, including the dedicated search and directory tools.
    tools: writes
      ? ["read", "bash", "edit", "write", "grep", "find", "ls"]
      : ["read", "grep", "find", "ls"],
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
      if (!quiet) {
        printSection(next);
        process.stdout.write(update.delta);
      }
    }
  });
  try {
    await session.prompt(prompt);
  } finally {
    if (section && !quiet) process.stdout.write("\n");
  }
  const messages = session.messages ?? session.agent?.state?.messages ?? [];
  const assistant = [...messages].reverse().find((m: any) => m.role === "assistant");
  const output = textFromMessage(assistant);
  session.dispose?.();
  return { output, model: requested, duration: (Date.now() - started) / 1000 };
}

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import flowExtension from "../src/pi-extension.js";

function fakePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  return {
    tools,
    handlers,
    on(name: string, handler: any) { handlers.set(name, handler); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
  };
}

test("inspect_flow_run selects raw nested agent evidence while default inspection stays bounded", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "flow-extension-"));
  try {
    await mkdir(join(cwd, ".flow", "runs"), { recursive: true });
    const output = "x".repeat(9_000);
    const toolResult = "y".repeat(9_000);
    await writeFile(join(cwd, ".flow", "runs", "run.json"), JSON.stringify({
      id: "run", workflow: "test", cwd, started_at: "2025-01-01T00:00:00.000Z", status: "succeeded", steps: [{
        id: "agent", declared_id: "agent", type: "agent", status: "succeeded", started_at: "2025-01-01T00:00:00.000Z", result: {
          output, tool_evidence: { availability: "available", events: [{ call_id: "call", name: "read", arguments: { path: "a" }, source_order: 0, result: { content: [{ type: "text", text: "ok" }], details: { path: "a", bytes: 2, toolResult }, is_error: false, source_order: 1 } }] },
        },
      }],
    }));
    const pi = fakePi();
    flowExtension(pi as any);
    const inspect = pi.tools.get("inspect_flow_run");

    const defaultResult = await inspect.execute("call", { run_id: "run" }, undefined, undefined, { cwd });
    assert.match(defaultResult.details.steps[0].result.output, /\[truncated\]/);
    assert.deepEqual(defaultResult.details.steps[0].result.tool_evidence, { availability: "available", event_count: 1 });
    assert.doesNotMatch(defaultResult.content[0].text, /y{9_000}/);

    const selected = await inspect.execute("call", { run_id: "run", fields: ["result.output", "result.tool_evidence.events.0.result.details"] }, undefined, undefined, { cwd });
    assert.equal(selected.details.steps[0].result.output, output);
    assert.deepEqual(selected.details.steps[0].result.tool_evidence.events[0].result.details, { path: "a", bytes: 2, toolResult });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Flow injected guidance requires saved-run inspection and rejects inference", async () => {
  const pi = fakePi();
  flowExtension(pi as any);
  const handler = pi.handlers.get("before_agent_start");
  const result = await handler({ systemPrompt: "base", systemPromptOptions: { cwd: process.cwd() } });
  assert.match(result.systemPrompt, /exact implementation facts, verification evidence, failures, metrics, or evidence to optimize the workflow/);
  assert.match(result.systemPrompt, /never infer omitted details/);
  assert.match(pi.tools.get("inspect_flow_run").description, /dotted raw step paths/);
});

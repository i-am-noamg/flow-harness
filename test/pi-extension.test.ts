import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import flowExtension from "../src/pi-extension.js";

function fakePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const entries: Array<{ type: string; data: unknown }> = [];
  const entryRenderers = new Map<string, any>();
  return {
    tools,
    handlers,
    entries,
    entryRenderers,
    on(name: string, handler: any) { handlers.set(name, handler); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerEntryRenderer(type: string, renderer: any) { entryRenderers.set(type, renderer); },
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
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

test("run_flow uses user-only status updates and clears them without timeline updates", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "flow-extension-run-"));
  try {
    await mkdir(join(cwd, "flows"), { recursive: true });
    await writeFile(join(cwd, "flows", "live.flow"), [
      "name: live",
      "outputs:",
      "  answer: report.output",
      "steps:",
      "  - id: report",
      "    type: exec",
      `    program: ${JSON.stringify(process.execPath)}`,
      `    args: [\"-e\", ${JSON.stringify("console.log('done')")}]`,
    ].join("\n"));
    const pi = fakePi();
    flowExtension(pi as any);
    const statuses: Array<[string, string | undefined]> = [];
    let updates = 0;
    const result = await pi.tools.get("run_flow").execute("call", { flow: "live" }, undefined, () => updates++, { cwd, ui: { setStatus: (key: string, value: string | undefined) => statuses.push([key, value]) } });
    assert.equal(updates, 0);
    assert.ok(statuses.some(([, value]) => value?.includes("Flow live · 0/? · starting")));
    assert.ok(statuses.some(([, value]) => value?.includes("Flow live · 0/1 · report")));
    assert.deepEqual(statuses.at(-1), ["flow:call", undefined]);
    assert.match(result.content[0].text, /Flow live: succeeded/);
    assert.match(result.content[0].text, /inspect_flow_run/);
    assert.doesNotMatch(JSON.stringify(result), /stdout|stderr/);

    const failed = await pi.tools.get("run_flow").execute("bad", { flow: "missing" }, undefined, () => updates++, { cwd, ui: { setStatus: (key: string, value: string | undefined) => statuses.push([key, value]) } });
    assert.match(failed.content[0].text, /Flow failed to start/);
    assert.deepEqual(statuses.at(-1), ["flow:bad", undefined]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("$flow-name discovers permanent flows, collects validated inputs, and displays a bounded non-context result", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "flow-extension-manual-"));
  try {
    await mkdir(join(cwd, "flows"), { recursive: true });
    await mkdir(join(cwd, ".flow", "tmp"), { recursive: true });
    await writeFile(join(cwd, "flows", "manual.flow"), [
      "name: manual",
      "description: Manual test flow",
      "inputs:",
      "  required: string",
      "  optional: { type: string, default: fallback }",
      "  enabled: { type: boolean, default: false }",
      "steps:",
      "  - id: report",
      "    type: exec",
      `    program: ${JSON.stringify(process.execPath)}`,
      `    args: ["-e", ${JSON.stringify("console.log('hidden output')")}]`,
    ].join("\n"));
    await writeFile(join(cwd, ".flow", "tmp", "temporary.flow"), [
      "name: temporary",
      "steps:",
      "  - id: report",
      "    type: shell",
      "    command: 'true'",
    ].join("\n"));
    const pi = fakePi();
    flowExtension(pi as any);
    const input = pi.handlers.get("input");
    const sessionStart = pi.handlers.get("session_start");
    const prompts: string[] = [];
    const notices: string[] = [];
    const statuses: Array<[string, string | undefined]> = [];
    const autocomplete: any[] = [];
    const responses = ["", "provided", ""];
    const ctx = {
      cwd,
      mode: "tui",
      ui: {
        input: async (title: string) => { prompts.push(title); return responses.shift(); },
        select: async () => "true",
        notify: (text: string) => notices.push(text),
        setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
        addAutocompleteProvider: (provider: any) => autocomplete.push(provider),
      },
    };
    await sessionStart({}, ctx);
    assert.equal(autocomplete.length, 1);
    const fallback = { getSuggestions: async () => null, applyCompletion: () => ({}), shouldTriggerFileCompletion: () => true };
    const suggestions = await autocomplete[0](fallback).getSuggestions(["$man"], 0, 4, { signal: new AbortController().signal });
    assert.deepEqual(suggestions.items.map((item: any) => item.value), ["$manual"]);
    assert.match(suggestions.items[0].description, /required:string/);

    const handled = await input({ text: "$manual" }, ctx);
    assert.deepEqual(handled, { action: "handled" });
    assert.equal(prompts.length, 3);
    assert.deepEqual(notices, ["required is required."]);
    assert.ok(statuses.some(([, value]) => value?.includes("Flow manual · 0/1 · report")));
    assert.deepEqual(statuses.at(-1), ["flow:manual:manual", undefined]);
    assert.equal(pi.entries.length, 1);
    assert.equal(pi.entries[0].type, "flow-run");
    const entry = pi.entries[0].data as any;
    assert.match(entry.text, /Flow manual: succeeded/);
    assert.match(entry.text, /inspect_flow_run/);
    assert.doesNotMatch(JSON.stringify(entry), /hidden output|stdout|stderr/);

    const temporary = await input({ text: "$temporary" }, ctx);
    assert.deepEqual(temporary, { action: "continue" });

    const cancelled = await input({ text: "$manual" }, { ...ctx, ui: { ...ctx.ui, input: async () => undefined } });
    assert.deepEqual(cancelled, { action: "handled" });
    assert.equal(pi.entries.length, 1);

    const nonTuiCtx = { ...ctx, mode: "print", ui: { input: () => { throw new Error("must not prompt"); }, select: () => { throw new Error("must not select"); }, notify: () => { throw new Error("must not notify"); }, setStatus: () => { throw new Error("must not set status"); }, addAutocompleteProvider: () => { throw new Error("must not register autocomplete"); } } };
    await sessionStart({}, nonTuiCtx);
    const nonTui = await input({ text: "$manual" }, nonTuiCtx);
    assert.deepEqual(nonTui, { action: "continue" });
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

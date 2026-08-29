import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import flowExtension, { flowActivityWidget, flowStatusText } from "../src/pi-extension.js";

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
    const runId = "2025-01-01T00-00-00-000Z--test";
    await writeFile(join(cwd, ".flow", "runs", `${runId}.json`), JSON.stringify({
      id: runId, workflow: "test", cwd, started_at: "2025-01-01T00:00:00.000Z", status: "succeeded", steps: [{
        id: "agent", declared_id: "agent", type: "agent", status: "succeeded", started_at: "2025-01-01T00:00:00.000Z", result: {
          output, tool_evidence: { availability: "available", events: [{ call_id: "call", name: "read", arguments: { path: "a" }, source_order: 0, result: { content: [{ type: "text", text: "ok" }], details: { path: "a", bytes: 2, toolResult }, is_error: false, source_order: 1 } }] },
        },
      }],
    }));
    const pi = fakePi();
    flowExtension(pi as any);
    const inspect = pi.tools.get("inspect_flow_run");

    const defaultResult = await inspect.execute("call", { run_id: runId }, undefined, undefined, { cwd });
    assert.match(defaultResult.details.steps[0].result.output, /\[truncated\]/);
    assert.deepEqual(defaultResult.details.steps[0].result.tool_evidence, { availability: "available", event_count: 1 });
    assert.doesNotMatch(defaultResult.content[0].text, /y{9_000}/);

    const selected = await inspect.execute("call", { run_id: runId, fields: ["result.output", "result.tool_evidence.events.0.result.details"] }, undefined, undefined, { cwd });
    assert.equal(selected.details.steps[0].result.output, output);
    assert.deepEqual(selected.details.steps[0].result.tool_evidence.events[0].result.details, { path: "a", bytes: 2, toolResult });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("flow status renders only flow-level progress and elapsed time", () => {
  assert.equal(flowStatusText("live", 1, 3, 0, 4_500), "Flow live · 1/3 · 4s total");
  assert.equal(flowStatusText("live", 0, 0, 0, 999), "Flow live · 0/? · 0s total");
});

test("flow activity widget owns agent activity and omits zero metrics", () => {
  const active = new Map([
    ["inspect", { started: 1_000, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, turns: 0, tool_calls: 0 }],
    ["test", { started: 2_000, usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0.02, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.04 } }, turns: 1, tool_calls: 2, activity: { kind: "tool", preview: "read\n file" } }],
  ]);
  assert.deepEqual(flowActivityWidget("live", active, 4_500), [
    "Flow live",
    "  inspect · 3s",
    "    Waiting for model response…",
    "  test · 2s · 30 tok · $0.0400 · 1 turn · 2 tools",
    "    tool: read file",
  ]);
});

test("run_flow renders its flow and bounded inputs, with complete expanded parameters", () => {
  const pi = fakePi();
  flowExtension(pi as any);
  const renderCall = pi.tools.get("run_flow").renderCall;
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const params = { flow: "release", inputs: { message: "x".repeat(200), dry_run: true }, cwd: "packages/app" };

  const collapsed = renderCall(params, theme, { expanded: false }).render(1_000).join("\n").trimEnd();
  assert.match(collapsed, /run_flow release/);
  assert.match(collapsed, /\{"message":"x{100}/);
  assert.match(collapsed, /…/);
  assert.doesNotMatch(collapsed, /packages\/app/);
  assert.ok(collapsed.length <= "run_flow release ".length + 120);

  const expanded = renderCall(params, theme, { expanded: true }).render(1_000).map((line: string) => line.trimEnd()).join("\n");
  assert.match(expanded, /run_flow release/);
  assert.match(expanded, /\n\{\n  "flow": "release",\n  "inputs": \{/);
  assert.ok(expanded.includes('"cwd": "packages/app"'));
  assert.match(expanded, /x{200}/);
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
      `    args: [\"-e\", ${JSON.stringify("require('node:fs').writeFileSync('created.txt', 'created'); console.log('done')")}]`,
    ].join("\n"));
    await writeFile(join(cwd, "flows", "failed.flow"), [
      "name: failed",
      "steps:",
      "  - id: broken",
      "    type: exec",
      `    program: ${JSON.stringify(process.execPath)}`,
      `    args: [\"-e\", ${JSON.stringify("process.stderr.write('secret stderr'); process.exit(1)")}]`,
    ].join("\n"));
    const pi = fakePi();
    flowExtension(pi as any);
    const statuses: Array<[string, string | undefined]> = [];
    const widgets: Array<[string, string[] | undefined]> = [];
    let updates = 0;
    const ui = { setStatus: (key: string, value: string | undefined) => statuses.push([key, value]), setWidget: (key: string, value: string[] | undefined) => widgets.push([key, value]) };
    const result = await pi.tools.get("run_flow").execute("call", { flow: "live" }, undefined, () => updates++, { cwd, ui });
    assert.equal(updates, 0);
    assert.ok(statuses.some(([, value]) => value?.includes("Flow live · 0/? · 0s total")));
    assert.ok(statuses.some(([, value]) => value?.includes("Flow live · 0/1")));
    assert.deepEqual(statuses.at(-1), ["flow:tool:call:1", undefined]);
    assert.ok(widgets.some(([key, value]) => key === "flow-activity:tool:call:1" && value?.[0].includes("Flow live")));
    assert.deepEqual(widgets.at(-1), ["flow-activity:tool:call:1", undefined]);
    assert.match(result.content[0].text, /^Status: succeeded/m);
    assert.match(result.content[0].text, /Declared outputs:\n\{\n  "answer": "done\\n"\n\}/);
    assert.match(result.content[0].text, /Run ID: /);
    assert.doesNotMatch(result.content[0].text, /Inspect saved run/);
    assert.doesNotMatch(JSON.stringify(result), /stdout|stderr/);

    const failed = await pi.tools.get("run_flow").execute("failed", { flow: "failed" }, undefined, () => updates++, { cwd, ui });
    assert.match(failed.content[0].text, /^Status: failed/m);
    assert.match(failed.content[0].text, /Failures:\n- broken/);
    assert.doesNotMatch(failed.content[0].text, /Inspect saved run/);
    assert.doesNotMatch(JSON.stringify(failed), /secret stderr|stdout|stderr/);
    assert.deepEqual(statuses.at(-1), ["flow:tool:failed:2", undefined]);

    const missing = await pi.tools.get("run_flow").execute("bad", { flow: "missing" }, undefined, () => updates++, { cwd, ui });
    assert.match(missing.content[0].text, /Flow failed to start/);
    assert.deepEqual(statuses.at(-1), ["flow:tool:bad:3", undefined]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("concurrent tool and manual flow runs use independent display keys", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "flow-extension-concurrent-"));
  try {
    await mkdir(join(cwd, "flows"), { recursive: true });
    await writeFile(join(cwd, "flows", "slow.flow"), [
      "name: slow",
      "steps:",
      "  - id: wait",
      "    type: exec",
      `    program: ${JSON.stringify(process.execPath)}`,
      `    args: ["-e", ${JSON.stringify("setTimeout(() => {}, 50)")}]`,
    ].join("\n"));
    const pi = fakePi();
    flowExtension(pi as any);
    const statuses: Array<[string, string | undefined]> = [];
    const widgets: Array<[string, string[] | undefined]> = [];
    const ui = {
      setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
      setWidget: (key: string, value: string[] | undefined) => widgets.push([key, value]),
    };
    const ctx = { cwd, mode: "tui", ui };
    await Promise.all([
      pi.tools.get("run_flow").execute("same-call", { flow: "slow" }, undefined, undefined, ctx),
      pi.tools.get("run_flow").execute("same-call", { flow: "slow" }, undefined, undefined, ctx),
      pi.handlers.get("input")({ text: "$slow" }, ctx),
      pi.handlers.get("input")({ text: "$slow" }, ctx),
    ]);

    const statusKeys = statuses.filter(([, value]) => value !== undefined).map(([key]) => key);
    const clearedStatusKeys = statuses.filter(([, value]) => value === undefined).map(([key]) => key);
    const widgetKeys = widgets.filter(([, value]) => value !== undefined).map(([key]) => key);
    const clearedWidgetKeys = widgets.filter(([, value]) => value === undefined).map(([key]) => key);
    assert.equal(new Set(statusKeys).size, 4);
    assert.deepEqual(new Set(clearedStatusKeys), new Set(statusKeys));
    assert.equal(new Set(widgetKeys).size, 4);
    assert.deepEqual(new Set(clearedWidgetKeys), new Set(widgetKeys));
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
        setWidget: () => undefined,
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
    assert.ok(statuses.some(([, value]) => value?.includes("Flow manual · 0/1")));
    assert.deepEqual(statuses.at(-1), ["flow:manual:manual:1", undefined]);
    assert.equal(pi.entries.length, 1);
    assert.equal(pi.entries[0].type, "flow-run");
    const entry = pi.entries[0].data as any;
    assert.match(entry.text, /^Status: succeeded/m);
    assert.match(entry.text, /Run ID: /);
    assert.doesNotMatch(entry.text, /Inspect saved run/);
    assert.doesNotMatch(JSON.stringify(entry), /hidden output|stdout|stderr/);

    const temporary = await input({ text: "$temporary" }, ctx);
    assert.deepEqual(temporary, { action: "continue" });

    const cancelled = await input({ text: "$manual" }, { ...ctx, ui: { ...ctx.ui, input: async () => undefined } });
    assert.deepEqual(cancelled, { action: "handled" });
    assert.equal(pi.entries.length, 1);

    const nonTuiCtx = { ...ctx, mode: "print", ui: { input: () => { throw new Error("must not prompt"); }, select: () => { throw new Error("must not select"); }, notify: () => { throw new Error("must not notify"); }, setStatus: () => { throw new Error("must not set status"); }, setWidget: () => { throw new Error("must not set widget"); }, addAutocompleteProvider: () => { throw new Error("must not register autocomplete"); } } };
    await sessionStart({}, nonTuiCtx);
    const nonTui = await input({ text: "$manual" }, nonTuiCtx);
    assert.deepEqual(nonTui, { action: "continue" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Flow injected guidance prefers flow tools and bounds saved-run inspection", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "flow-extension-guidance-"));
  try {
    await mkdir(join(cwd, "flows"), { recursive: true });
    await writeFile(join(cwd, "flows", "catalog-test.flow"), "name: catalog-test\ndescription: Catalog guidance test\nsteps: []\n");
    const pi = fakePi();
    flowExtension(pi as any);
    const handler = pi.handlers.get("before_agent_start");
    const result = await handler({ systemPrompt: "base", systemPromptOptions: { cwd } });
    assert.match(result.systemPrompt, /Use a relevant available flow and its tools when one fits; otherwise, do the work directly/);
    assert.match(result.systemPrompt, /Do not invoke workflow CLI wrappers through bash when the corresponding flow tool is available/);
    assert.match(result.systemPrompt, /Available flows:/);
    assert.match(result.systemPrompt, /- catalog-test/);
    assert.match(result.systemPrompt, /Temporary flows live under `\.flow\/tmp\/` and must be referenced by explicit path; bare names resolve only under `flows\/`/);
    assert.match(result.systemPrompt, /Pass only workflow-declared values to `run_flow` inputs/);
    assert.match(result.systemPrompt, /bounded to status, declared outputs, failures, changed files, and a run ID/);
    assert.match(result.systemPrompt, /never infer evidence it omits/);
    assert.match(result.systemPrompt, /\.flow\/runs\/<run-id>\.json/);
    assert.match(result.systemPrompt, /`inspect_flow_run` only when needed/);
    assert.match(result.systemPrompt, /targeted dotted `fields`/);
    assert.match(result.systemPrompt, /After creating or editing a flow, use `validate_flow`/);
    assert.match(pi.tools.get("run_flow").description, /Prefer this tool over invoking flow or npm run dev/);
    assert.match(pi.tools.get("inspect_flow_run").description, /dotted raw step paths/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

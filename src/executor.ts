import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { runExec, runShell } from "./command.js";
import { stripAnsi } from "./ansi.js";
import { evaluateCondition } from "./conditions.js";
import { evaluateOutputExpression, OutputResolutionError } from "./outputs.js";
import { AgentExecutionError, createAgentSession, resolveEffectiveTools, runAgent, type AgentSessionHandle } from "./pi-agent.js";
import { changedFiles, snapshotWorkspace, workspaceChanged } from "./workspace.js";
import { RunStore, makeRunId, type RunStoreLike } from "./artifacts.js";
import type { AgentStep, AgentUsage, FlowAgentProgressEvent, FlowProgressCallback, FlowStepProgressEvent, LoopStep, LoopResult, RunState, Step, StepResult, Workflow } from "./types.js";

export type ArtifactMap = Record<string, any>;
export interface ExecuteOptions { workflow: Workflow; root: string; cwd: string; inputs?: ArtifactMap; output?: "normal" | "quiet"; onProgress?: FlowProgressCallback; readonly workflowSource?: string; }
const DEFAULT_MAX_ITERATIONS = 10;

function lookup(path: string, artifacts: ArtifactMap): any {
  const parts = path.split("."); let value = artifacts[parts.shift()!];
  for (const part of parts) value = value?.[part];
  return value;
}

function render(value: string, artifacts: ArtifactMap): string {
  return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, key) => String(lookup(key.trim(), artifacts) ?? ""));
}

function shouldRun(expression: string | undefined, artifacts: ArtifactMap): boolean {
  if (!expression) return true;
  const evaluation = evaluateCondition(expression, (path) => lookup(path, artifacts));
  if (evaluation.kind === "true") return true;
  if (evaluation.kind === "false") return false;
  if (evaluation.kind === "unknown") throw new Error(`Unknown condition artifact/path: ${evaluation.path}`);
  if (evaluation.kind === "invalid") throw new Error(evaluation.error);
  throw new Error(`Invalid condition: ${expression}`);
}

export async function execute(options: ExecuteOptions): Promise<RunState> {
  const { workflow, root, cwd } = options;
  const quiet = options.output === "quiet";
  const run: RunState = { id: makeRunId(), workflow: workflow.name, cwd, started_at: new Date().toISOString(), status: "running", steps: [] };
  const store = new RunStore(cwd);
  const artifacts: ArtifactMap = { ...(options.inputs ?? {}) };
  const agentSessions = new Map<string, AgentSessionHandle>();
  await store.save(run);
  options.onProgress?.({ type: "flow_started", run_id: run.id, flow: workflow.name, total_steps: workflow.steps.length });
  if (!quiet) console.log(`\nflow ${workflow.name} · run ${run.id}\n`);
  const context: ExecutionContext = { run, store, artifacts, root, cwd, quiet, agentSessions, onProgress: options.onProgress, workflowSource: options.workflowSource };
  try {
    const control = await executeSteps(workflow.steps, (step) => executeStep(step, step.id, run, store, artifacts, root, cwd, quiet, agentSessions, options.onProgress, undefined, undefined, options.workflowSource), context);
    let status: RunState["status"];
    if (control !== "continue") status = control === "stop" ? "succeeded" : "failed";
    else {
      const topLevelSteps = new Map(workflow.steps.map((step) => [step.id, step]));
      const failed = run.steps.some((result) => {
        const step = topLevelSteps.get(result.id);
        return step !== undefined && !step.stopWhen && result.status === "failed" && (result.type === "loop" || result.type === "shell" || result.type === "exec");
      });
      status = failed ? "failed" : "succeeded";
    }
    await finalizeRun(run, store, workflow, artifacts, status);
    if (!quiet) console.log(`\n${run.status === "succeeded" ? "✓" : "✗"} completed ${run.id}`);
    return run;
  } finally {
    disposeAgentSessions(agentSessions);
  }
}

type StepControl = "continue" | "stop" | "fail";
type ExecutionContext = { run: RunState; store: RunStoreLike; artifacts: ArtifactMap; root: string; cwd: string; quiet: boolean; agentSessions: Map<string, AgentSessionHandle>; onProgress?: FlowProgressCallback; readonly workflowSource?: string; loopId?: string; loopIteration?: number };

function disposeAgentSessions(sessions: Map<string, AgentSessionHandle>): void {
  for (const handle of sessions.values()) handle.session.dispose?.();
  sessions.clear();
}

async function finalizeRun(run: RunState, store: RunStoreLike, workflow: Workflow, artifacts: ArtifactMap, status: RunState["status"]): Promise<void> {
  run.status = status;
  try {
    run.outputs = resolveWorkflowOutputs(workflow, artifacts);
  } catch (error) {
    run.status = "failed";
    const resolution = error instanceof OutputResolutionError ? error : undefined;
    run.output_error = {
      output: resolution?.output ?? "unknown",
      expression: resolution?.expression ?? "",
      ...(resolution?.path ? { path: resolution.path } : {}),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  run.finished_at = new Date().toISOString();
  updateRunMetadata(run);
  await store.save(run);
}

export function updateRunMetadata(run: RunState): void {
  const usage: AgentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  let hasUsage = false;
  let step_duration_ms = 0;
  let agent_steps = 0;
  let total_agent_duration_ms = 0;
  let prompt_chars = 0;
  let declared_input_chars = 0;
  let output_chars = 0;
  let repair_iterations = 0;
  let turns = 0;
  let tool_calls = 0;
  let retries = 0;
  const providers = new Set<string>();
  const requested_models = new Set<string>();
  const response_models = new Set<string>();
  const contexts = new Set<string>();
  const effective_tools = new Set<string>();
  const actual_tools = new Set<string>();
  const apis = new Set<string>();
  const tool_names = new Set<string>();
  let tool_failures = 0;
  let context_usage_tokens = 0;
  let context_usage_snapshots = 0;
  for (const step of run.steps) {
    if (step.finished_at) step_duration_ms += Math.max(0, Date.parse(step.finished_at) - Date.parse(step.started_at));
    const agentResult = step.result as any;
    if (step.type === "agent" && agentResult) {
      agent_steps++;
      total_agent_duration_ms += Math.max(0, (agentResult.duration ?? 0) * 1000);
      prompt_chars += agentResult.prompt_chars ?? 0;
      declared_input_chars += Object.values(agentResult.input_chars ?? {}).reduce((total: number, chars: unknown) => total + (typeof chars === "number" ? chars : 0), 0);
      output_chars += agentResult.output_chars ?? 0;
      if (step.declared_id === "repair" && step.loop_id && step.status !== "skipped") repair_iterations++;
      turns += agentResult.turns ?? 0;
      tool_calls += agentResult.tool_calls ?? 0;
      retries += agentResult.retries ?? 0;
      if (agentResult.model) requested_models.add(agentResult.model);
      if (agentResult.provider) providers.add(agentResult.provider);
      if (agentResult.api) apis.add(agentResult.api);
      if (agentResult.response_model) response_models.add(agentResult.response_model);
      if (agentResult.context_id) contexts.add(agentResult.context_id);
      for (const name of agentResult.effective_tools ?? []) effective_tools.add(name);
      for (const name of agentResult.tool_names ?? []) {
        tool_names.add(name);
        actual_tools.add(name);
      }
      const contextUsage = agentResult.context_usage;
      if (contextUsage?.availability === "available" && typeof contextUsage.tokens === "number") {
        context_usage_tokens += contextUsage.tokens;
        context_usage_snapshots++;
      }
      tool_failures += agentResult.tool_failures ?? 0;
    }
    const stepUsage = agentResult?.usage as AgentUsage | undefined;
    if (!stepUsage) continue;
    hasUsage = true;
    usage.input += stepUsage.input;
    usage.output += stepUsage.output;
    usage.cacheRead += stepUsage.cacheRead;
    usage.cacheWrite += stepUsage.cacheWrite;
    usage.cacheWrite1h = (usage.cacheWrite1h ?? 0) + (stepUsage.cacheWrite1h ?? 0);
    usage.reasoning = (usage.reasoning ?? 0) + (stepUsage.reasoning ?? 0);
    usage.totalTokens += stepUsage.totalTokens;
    if (stepUsage.cost) {
      usage.cost ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
      usage.cost.input += stepUsage.cost.input;
      usage.cost.output += stepUsage.cost.output;
      usage.cost.cacheRead += stepUsage.cost.cacheRead;
      usage.cost.cacheWrite += stepUsage.cost.cacheWrite;
      usage.cost.total += stepUsage.cost.total;
    }
  }
  if (hasUsage) {
    const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    if (promptTokens > 0) usage.cache_hit_rate = usage.cacheRead / promptTokens;
    run.usage = usage;
  }
  const total_context_usage = context_usage_snapshots > 0
    ? { availability: "available" as const, aggregation: "sum_reported_snapshots" as const, token_snapshot_count: context_usage_snapshots, tokens: context_usage_tokens }
    : { availability: "unavailable" as const, reason: "Pi did not report context tokens in any agent snapshot" };
  run.agent_metrics = {
    agent_steps, total_agent_duration_ms, prompt_chars, declared_input_chars, output_chars, repair_iterations,
    requested_models: [...requested_models].sort(), turns, tool_calls, retries,
    providers: [...providers].sort(), apis: [...apis].sort(), response_models: [...response_models].sort(), contexts: [...contexts].sort(),
    effective_tools: [...effective_tools].sort(), actual_tools: [...actual_tools].sort(), tool_names: [...tool_names].sort(), tool_failures,
    total_context_usage,
  };
  run.metrics = { wall_duration_ms: Math.max(0, Date.parse(run.finished_at!) - Date.parse(run.started_at)), step_duration_ms };
}

/** Run consecutive marked steps with isolated artifacts and coordinator-owned persistence. */
async function executeSteps(steps: Step[], execute: (step: Step) => Promise<StepControl>, context?: ExecutionContext): Promise<StepControl> {
  for (let index = 0; index < steps.length;) {
    if (!steps[index].parallel) {
      const control = await execute(steps[index++]);
      if (control !== "continue") return control;
      continue;
    }
    const batch: Step[] = [];
    while (index < steps.length && steps[index].parallel) batch.push(steps[index++]);
    const results = context
      ? await Promise.all(batch.map((step) => executeParallelStep(step, context)))
      : await Promise.all(batch.map(async (step) => ({ control: await execute(step), steps: [], artifacts: {} as ArtifactMap })));
    for (const result of results) {
      context?.run.steps.push(...result.steps);
      if (context) Object.assign(context.artifacts, result.artifacts);
    }
    if (context) await context.store.save(context.run);
    const controls = results.map((result) => result.control);
    if (controls.includes("fail")) return "fail";
    if (controls.includes("stop")) return "stop";
  }
  return "continue";
}

async function executeParallelStep(step: Step, context: ExecutionContext): Promise<{ control: StepControl; steps: StepResult[]; artifacts: ArtifactMap }> {
  const workerArtifacts: ArtifactMap = { ...context.artifacts };
  // Records are shared only for coordinator-owned, declaration-ordered persistence;
  // artifacts remain isolated until the batch joins.
  const control = await executeStep(step, step.id, context.run, context.store, workerArtifacts, context.root, context.cwd, true, context.agentSessions, context.onProgress, context.loopId, context.loopIteration, context.workflowSource);
  return { control, steps: [], artifacts: workerArtifacts };
}

async function executeStep(step: Step, recordId: string, run: RunState, store: RunStoreLike, artifacts: ArtifactMap, root: string, cwd: string, quiet: boolean, agentSessions: Map<string, AgentSessionHandle>, onProgress?: FlowProgressCallback, loopId?: string, loopIteration?: number, workflowSource?: string): Promise<StepControl> {
  const result: StepResult = { id: recordId, declared_id: step.id, ...(loopId ? { loop_id: loopId } : {}), type: step.type, status: "running", started_at: new Date().toISOString() };
  run.steps.push(result); await store.save(run);
  emitStepProgress(onProgress, "step_started", run, result, loopIteration);
  try {
    if (!shouldRun(step.when, artifacts)) {
      result.status = "skipped";
      result.control = "continue";
      result.finished_at = new Date().toISOString();
      artifacts[recordId] = { status: "skipped", output: "" };
      artifacts[`${recordId}.output`] = "";
      if (!quiet) console.log(`↷ ${recordId} skipped`); await store.save(run); return "continue";
    }
    const effectiveAgent = step.type === "agent" ? resolveEffectiveAgentStep(step, artifacts) : undefined;
    const selectedVariant = effectiveAgent?.variant;
    if (selectedVariant) result.variant = selectedVariant.id;
    if (step.type === "agent" && step.variants && !effectiveAgent) {
      result.status = "skipped";
      result.control = "continue";
      result.finished_at = new Date().toISOString();
      artifacts[recordId] = { status: "skipped", output: "" };
      artifacts[`${recordId}.output`] = "";
      if (!quiet) console.log(`↷ ${recordId} skipped (no variant matched)`); await store.save(run); return "continue";
    }
    if (!quiet) process.stdout.write(`→ ${recordId}\r`);
    if (step.type === "loop") {
      const control = await executeLoop(step, result, recordId, run, store, artifacts, root, cwd, quiet, agentSessions, onProgress, workflowSource);
      if (control !== "continue") return control;
      const stopped = applyStopWhen(step, result, artifacts);
      result.finished_at = new Date().toISOString(); await store.save(run);
      if (!quiet) console.log(stopped ? `✗ ${recordId}: ${result.message}` : `✓ ${recordId} completed after ${(result.result as LoopResult).iterations.length} iteration(s)`);
      return stopped ? "stop" : "continue";
    }
    if (step.type === "shell" || step.type === "exec") {
      const r = step.type === "shell"
        ? await runShell(render(step.command, artifacts), step.cwd ? resolve(cwd, step.cwd) : cwd, step.timeout, step.shell, quiet ? "never" : step.console ?? "always")
        : await runExec(render(step.program, artifacts), (step.args ?? []).map((arg) => render(arg, artifacts)), step.cwd ? resolve(cwd, step.cwd) : cwd, step.timeout, quiet ? "never" : step.console ?? "always");
      result.result = r;
      const normalizedOutput = normalizeStepOutput(stripAnsi(r.output), step.outputFormat);
      const previous = step.history ? priorHistory(artifacts[step.id]) : [];
      const stepArtifact: Record<string, any> = { ...r, output: normalizedOutput };
      if (step.outputs?.length) {
        if (Array.isArray(normalizedOutput) && step.outputs.length > 1) {
          stepArtifact[step.outputs[0]] = normalizedOutput[0] ?? "";
          stepArtifact[step.outputs[1]] = normalizedOutput.slice(1);
        } else for (const output of step.outputs) stepArtifact[output] = normalizedOutput;
      }
      if (step.history) appendHistory(stepArtifact, previous, historyEntry(stepArtifact, step.outputs, normalizedOutput));
      artifacts[step.id] = stepArtifact; artifacts[`${step.id}.output`] = normalizedOutput;
      const stopped = applyStopWhen(step, result, artifacts);
      if (step.stopWhen) {
        result.status = "succeeded";
        result.control = stopped ? "stop" : "continue";
        stepArtifact.status = result.status;
        stepArtifact.control = result.control;
        result.finished_at = new Date().toISOString(); await store.save(run);
        if (!quiet) console.log(stopped ? `✗ ${recordId}: ${result.message}` : `✓ ${recordId}`);
        return stopped ? "stop" : "continue";
      }
      result.status = r.exit_code === 0 ? "succeeded" : "failed";
      result.control = "continue";
      stepArtifact.status = result.status;
      stepArtifact.control = result.control;
      result.finished_at = new Date().toISOString(); await store.save(run);
      if (!quiet) console.log(r.exit_code === 0 ? `✓ ${recordId}` : `✗ ${recordId} (exit ${r.exit_code})`);
      return "continue";
    }
    const agentStep = effectiveAgent!.step;
    const renderedPrompt = await makePrompt(agentStep, root, cwd, artifacts, run.workflow, workflowSource === undefined ? undefined : { stepId: recordId, workflowSource });
    const prompt = renderedPrompt.text;
    const effectiveTools = resolveEffectiveTools(agentStep.tools, agentStep.writes ?? false);
    const before = agentStep.writes ? snapshotWorkspace(cwd) : undefined;
    let sharedSession: AgentSessionHandle | undefined;
    if (agentStep.context) {
      sharedSession = agentSessions.get(agentStep.context);
      if (sharedSession && (sharedSession.model !== agentStep.model || sharedSession.writes !== (agentStep.writes ?? false) || !sameTools(sharedSession.effective_tools, effectiveTools))) throw new Error(`Shared agent context ${agentStep.context} must use the same model, writes setting, and tools allowlist`);
      if (!sharedSession) {
        sharedSession = await createAgentSession(cwd, agentStep.model, agentStep.writes ?? false, agentStep.thinkingLevel, effectiveTools);
        agentSessions.set(agentStep.context, sharedSession);
      }
    }
    const r = await runAgent(prompt, cwd, agentStep.model, agentStep.writes ?? false, quiet, sharedSession, renderedPrompt.path, renderedPrompt.input_chars, agentStep.thinkingLevel, effectiveTools, (update) => {
      emitAgentProgress(onProgress, run, result, update, loopIteration);
    });
    const previous = agentStep.history ? priorHistory(artifacts[agentStep.id]) : [];
    const after = agentStep.writes ? snapshotWorkspace(cwd) : undefined;
    const agentResult = { ...r, ...(before && after ? { changed: workspaceChanged(before, after), changed_files: changedFiles(before, after) } : {}) };
    result.result = agentResult;
    const finalStopReason = agentResult.stop_reasons.at(-1);
    if (finalStopReason === "error" || finalStopReason === "aborted") throw new Error(agentResult.error_message ?? `Agent stopped with reason: ${finalStopReason}`);
    const agentOutput = stripAnsi(agentResult.output);
    const agentArtifact = { ...agentResult, output: agentStep.outputFormat === "single-line" ? normalizeSingleLine(agentOutput) : agentOutput };
    artifacts[agentStep.id] = agentArtifact;
    if (agentStep.outputFormat === "json") {
      let parsed: any; try { parsed = JSON.parse(agentOutput.trim()); } catch { throw new Error("Agent produced malformed JSON output"); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Agent JSON output must be an object");
      for (const output of agentStep.outputs ?? []) { if (typeof parsed[output] !== "string") throw new Error(`Agent JSON output is missing string field: ${output}`); artifacts[output] = stripAnsi(parsed[output]); }
      if (agentStep.outputs?.includes("generated_commit_message") && !artifacts.generated_commit_message.trim()) throw new Error("Agent produced an empty generated commit message");
    } else for (const output of agentStep.outputs ?? []) artifacts[output] = agentArtifact.output;
    // An output may intentionally have the same name as the step ID. In that
    // case the alias is a scalar, not the step artifact object.
    if (artifacts[agentStep.id] && typeof artifacts[agentStep.id] === "object") {
      for (const output of agentStep.outputs ?? []) (artifacts[agentStep.id] as Record<string, unknown>)[output] = artifacts[output];
      if (agentStep.history) appendHistory(artifacts[agentStep.id] as Record<string, unknown>, previous, historyEntry(artifacts[agentStep.id] as Record<string, unknown>, agentStep.outputs, agentArtifact.output));
    }
    result.status = "succeeded";
    result.control = "continue";
    const stopped = applyStopWhen(agentStep, result, artifacts);
    if (artifacts[agentStep.id] && typeof artifacts[agentStep.id] === "object") {
      (artifacts[agentStep.id] as Record<string, unknown>).status = result.status;
      (artifacts[agentStep.id] as Record<string, unknown>).control = result.control;
    }
    result.finished_at = new Date().toISOString(); await store.save(run);
    if (!quiet) console.log(stopped ? `✗ ${recordId}: ${result.message}` : `✓ ${recordId}`);
    return stopped ? "stop" : "continue";
  } catch (error) {
    if (error instanceof AgentExecutionError) result.result = error.agentResult;
    result.status = "failed"; result.error = formatStepError(error); result.finished_at = new Date().toISOString(); await store.save(run); if (!quiet) console.error(`✗ ${recordId}: ${result.error}`); return "fail";
  } finally {
    if (result.finished_at) {
      await store.save(run);
      emitStepProgress(onProgress, "step_finished", run, result, loopIteration);
    }
  }
}

function emitStepProgress(onProgress: FlowProgressCallback | undefined, type: FlowStepProgressEvent["type"], run: RunState, result: StepResult, loopIteration?: number): void {
  if (!onProgress) return;
  const finished = result.finished_at ? Date.parse(result.finished_at) : Date.now();
  onProgress({ type, run_id: run.id, flow: run.workflow, id: result.id, declared_id: result.declared_id, status: result.status, duration_ms: Math.max(0, finished - Date.parse(result.started_at)), ...(result.loop_id ? { loop_id: result.loop_id } : {}), ...(loopIteration !== undefined ? { loop_iteration: loopIteration } : {}) });
}

function emitAgentProgress(onProgress: FlowProgressCallback | undefined, run: RunState, result: StepResult, update: { usage?: AgentUsage; turns: number; tool_calls: number; retries: number }, loopIteration?: number): void {
  if (!onProgress) return;
  const event: FlowAgentProgressEvent = {
    type: "agent_progress", run_id: run.id, flow: run.workflow, id: result.id, declared_id: result.declared_id, status: "running",
    duration_ms: Math.max(0, Date.now() - Date.parse(result.started_at)),
    ...(update.usage ? { usage: update.usage } : {}), turns: update.turns, tool_calls: update.tool_calls, retries: update.retries,
    ...(result.loop_id ? { loop_id: result.loop_id } : {}), ...(loopIteration !== undefined ? { loop_iteration: loopIteration } : {}),
  };
  onProgress(event);
}

async function executeLoop(step: LoopStep, result: StepResult, recordId: string, run: RunState, store: RunStoreLike, artifacts: ArtifactMap, root: string, cwd: string, quiet: boolean, agentSessions: Map<string, AgentSessionHandle>, onProgress?: FlowProgressCallback, workflowSource?: string): Promise<StepControl> {
  const maxIterations = step.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const loopResult: LoopResult = { iterations: [], until: step.until, maxIterations, exhausted: false };
  result.result = loopResult;
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const started = new Date().toISOString();
    const control = await executeSteps(step.steps, (child) => executeStep(child, `${recordId}[${iteration}].${child.id}`, run, store, artifacts, root, cwd, quiet, agentSessions, onProgress, recordId, iteration, workflowSource), { run, store, artifacts, root, cwd, quiet, agentSessions, onProgress, workflowSource, loopId: recordId, loopIteration: iteration });
    if (control !== "continue") {
      loopResult.iterations.push({ iteration, started_at: started, finished_at: new Date().toISOString(), status: control === "stop" ? "succeeded" : "failed", until: false });
      result.status = control === "stop" ? "succeeded" : "failed"; result.control = control === "stop" ? "stop" : "continue"; result.finished_at = new Date().toISOString(); await store.save(run); return control;
    }
    let until: boolean;
    try {
      until = shouldRun(step.until, artifacts);
    } catch (error) {
      loopResult.iterations.push({ iteration, started_at: started, finished_at: new Date().toISOString(), status: "failed", until: false });
      await store.save(run);
      throw error;
    }
    loopResult.iterations.push({ iteration, started_at: started, finished_at: new Date().toISOString(), status: until ? "succeeded" : "failed", until });
    result.status = until ? "succeeded" : "running";
    result.control = "continue";
    await store.save(run);
    if (until) { return "continue"; }
  }
  loopResult.exhausted = true; result.status = "failed"; result.control = "continue"; result.error = `${recordId} exhausted its ${maxIterations} iteration limit`; result.finished_at = new Date().toISOString(); await store.save(run); if (!quiet) console.error(`✗ ${recordId}: ${result.error}`); return "fail";
}

function priorHistory(artifact: unknown): unknown[] {
  return artifact && typeof artifact === "object" && Array.isArray((artifact as Record<string, unknown>).history)
    ? [...(artifact as Record<string, unknown>).history as unknown[]]
    : [];
}

export function historyEntry(artifact: Record<string, unknown>, outputs: string[] | undefined, output: unknown): unknown {
  if (!outputs?.length) return output;
  return Object.fromEntries(outputs.map((name) => [name, artifact[name]]));
}

function appendHistory(artifact: Record<string, unknown>, previous: unknown[], entry: unknown): void {
  artifact.history = [...previous, entry];
}

function applyStopWhen(step: Step, result: StepResult, artifacts: ArtifactMap): boolean | undefined {
  if (!step.stopWhen) return undefined;
  const stopped = shouldRun(step.stopWhen, artifacts);
  result.status = "succeeded";
  result.control = stopped ? "stop" : "continue";
  if (stopped) result.message = step.stopMessage ?? `Stopped by ${step.id}`;
  return stopped;
}

export function resolveEffectiveAgentStep(step: AgentStep, artifacts: ArtifactMap): { step: AgentStep; variant?: NonNullable<AgentStep["variants"]>[number] } | undefined {
  const variant = step.variants?.find((candidate) => shouldRun(candidate.when, artifacts));
  if (step.variants && !variant) return undefined;
  return { step: variant ? { ...step, ...variant, id: step.id, variants: undefined } : step, ...(variant ? { variant } : {}) };
}

function sameTools(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((tool, index) => tool === right[index]);
}

function formatStepError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 2000 ? `${message.slice(0, 2000)}\n[error truncated; inspect step evidence for full output]` : message;
}

function normalizeStepOutput(value: string, format: "text" | "single-line" | "lines" | "json" | undefined): string | string[] {
  if (format === "lines") return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (format === "single-line") return value.trim().split(/\r?\n/)[0] ?? "";
  return value;
}

function resolveWorkflowOutputs(workflow: Workflow, artifacts: ArtifactMap): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  for (const [name, expression] of Object.entries(workflow.outputs ?? {})) {
    outputs[name] = evaluateOutputExpression(name, expression, (path) => lookup(path, artifacts));
  }
  return outputs;
}

function findPromptPath(prompt: string, root: string, cwd: string, workflowName: string): string {
  if (isAbsolute(prompt)) {
    if (!existsSync(prompt)) throw new Error(`Prompt file not found: ${prompt}`);
    return prompt;
  }
  const candidates = prompt.includes("/")
    ? [resolve(root, prompt), resolve(root, "prompts", prompt), resolve(cwd, prompt)]
    : [resolve(root, "prompts", workflowName, prompt), resolve(root, prompt), resolve(root, "prompts", prompt), resolve(cwd, prompt)];
  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) throw new Error(`Prompt file not found: ${prompt} (looked in ${candidates.join(", ")})`);
  return match;
}

function normalizeSingleLine(value: string): string {
  let result = value.trim().replace(/^```(?:text|markdown)?\s*|```$/g, "").trim();
  result = result.replace(/^commit message:\s*/i, "").split(/\r?\n/)[0].trim();
  if (!result) throw new Error("Agent produced an empty commit message");
  return result;
}

function projectArtifacts(paths: string[], artifacts: ArtifactMap): ArtifactMap {
  const projected: ArtifactMap = {};
  for (const path of paths) {
    const value = lookup(path, artifacts);
    if (value === undefined) continue;
    const parts = path.split(".");
    let target = projected;
    for (const part of parts.slice(0, -1)) {
      const existing = target[part];
      target = target[part] = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing } : {};
    }
    target[parts.at(-1)!] = value;
  }
  return projected;
}

export async function makePrompt(step: AgentStep, root: string, cwd: string, artifacts: ArtifactMap, workflowName: string, executionMetadata?: { readonly stepId: string; readonly workflowSource: string }): Promise<{ text: string; path: string; input_chars: Record<string, number> }> {
  if (!step.prompt) throw new Error(`${step.id}: no prompt selected`);
  const promptPath = findPromptPath(step.prompt, root, cwd, workflowName);
  const prompt = await readFile(promptPath, "utf8");
  const promptArtifacts = projectArtifacts(step.inputs ?? [], artifacts);
  const availableInputs = (step.inputs ?? []).filter((key) => lookup(key, promptArtifacts) !== undefined);
  const input_chars = Object.fromEntries(availableInputs.map((key) => [key, JSON.stringify(lookup(key, promptArtifacts), null, 2).length]));
  const inputs = availableInputs.map((key) => `\n--- ${key} ---\n${JSON.stringify(lookup(key, promptArtifacts), null, 2)}`).join("\n");
  const suffix = step.outputFormat === "single-line" || step.outputFormat === "json" ? "" : "\n\nOperate in the current repository. Return a concise summary of your work and decisions.";
  const metadata = executionMetadata === undefined ? "" : `\n\n--- Read-only execution metadata ---\nCurrent agent step ID: ${executionMetadata.stepId}\nWorkflow source YAML (verbatim):\n${executionMetadata.workflowSource}\nDo not duplicate any \`exec\` or \`shell\` command declared in this workflow YAML. You may run commands needed for implementation or diagnosis when they are not declared in the workflow. Do not duplicate work assigned to other agent steps. Use available declared artifacts from prior agent steps, and leave work assigned to later agent steps for those steps. You may perform work needed for your own assignment.\n--- End read-only execution metadata ---`;
  return { text: `${render(prompt, promptArtifacts)}${inputs}${metadata}${suffix}`, path: promptPath, input_chars };
}

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { runExec, runShell } from "./command.js";
import { stripAnsi } from "./ansi.js";
import { createAgentSession, runAgent, type AgentSessionHandle } from "./pi-agent.js";
import { changedFiles, snapshotWorkspace, workspaceChanged } from "./workspace.js";
import { RunStore, makeRunId, type RunStoreLike } from "./artifacts.js";
import type { AgentStep, AgentUsage, LoopStep, LoopResult, RunState, Step, StepResult, Workflow } from "./types.js";

export type ArtifactMap = Record<string, any>;
export interface ExecuteOptions { workflow: Workflow; root: string; cwd: string; inputs?: ArtifactMap; output?: "normal" | "quiet"; }
const DEFAULT_MAX_ITERATIONS = 10;

function lookup(path: string, artifacts: ArtifactMap): any {
  const parts = path.split("."); let value = artifacts[parts.shift()!];
  for (const part of parts) value = value?.[part];
  return value;
}

function render(value: string, artifacts: ArtifactMap): string {
  return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, key) => String(lookup(key.trim(), artifacts) ?? ""));
}

type TriState = true | false | undefined;

function shouldRun(expression: string | undefined, artifacts: ArtifactMap): boolean {
  if (!expression) return true;
  return evaluateCondition(expression, artifacts) === true;
}

function evaluateCondition(expression: string, artifacts: ArtifactMap): TriState {
  return evaluateOr(expression.trim(), artifacts);
}

function evaluateOr(expression: string, artifacts: ArtifactMap): TriState {
  const parts = splitTopLevel(expression, "||");
  let sawUnknown = false;
  for (const part of parts) {
    const value = evaluateAnd(part, artifacts);
    if (value === true) return true;
    if (value === undefined) sawUnknown = true;
  }
  return sawUnknown ? undefined : false;
}

function evaluateAnd(expression: string, artifacts: ArtifactMap): TriState {
  const parts = splitTopLevel(expression, "&&");
  let sawUnknown = false;
  for (const part of parts) {
    const value = evaluatePrimary(part, artifacts);
    if (value === false) return false;
    if (value === undefined) sawUnknown = true;
  }
  return sawUnknown ? undefined : true;
}

function evaluatePrimary(expression: string, artifacts: ArtifactMap): TriState {
  const unwrapped = unwrapParentheses(expression.trim());
  return unwrapped === expression.trim()
    ? evaluateComparison(unwrapped, artifacts)
    : evaluateOr(unwrapped, artifacts);
}

function splitTopLevel(expression: string, operator: "&&" | "||"): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < expression.length; index++) {
    const character = expression[index];
    if (character === "(") depth++;
    else if (character === ")") {
      depth--;
      if (depth < 0) throw new Error(`Unbalanced condition: ${expression}`);
    }
    if (depth === 0 && expression.startsWith(operator, index)) {
      parts.push(expression.slice(start, index).trim());
      start = index + operator.length;
      index += operator.length - 1;
    }
  }
  if (depth !== 0) throw new Error(`Unbalanced condition: ${expression}`);
  parts.push(expression.slice(start).trim());
  if (parts.some((part) => !part)) throw new Error(`Invalid condition: ${expression}`);
  return parts;
}

function unwrapParentheses(expression: string): string {
  if (!expression.startsWith("(") || !expression.endsWith(")")) return expression;
  let depth = 0;
  for (let index = 0; index < expression.length; index++) {
    if (expression[index] === "(") depth++;
    else if (expression[index] === ")") depth--;
    if (depth === 0 && index < expression.length - 1) return expression;
  }
  if (depth !== 0) throw new Error(`Unbalanced condition: ${expression}`);
  return expression.slice(1, -1).trim();
}

function evaluateComparison(expression: string, artifacts: ArtifactMap): TriState {
  const match = expression.match(/^([\w.-]+)\s*(==|!=)\s*(.+)$/);
  if (!match) throw new Error(`Unsupported condition: ${expression}`);
  const actual = lookup(match[1], artifacts);
  if (actual === undefined) return undefined;
  let expected: unknown = match[3].trim().replace(/^['\"]|['\"]$/g, "");
  if (expected === "true") expected = true;
  else if (expected === "false") expected = false;
  else if (/^-?\d+(\.\d+)?$/.test(String(expected))) expected = Number(expected);
  return match[2] === "==" ? actual === expected : actual !== expected;
}

export async function execute(options: ExecuteOptions): Promise<RunState> {
  const { workflow, root, cwd } = options;
  const quiet = options.output === "quiet";
  const run: RunState = { id: makeRunId(), workflow: workflow.name, cwd, started_at: new Date().toISOString(), status: "running", steps: [] };
  const store = new RunStore(cwd);
  const artifacts: ArtifactMap = { ...(options.inputs ?? {}) };
  const agentSessions = new Map<string, AgentSessionHandle>();
  await store.save(run);
  if (!quiet) console.log(`\nflow ${workflow.name} · run ${run.id}\n`);
  const context: ExecutionContext = { run, store, artifacts, root, cwd, quiet, agentSessions };
  const control = await executeSteps(workflow.steps, (step) => executeStep(step, step.id, run, store, artifacts, root, cwd, quiet, agentSessions), context);
  if (control !== "continue") { run.status = control === "stop" ? "succeeded" : "failed"; run.outputs = resolveWorkflowOutputs(workflow, artifacts); run.finished_at = new Date().toISOString(); updateRunMetadata(run); await store.save(run); disposeAgentSessions(agentSessions); return run; }
  const topLevelSteps = new Map(workflow.steps.map((step) => [step.id, step]));
  const failed = run.steps.some((result) => {
    const step = topLevelSteps.get(result.id);
    return step !== undefined && !step.stopWhen && result.status === "failed" && (result.type === "loop" || result.type === "shell" || result.type === "exec");
  });
  run.status = failed ? "failed" : "succeeded";
  run.outputs = resolveWorkflowOutputs(workflow, artifacts);
  run.finished_at = new Date().toISOString();
  updateRunMetadata(run);
  await store.save(run);
  disposeAgentSessions(agentSessions);
  if (!quiet) console.log(`\n${run.status === "succeeded" ? "✓" : "✗"} completed ${run.id}`); return run;
}

type StepControl = "continue" | "stop" | "fail";
type ExecutionContext = { run: RunState; store: RunStoreLike; artifacts: ArtifactMap; root: string; cwd: string; quiet: boolean; agentSessions: Map<string, AgentSessionHandle> };

function disposeAgentSessions(sessions: Map<string, AgentSessionHandle>): void {
  for (const handle of sessions.values()) handle.session.dispose?.();
  sessions.clear();
}

function updateRunMetadata(run: RunState): void {
  const usage: AgentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  let hasUsage = false;
  let step_duration_ms = 0;
  let agent_steps = 0;
  let turns = 0;
  let tool_calls = 0;
  let retries = 0;
  const providers = new Set<string>();
  const response_models = new Set<string>();
  const contexts = new Set<string>();
  const apis = new Set<string>();
  const tool_names = new Set<string>();
  let tool_failures = 0;
  for (const step of run.steps) {
    if (step.finished_at) step_duration_ms += Math.max(0, Date.parse(step.finished_at) - Date.parse(step.started_at));
    const agentResult = step.result as any;
    if (step.type === "agent" && agentResult) {
      agent_steps++;
      turns += agentResult.turns ?? 0;
      tool_calls += agentResult.tool_calls ?? 0;
      retries += agentResult.retries ?? 0;
      if (agentResult.provider) providers.add(agentResult.provider);
      if (agentResult.api) apis.add(agentResult.api);
      if (agentResult.response_model) response_models.add(agentResult.response_model);
      if (agentResult.context_id) contexts.add(agentResult.context_id);
      for (const name of agentResult.tool_names ?? []) tool_names.add(name);
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
  run.agent_metrics = { agent_steps, turns, tool_calls, retries, providers: [...providers].sort(), apis: [...apis].sort(), response_models: [...response_models].sort(), contexts: [...contexts].sort(), tool_names: [...tool_names].sort(), tool_failures };
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
  const workerRun: RunState = { ...context.run, steps: [] };
  const workerArtifacts: ArtifactMap = { ...context.artifacts };
  const workerStore: RunStoreLike = { save: async () => undefined };
  const control = await executeStep(step, step.id, workerRun, workerStore, workerArtifacts, context.root, context.cwd, true, context.agentSessions);
  return { control, steps: workerRun.steps, artifacts: workerArtifacts };
}

async function executeStep(step: Step, recordId: string, run: RunState, store: RunStoreLike, artifacts: ArtifactMap, root: string, cwd: string, quiet: boolean, agentSessions: Map<string, AgentSessionHandle>): Promise<StepControl> {
  if (!shouldRun(step.when, artifacts)) {
    run.steps.push({ id: recordId, type: step.type, status: "skipped", control: "continue", started_at: new Date().toISOString(), finished_at: new Date().toISOString() });
    artifacts[recordId] = { status: "skipped", output: "" };
    artifacts[`${recordId}.output`] = "";
    if (!quiet) console.log(`↷ ${recordId} skipped`); await store.save(run); return "continue";
  }
  const selectedVariant = step.type === "agent" && step.variants
    ? step.variants.find((variant) => shouldRun(variant.when, artifacts))
    : undefined;
  if (step.type === "agent" && step.variants && !selectedVariant) {
    run.steps.push({ id: recordId, type: step.type, status: "skipped", control: "continue", started_at: new Date().toISOString(), finished_at: new Date().toISOString() });
    artifacts[recordId] = { status: "skipped", output: "" };
    artifacts[`${recordId}.output`] = "";
    if (!quiet) console.log(`↷ ${recordId} skipped (no variant matched)`); await store.save(run); return "continue";
  }
  const result: StepResult = { id: recordId, type: step.type, status: "running", ...(selectedVariant ? { variant: selectedVariant.id } : {}), started_at: new Date().toISOString() };
  run.steps.push(result); await store.save(run); if (!quiet) process.stdout.write(`→ ${recordId}\r`);
  try {
    if (step.type === "loop") {
      const control = await executeLoop(step, result, recordId, run, store, artifacts, root, cwd, quiet, agentSessions);
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
    const agentStep = (selectedVariant ? { ...step, ...selectedVariant, id: step.id, variants: undefined } : step) as AgentStep;
    const renderedPrompt = await makePrompt(agentStep, root, cwd, artifacts, run.workflow);
    const prompt = renderedPrompt.text;
    const before = agentStep.writes ? snapshotWorkspace(cwd) : undefined;
    let sharedSession: AgentSessionHandle | undefined;
    if (agentStep.context) {
      sharedSession = agentSessions.get(agentStep.context);
      if (sharedSession && (sharedSession.model !== agentStep.model || sharedSession.writes !== (agentStep.writes ?? false))) throw new Error(`Shared agent context ${agentStep.context} must use the same model and writes setting`);
      if (!sharedSession) {
        sharedSession = await createAgentSession(cwd, agentStep.model, agentStep.writes ?? false, agentStep.thinkingLevel);
        agentSessions.set(agentStep.context, sharedSession);
      }
    }
    const r = await runAgent(prompt, cwd, agentStep.model, agentStep.writes ?? false, quiet, sharedSession, renderedPrompt.path, renderedPrompt.input_chars, agentStep.thinkingLevel);
    const previous = agentStep.history ? priorHistory(artifacts[agentStep.id]) : [];
    const after = agentStep.writes ? snapshotWorkspace(cwd) : undefined;
    const agentResult = { ...r, ...(before && after ? { changed: workspaceChanged(before, after), changed_files: changedFiles(before, after) } : {}) };
    const agentOutput = stripAnsi(agentResult.output);
    const agentArtifact = { ...agentResult, output: agentStep.outputFormat === "single-line" ? normalizeSingleLine(agentOutput) : agentOutput };
    result.result = agentResult; artifacts[agentStep.id] = agentArtifact;
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
    result.status = "failed"; result.error = formatStepError(error); result.finished_at = new Date().toISOString(); await store.save(run); if (!quiet) console.error(`✗ ${recordId}: ${result.error}`); return "fail";
  }
}

async function executeLoop(step: LoopStep, result: StepResult, recordId: string, run: RunState, store: RunStoreLike, artifacts: ArtifactMap, root: string, cwd: string, quiet: boolean, agentSessions: Map<string, AgentSessionHandle>): Promise<StepControl> {
  const maxIterations = step.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const loopResult: LoopResult = { iterations: [], until: step.until, maxIterations, exhausted: false };
  result.result = loopResult;
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const started = new Date().toISOString();
    const control = await executeSteps(step.steps, (child) => executeStep(child, `${recordId}[${iteration}].${child.id}`, run, store, artifacts, root, cwd, quiet, agentSessions), { run, store, artifacts, root, cwd, quiet, agentSessions });
    if (control !== "continue") {
      loopResult.iterations.push({ iteration, started_at: started, finished_at: new Date().toISOString(), status: control === "stop" ? "succeeded" : "failed", until: false });
      result.status = control === "stop" ? "succeeded" : "failed"; result.control = control === "stop" ? "stop" : "continue"; result.finished_at = new Date().toISOString(); await store.save(run); return control;
    }
    const until = shouldRun(step.until, artifacts);
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
    const values = expression.split(/\s*\|\|\s*/).map((candidate) => evaluateValue(candidate.trim(), artifacts));
    const value = values.find((candidate) => Boolean(candidate)) ?? values.find((candidate) => candidate !== undefined && candidate !== "");
    if (value !== undefined) outputs[name] = value;
  }
  return outputs;
}

function evaluateValue(expression: string, artifacts: ArtifactMap): unknown {
  if (expression === "true") return true;
  if (expression === "false") return false;
  const comparison = expression.match(/^([\w.-]+)\s*(==|!=)\s*(.+)$/);
  if (!comparison) return lookup(expression, artifacts);
  const actual = lookup(comparison[1], artifacts);
  if (actual === undefined) return undefined;
  let expected: unknown = comparison[3].trim().replace(/^['"]|['"]$/g, "");
  if (expected === "true") expected = true;
  else if (expected === "false") expected = false;
  else if (/^-?\d+(\.\d+)?$/.test(String(expected))) expected = Number(expected);
  return comparison[2] === "==" ? actual === expected : actual !== expected;
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

async function makePrompt(step: AgentStep, root: string, cwd: string, artifacts: ArtifactMap, workflowName: string): Promise<{ text: string; path: string; input_chars: Record<string, number> }> {
  if (!step.prompt) throw new Error(`${step.id}: no prompt selected`);
  const promptPath = findPromptPath(step.prompt, root, cwd, workflowName);
  const prompt = await readFile(promptPath, "utf8");
  const input_chars = Object.fromEntries((step.inputs ?? []).map((key) => [key, JSON.stringify(lookup(key, artifacts), null, 2)?.length ?? 0]));
  const inputs = (step.inputs ?? []).map((key) => `\n--- ${key} ---\n${JSON.stringify(lookup(key, artifacts), null, 2)}`).join("\n");
  const suffix = step.outputFormat === "single-line" || step.outputFormat === "json" ? "" : "\n\nOperate in the current repository. Return a concise summary of your work and decisions.";
  return { text: `${render(prompt, artifacts)}${inputs}${suffix}`, path: promptPath, input_chars };
}

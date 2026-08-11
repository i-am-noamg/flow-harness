import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runExec, runShell } from "./command.js";
import { runAgent } from "./pi-agent.js";
import { changedFiles, snapshotWorkspace, workspaceChanged } from "./workspace.js";
import { RunStore, makeRunId } from "./artifacts.js";
import type { AgentStep, LoopStep, LoopResult, RunState, Step, StepResult, Workflow } from "./types.js";

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
  let sawUnknown = false;
  for (const alternative of expression.split(/\s*\|\|\s*/)) {
    let alternativeUnknown = false;
    let alternativeResult: TriState = true;
    for (const part of alternative.replace(/[()]/g, "").split(/\s*&&\s*/)) {
      const value = evaluateComparison(part.trim(), artifacts);
      if (value === false) { alternativeResult = false; break; }
      if (value === undefined) alternativeUnknown = true;
    }
    if (alternativeResult === true && !alternativeUnknown) return true;
    if (alternativeResult === true && alternativeUnknown) sawUnknown = true;
  }
  return sawUnknown ? undefined : false;
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
  await store.save(run);
  if (!quiet) console.log(`\nflow ${workflow.name} · run ${run.id}\n`);
  const control = await executeSteps(workflow.steps, (step) => executeStep(step, step.id, run, store, artifacts, root, cwd, quiet));
  if (control !== "continue") { run.status = control === "stop" ? "succeeded" : "failed"; run.outputs = resolveWorkflowOutputs(workflow, artifacts); run.finished_at = new Date().toISOString(); await store.save(run); return run; }
  const topLevelSteps = new Map(workflow.steps.map((step) => [step.id, step]));
  const failed = run.steps.some((result) => {
    const step = topLevelSteps.get(result.id);
    return step !== undefined && !step.stopWhen && result.status === "failed" && (result.type === "loop" || result.type === "shell" || result.type === "exec");
  });
  run.status = failed ? "failed" : "succeeded";
  run.outputs = resolveWorkflowOutputs(workflow, artifacts);
  run.finished_at = new Date().toISOString(); await store.save(run);
  if (!quiet) console.log(`\n${run.status === "succeeded" ? "✓" : "✗"} completed ${run.id}`); return run;
}

type StepControl = "continue" | "stop" | "fail";

/** Run consecutive steps marked parallel together; unmarked steps remain barriers. */
async function executeSteps(steps: Step[], execute: (step: Step) => Promise<StepControl>): Promise<StepControl> {
  for (let index = 0; index < steps.length;) {
    if (!steps[index].parallel) {
      const control = await execute(steps[index++]);
      if (control !== "continue") return control;
      continue;
    }
    const batch: Step[] = [];
    while (index < steps.length && steps[index].parallel) batch.push(steps[index++]);
    const controls = await Promise.all(batch.map(execute));
    if (controls.includes("fail")) return "fail";
    if (controls.includes("stop")) return "stop";
  }
  return "continue";
}

async function executeStep(step: Step, recordId: string, run: RunState, store: RunStore, artifacts: ArtifactMap, root: string, cwd: string, quiet: boolean): Promise<StepControl> {
  if (!shouldRun(step.when, artifacts)) {
    run.steps.push({ id: recordId, type: step.type, status: "skipped", control: "continue", started_at: new Date().toISOString(), finished_at: new Date().toISOString() });
    artifacts[recordId] = { status: "skipped", output: "" };
    artifacts[`${recordId}.output`] = "";
    if (!quiet) console.log(`↷ ${recordId} skipped`); await store.save(run); return "continue";
  }
  const result: StepResult = { id: recordId, type: step.type, status: "running", started_at: new Date().toISOString() };
  run.steps.push(result); await store.save(run); if (!quiet) process.stdout.write(`→ ${recordId}\r`);
  try {
    if (step.type === "loop") {
      const control = await executeLoop(step, result, recordId, run, store, artifacts, root, cwd, quiet);
      if (control !== "continue") return control;
      const stopped = applyStopWhen(step, result, artifacts);
      result.finished_at = new Date().toISOString(); await store.save(run);
      if (!quiet) console.log(stopped ? `✗ ${recordId}: ${result.message}` : `✓ ${recordId} completed after ${(result.result as LoopResult).iterations.length} iteration(s)`);
      return stopped ? "stop" : "continue";
    }
    if (step.type === "shell" || step.type === "exec") {
      const r = step.type === "shell"
        ? await runShell(render(step.command, artifacts), step.cwd ? resolve(cwd, step.cwd) : cwd, step.timeout, step.shell, quiet ? "never" : step.output ?? "always")
        : await runExec(render(step.program, artifacts), (step.args ?? []).map((arg) => render(arg, artifacts)), step.cwd ? resolve(cwd, step.cwd) : cwd, step.timeout, quiet ? "never" : step.output ?? "always");
      result.result = r;
      const normalizedOutput = normalizeStepOutput(r.output, step.outputFormat);
      const stepArtifact: Record<string, any> = { ...r, output: normalizedOutput };
      if (step.outputs?.length) {
        if (Array.isArray(normalizedOutput) && step.outputs.length > 1) {
          stepArtifact[step.outputs[0]] = normalizedOutput[0] ?? "";
          stepArtifact[step.outputs[1]] = normalizedOutput.slice(1);
        } else for (const output of step.outputs) stepArtifact[output] = normalizedOutput;
      }
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
    const agentStep = step as AgentStep;
    const prompt = await makePrompt(agentStep, root, artifacts);
    const before = agentStep.writes ? snapshotWorkspace(cwd) : undefined;
    const r = await runAgent(prompt, cwd, agentStep.model, agentStep.writes ?? false, quiet);
    const after = agentStep.writes ? snapshotWorkspace(cwd) : undefined;
    const agentResult = { ...r, ...(before && after ? { changed: workspaceChanged(before, after), changed_files: changedFiles(before, after) } : {}) };
    if (agentStep.outputFormat === "single-line") agentResult.output = normalizeSingleLine(agentResult.output);
    result.result = agentResult; artifacts[agentStep.id] = agentResult;
    if (agentStep.outputFormat === "json") {
      let parsed: any; try { parsed = JSON.parse(agentResult.output.trim()); } catch { throw new Error("Agent produced malformed JSON output"); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Agent JSON output must be an object");
      for (const output of agentStep.outputs ?? []) { if (typeof parsed[output] !== "string") throw new Error(`Agent JSON output is missing string field: ${output}`); artifacts[output] = parsed[output]; }
      if (agentStep.outputs?.includes("generated_commit_message") && !artifacts.generated_commit_message.trim()) throw new Error("Agent produced an empty generated commit message");
    } else for (const output of agentStep.outputs ?? []) artifacts[output] = agentResult.output;
    for (const output of agentStep.outputs ?? []) (artifacts[agentStep.id] as Record<string, unknown>)[output] = artifacts[output];
    result.status = "succeeded";
    result.control = "continue";
    const stopped = applyStopWhen(agentStep, result, artifacts);
    (artifacts[agentStep.id] as Record<string, unknown>).status = result.status;
    (artifacts[agentStep.id] as Record<string, unknown>).control = result.control;
    result.finished_at = new Date().toISOString(); await store.save(run);
    if (!quiet) console.log(stopped ? `✗ ${recordId}: ${result.message}` : `✓ ${recordId}`);
    return stopped ? "stop" : "continue";
  } catch (error) {
    result.status = "failed"; result.error = error instanceof Error ? error.message : String(error); result.finished_at = new Date().toISOString(); await store.save(run); if (!quiet) console.error(`✗ ${recordId}: ${result.error}`); return "fail";
  }
}

async function executeLoop(step: LoopStep, result: StepResult, recordId: string, run: RunState, store: RunStore, artifacts: ArtifactMap, root: string, cwd: string, quiet: boolean): Promise<StepControl> {
  const maxIterations = step.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const loopResult: LoopResult = { iterations: [], until: step.until, maxIterations, exhausted: false };
  result.result = loopResult;
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const started = new Date().toISOString();
    const control = await executeSteps(step.steps, (child) => executeStep(child, `${recordId}[${iteration}].${child.id}`, run, store, artifacts, root, cwd, quiet));
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

function applyStopWhen(step: Step, result: StepResult, artifacts: ArtifactMap): boolean | undefined {
  if (!step.stopWhen) return undefined;
  const stopped = shouldRun(step.stopWhen, artifacts);
  result.status = "succeeded";
  result.control = stopped ? "stop" : "continue";
  if (stopped) result.message = step.stopMessage ?? `Stopped by ${step.id}`;
  return stopped;
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

function normalizeSingleLine(value: string): string {
  let result = value.trim().replace(/^```(?:text|markdown)?\s*|```$/g, "").trim();
  result = result.replace(/^commit message:\s*/i, "").split(/\r?\n/)[0].trim();
  if (!result) throw new Error("Agent produced an empty commit message");
  return result;
}

async function makePrompt(step: AgentStep, root: string, artifacts: ArtifactMap): Promise<string> {
  const workflowRelative = resolve(root, step.prompt);
  const projectRelative = resolve(process.cwd(), step.prompt);
  const promptPath = existsSync(workflowRelative) ? workflowRelative : projectRelative;
  const prompt = await readFile(promptPath, "utf8");
  const inputs = (step.inputs ?? []).map((key) => `\n--- ${key} ---\n${JSON.stringify(lookup(key, artifacts), null, 2)}`).join("\n");
  const suffix = step.outputFormat === "single-line" || step.outputFormat === "json" ? "" : "\n\nOperate in the current repository. Return a concise summary of your work and decisions.";
  return `${render(prompt, artifacts)}${inputs}${suffix}`;
}

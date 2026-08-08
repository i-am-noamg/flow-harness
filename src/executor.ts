import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runExec, runShell } from "./command.js";
import { runAgent } from "./pi-agent.js";
import { changedFiles, snapshotWorkspace, workspaceChanged } from "./workspace.js";
import { RunStore, makeRunId } from "./artifacts.js";
import type { AgentStep, LoopStep, LoopResult, RunState, Step, StepResult, Workflow } from "./types.js";

export type ArtifactMap = Record<string, any>;
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
  return expression.split(/\s*\|\|\s*/).some((alternative) => alternative.replace(/[()]/g, "").split(/\s*&&\s*/).every((part) => {
    const match = part.trim().match(/^([\w.-]+)\s*(==|!=)\s*(.+)$/);
    if (!match) throw new Error(`Unsupported condition: ${expression}`);
    const actual = lookup(match[1], artifacts);
    let expected: any = match[3].trim().replace(/^['"]|['"]$/g, "");
    if (expected === "true") expected = true; if (expected === "false") expected = false;
    if (/^-?\d+(\.\d+)?$/.test(expected)) expected = Number(expected);
    return match[2] === "==" ? actual === expected : actual !== expected;
  }));
}

export async function execute(workflow: Workflow, root: string, cwd: string, initialInputs: ArtifactMap = {}): Promise<RunState> {
  const run: RunState = { id: makeRunId(), workflow: workflow.name, cwd, started_at: new Date().toISOString(), status: "running", steps: [] };
  const store = new RunStore(cwd);
  const artifacts: ArtifactMap = { ...workflowDefaults(workflow.inputs), ...initialInputs };
  await store.save(run);
  console.log(`\nflow ${workflow.name} · run ${run.id}\n`);
  for (const step of workflow.steps) {
    const fatal = await executeStep(step, step.id, run, store, artifacts, root, cwd);
    if (fatal) { run.status = "failed"; run.finished_at = new Date().toISOString(); await store.save(run); return run; }
  }
  const topLevelSteps = new Map(workflow.steps.map((step) => [step.id, step]));
  const failed = run.steps.some((result) => {
    const step = topLevelSteps.get(result.id);
    return step !== undefined && !step.stopWhen && result.status === "failed" && (result.type === "loop" || result.type === "shell" || result.type === "exec");
  });
  run.status = failed ? "failed" : "succeeded";
  run.finished_at = new Date().toISOString(); await store.save(run);
  console.log(`\n${run.status === "succeeded" ? "✓" : "✗"} completed ${run.id}`); return run;
}

async function executeStep(step: Step, recordId: string, run: RunState, store: RunStore, artifacts: ArtifactMap, root: string, cwd: string): Promise<boolean> {
  if (!shouldRun(step.when, artifacts)) {
    run.steps.push({ id: recordId, type: step.type, status: "skipped", started_at: new Date().toISOString(), finished_at: new Date().toISOString() });
    console.log(`↷ ${recordId} skipped`); await store.save(run); return false;
  }
  const result: StepResult = { id: recordId, type: step.type, status: "running", started_at: new Date().toISOString() };
  run.steps.push(result); await store.save(run); console.log(`→ ${recordId}`);
  try {
    if (step.type === "loop") {
      const fatal = await executeLoop(step, result, recordId, run, store, artifacts, root, cwd);
      if (!fatal && step.stopWhen && shouldRun(step.stopWhen, artifacts)) {
        result.error = step.stopMessage ?? `Stopped by ${step.id}`; result.status = "failed"; result.finished_at = new Date().toISOString(); await store.save(run); return true;
      }
      return fatal;
    }
    if (step.type === "shell" || step.type === "exec") {
      const r = step.type === "shell"
        ? await runShell(render(step.command, artifacts), step.cwd ? resolve(cwd, step.cwd) : cwd, step.timeout, step.shell, step.quiet ?? false)
        : await runExec(render(step.program, artifacts), (step.args ?? []).map((arg) => render(arg, artifacts)), step.cwd ? resolve(cwd, step.cwd) : cwd, step.timeout, step.quiet ?? false);
      result.result = r; artifacts[step.id] = r; artifacts[`${step.id}.output`] = r.output;
      result.status = r.succeeded ? "succeeded" : "failed";
      console.log(r.succeeded ? `✓ ${recordId}` : `✗ ${recordId} (exit ${r.exit_code})`);
      if (step.stopWhen && shouldRun(step.stopWhen, artifacts)) {
        result.error = step.stopMessage ?? `Stopped by ${step.id}`; result.status = "failed";
        result.finished_at = new Date().toISOString(); await store.save(run); console.error(`✗ ${recordId}: ${result.error}`); return true;
      }
      result.finished_at = new Date().toISOString(); await store.save(run);
      return false;
    }
    const agentStep = step as AgentStep;
    const prompt = await makePrompt(agentStep, root, artifacts);
    const before = agentStep.writes ? snapshotWorkspace(cwd) : undefined;
    const r = await runAgent(prompt, cwd, agentStep.model, agentStep.writes ?? false);
    const after = agentStep.writes ? snapshotWorkspace(cwd) : undefined;
    const agentResult = { ...r, ...(before && after ? { changed: workspaceChanged(before, after), changed_files: changedFiles(before, after) } : {}) };
    if (agentStep.outputFormat === "single-line") agentResult.output = normalizeSingleLine(agentResult.output);
    result.result = agentResult; artifacts[agentStep.id] = agentResult;
    if (agentStep.outputFormat === "json") {
      let parsed: any; try { parsed = JSON.parse(agentResult.output.trim()); } catch { throw new Error("Agent produced malformed JSON output"); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Agent JSON output must be an object");
      for (const output of agentStep.outputs ?? []) { if (typeof parsed[output] !== "string") throw new Error(`Agent JSON output is missing string field: ${output}`); artifacts[output] = parsed[output]; }
      if (agentStep.outputs?.includes("commit_message") && !artifacts.commit_message.trim()) throw new Error("Agent produced an empty commit message");
    } else for (const output of agentStep.outputs ?? []) artifacts[output] = agentResult.output;
    result.status = "succeeded"; console.log(`✓ ${recordId}`);
    if (agentStep.stopWhen && shouldRun(agentStep.stopWhen, artifacts)) { result.error = agentStep.stopMessage ?? `Stopped by ${agentStep.id}`; result.status = "failed"; result.finished_at = new Date().toISOString(); await store.save(run); return true; }
    result.finished_at = new Date().toISOString(); await store.save(run); return false;
  } catch (error) {
    result.status = "failed"; result.error = error instanceof Error ? error.message : String(error); result.finished_at = new Date().toISOString(); await store.save(run); console.error(`✗ ${recordId}: ${result.error}`); return true;
  }
}

async function executeLoop(step: LoopStep, result: StepResult, recordId: string, run: RunState, store: RunStore, artifacts: ArtifactMap, root: string, cwd: string): Promise<boolean> {
  const maxIterations = step.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const loopResult: LoopResult = { iterations: [], until: step.until, maxIterations, exhausted: false };
  result.result = loopResult;
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const started = new Date().toISOString();
    for (const child of step.steps) {
      if (await executeStep(child, `${recordId}[${iteration}].${child.id}`, run, store, artifacts, root, cwd)) {
        loopResult.iterations.push({ iteration, started_at: started, finished_at: new Date().toISOString(), status: "failed", until: false });
        result.status = "failed"; result.finished_at = new Date().toISOString(); await store.save(run); return true;
      }
    }
    const until = shouldRun(step.until, artifacts);
    loopResult.iterations.push({ iteration, started_at: started, finished_at: new Date().toISOString(), status: until ? "succeeded" : "failed", until });
    result.status = until ? "succeeded" : "running"; await store.save(run);
    if (until) { result.finished_at = new Date().toISOString(); await store.save(run); console.log(`✓ ${recordId} completed after ${iteration} iteration(s)`); return false; }
  }
  loopResult.exhausted = true; result.status = "failed"; result.error = `${recordId} exhausted its ${maxIterations} iteration limit`; result.finished_at = new Date().toISOString(); await store.save(run); console.error(`✗ ${recordId}: ${result.error}`); return true;
}

function workflowDefaults(inputs: Workflow["inputs"]): ArtifactMap {
  const defaults: ArtifactMap = {};
  for (const [name, definition] of Object.entries(inputs ?? {})) {
    if (typeof definition !== "string" && definition.default !== undefined) defaults[name] = definition.default;
    else if ((typeof definition === "string" ? definition : definition.type) === "boolean") defaults[name] = false;
    else defaults[name] = "";
  }
  return defaults;
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

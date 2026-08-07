import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runExec, runShell } from "./command.js";
import { runAgent } from "./pi-agent.js";
import { RunStore, makeRunId } from "./artifacts.js";
import type { AgentStep, RunState, Step, StepResult, Workflow, WorkflowInput } from "./types.js";

export type ArtifactMap = Record<string, any>;

function lookup(path: string, artifacts: ArtifactMap, task: string): any {
  if (path === "task") return task;
  const parts = path.split("."); let value = artifacts[parts.shift()!];
  for (const part of parts) value = value?.[part];
  return value;
}

function render(value: string, artifacts: ArtifactMap, task: string): string {
  return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, key) => String(lookup(key.trim(), artifacts, task) ?? ""));
}

function shouldRun(expression: string | undefined, artifacts: ArtifactMap): boolean {
  if (!expression) return true;
  return expression.split(/\s*\|\|\s*/).some((alternative) => alternative.replace(/[()]/g, "").split(/\s*&&\s*/).every((part) => {
    const match = part.trim().match(/^([\w.-]+)\s*(==|!=)\s*(.+)$/);
    if (!match) throw new Error(`Unsupported condition: ${expression}`);
    const actual = lookup(match[1], artifacts, "");
    let expected: any = match[3].trim().replace(/^['"]|['"]$/g, "");
    if (expected === "true") expected = true; if (expected === "false") expected = false;
    if (/^-?\d+(\.\d+)?$/.test(expected)) expected = Number(expected);
    return match[2] === "==" ? actual === expected : actual !== expected;
  }));
}

export async function execute(workflow: Workflow, root: string, cwd: string, task: string, initialInputs: ArtifactMap = {}): Promise<RunState> {
  const run: RunState = { id: makeRunId(), workflow: workflow.name, task, cwd, started_at: new Date().toISOString(), status: "running", steps: [] };
  const store = new RunStore(cwd);
  const artifacts: ArtifactMap = { ...workflowDefaults(workflow.inputs), ...initialInputs, task };
  await store.save(run);
  console.log(`\nflow ${workflow.name} · run ${run.id}\n`);
  for (const step of workflow.steps) {
    if (!shouldRun(step.when, artifacts)) { run.steps.push({ id: step.id, type: step.type, status: "skipped", started_at: new Date().toISOString(), finished_at: new Date().toISOString() }); console.log(`↷ ${step.id} skipped`); continue; }
    const started = new Date().toISOString(); const result: StepResult = { id: step.id, type: step.type, status: "running", started_at: started }; run.steps.push(result); await store.save(run);
    console.log(`→ ${step.id}`);
    try {
      if (step.type === "shell") {
        const command = render(step.command, artifacts, task);
        const r = await runShell(command, step.cwd ? resolve(cwd, step.cwd) : cwd, step.timeout, step.shell);
        result.result = r; artifacts[step.id] = r; artifacts[`${step.id}.output`] = r.output;
        result.status = r.succeeded ? "succeeded" : "failed";
        if (!r.succeeded) console.log(`✗ ${step.id} (exit ${r.exit_code})`); else console.log(`✓ ${step.id}`);
        if (step.stopWhen && shouldRun(step.stopWhen, artifacts)) {
          result.error = step.stopMessage ?? `Stopped by ${step.id}`;
          result.status = "failed"; run.status = "failed"; run.finished_at = new Date().toISOString();
          console.error(`✗ ${step.id}: ${result.error}`); result.finished_at = run.finished_at; await store.save(run); return run;
        }
      } else if (step.type === "exec") {
        const program = render(step.program, artifacts, task);
        const args = (step.args ?? []).map((arg) => render(arg, artifacts, task));
        const r = await runExec(program, args, step.cwd ? resolve(cwd, step.cwd) : cwd, step.timeout);
        result.result = r; artifacts[step.id] = r; artifacts[`${step.id}.output`] = r.output;
        result.status = r.succeeded ? "succeeded" : "failed";
        if (!r.succeeded) console.log(`✗ ${step.id} (exit ${r.exit_code})`); else console.log(`✓ ${step.id}`);
        if (step.stopWhen && shouldRun(step.stopWhen, artifacts)) {
          result.error = step.stopMessage ?? `Stopped by ${step.id}`;
          result.status = "failed"; run.status = "failed"; run.finished_at = new Date().toISOString();
          console.error(`✗ ${step.id}: ${result.error}`); result.finished_at = run.finished_at; await store.save(run); return run;
        }
      } else {
        const prompt = await makePrompt(step, root, artifacts, task);
        const r = await runAgent(prompt, cwd, step.model);
        result.result = r; artifacts[step.id] = r;
        if (step.outputFormat === "single-line") r.output = normalizeSingleLine(r.output);
        if (step.outputFormat === "json") {
          let parsed: any;
          try { parsed = JSON.parse(r.output.trim()); } catch { throw new Error("Agent produced malformed JSON output"); }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Agent JSON output must be an object");
          for (const output of step.outputs ?? []) {
            if (typeof parsed[output] !== "string") throw new Error(`Agent JSON output is missing string field: ${output}`);
            artifacts[output] = parsed[output];
          }
          if (step.outputs?.includes("commit_message") && !artifacts.commit_message.trim()) throw new Error("Agent produced an empty commit message");
        } else for (const output of step.outputs ?? []) artifacts[output] = r.output;
        result.status = "succeeded"; console.log(`✓ ${step.id}`);
      }
    } catch (error) { result.status = "failed"; result.error = error instanceof Error ? error.message : String(error); console.error(`✗ ${step.id}: ${result.error}`); run.status = "failed"; result.finished_at = new Date().toISOString(); await store.save(run); return run; }
    result.finished_at = new Date().toISOString();
    // Command failures are artifacts that may intentionally trigger later repair steps.
    // Agent failures stop execution because there is no reliable artifact to continue with.
    if (result.status === "failed" && step.type === "agent") { run.status = "failed"; await store.save(run); return run; }
    await store.save(run);
  }
  const commandResults = run.steps.filter((s) => (s.type === "shell" || s.type === "exec") && !workflow.steps.find((step) => step.id === s.id)?.stopWhen);
  run.status = commandResults.some((step) => step.status === "failed") ? "failed" : "succeeded";
  run.finished_at = new Date().toISOString(); await store.save(run);
  console.log(`\n${run.status === "succeeded" ? "✓" : "✗"} completed ${run.id}`); return run;
}

function workflowDefaults(inputs: Workflow["inputs"]): ArtifactMap {
  const defaults: ArtifactMap = {};
  for (const [name, definition] of Object.entries(inputs ?? {})) {
    if (typeof definition !== "string" && definition.default !== undefined) defaults[name] = definition.default;
    else if (typeof definition === "string" && definition === "boolean") defaults[name] = false;
    else if (typeof definition === "string" && definition === "string") defaults[name] = "";
  }
  return defaults;
}

function normalizeSingleLine(value: string): string {
  let result = value.trim().replace(/^```(?:text|markdown)?\s*|```$/g, "").trim();
  result = result.replace(/^commit message:\s*/i, "").split(/\r?\n/)[0].trim();
  if (!result) throw new Error("Agent produced an empty commit message");
  return result;
}

async function makePrompt(step: AgentStep, root: string, artifacts: ArtifactMap, task: string): Promise<string> {
  const workflowRelative = resolve(root, step.prompt);
  const projectRelative = resolve(process.cwd(), step.prompt);
  const promptPath = existsSync(workflowRelative) ? workflowRelative : projectRelative;
  const prompt = await readFile(promptPath, "utf8");
  const inputs = (step.inputs ?? []).map((key) => `\n--- ${key} ---\n${JSON.stringify(lookup(key, artifacts, task), null, 2)}`).join("\n");
  const suffix = step.outputFormat === "single-line" || step.outputFormat === "json" ? "" : "\n\nOperate in the current repository. Return a concise summary of your work and decisions.";
  return `${render(prompt, artifacts, task)}\n\nTask: ${task}${inputs}${suffix}`;
}

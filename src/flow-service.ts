import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { resolve, relative, join } from "node:path";
import { execute, type ExecuteOptions } from "./executor.js";
import { loadWorkflow } from "./loader.js";
import type { FlowCatalogEntry, RunState, RunSummary, StepResult, Workflow, WorkflowInput } from "./types.js";

export async function loadFlow(reference: string, cwd: string): Promise<Awaited<ReturnType<typeof loadWorkflow>>> {
  const path = resolveFlowPath(reference, cwd);
  if (!existsSync(path)) throw new Error(`Workflow not found: ${reference}`);
  return loadWorkflow(path);
}

export function resolveFlowPath(reference: string, cwd: string): string {
  const direct = resolve(cwd, reference);
  if (existsSync(direct)) return direct;
  const named = resolve(cwd, "flows", reference.endsWith(".flow") ? reference : `${reference}.flow`);
  return named;
}

export async function listFlows(cwd: string): Promise<FlowCatalogEntry[]> {
  const directory = resolve(cwd, "flows");
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const result: FlowCatalogEntry[] = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".flow")).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    try {
      const { workflow } = await loadWorkflow(path);
      result.push({ name: entry.name.slice(0, -5), path, description: workflow.description, inputs: Object.keys(workflow.inputs ?? {}) });
    } catch {
      result.push({ name: entry.name.slice(0, -5), path, inputs: [] });
    }
  }
  return result;
}

export function inputDefinition(definition: string | WorkflowInput): WorkflowInput {
  return typeof definition === "string" ? { type: definition as WorkflowInput["type"] } : definition;
}

export function defaultInputs(workflow: Workflow): Record<string, unknown> {
  return Object.fromEntries(Object.entries(workflow.inputs ?? {}).map(([name, raw]) => {
    const definition = inputDefinition(raw);
    return [name, definition.default ?? (definition.type === "boolean" ? false : "")];
  }));
}

export function resolveInputs(workflow: Workflow, provided: Record<string, unknown>): Record<string, unknown> {
  const inputs = defaultInputs(workflow);
  for (const [name, value] of Object.entries(provided)) {
    const raw = workflow.inputs?.[name];
    if (raw === undefined) throw new Error(`Unknown workflow input: ${name}`);
    const definition = inputDefinition(raw);
    if (typeof value !== definition.type) throw new Error(`Invalid value for input ${name}: expected ${definition.type}`);
    inputs[name] = value;
  }
  return inputs;
}

export interface RunFlowRequest {
  flow: string;
  cwd: string;
  inputs?: Record<string, unknown>;
  output?: ExecuteOptions["output"];
}

export async function runFlow(request: RunFlowRequest): Promise<{ workflow: Workflow; run: RunState; summary: RunSummary }> {
  const path = resolveFlowPath(request.flow, request.cwd);
  if (!existsSync(path)) throw new Error(`Workflow not found: ${request.flow}`);
  const { workflow, root } = await loadWorkflow(path);
  const inputs = resolveInputs(workflow, request.inputs ?? {});
  const run = await execute({ workflow, root, cwd: request.cwd, inputs, output: request.output ?? "normal" });
  return { workflow, run, summary: summarizeRun(run, request.cwd) };
}

export async function inspectRun(cwd: string, runId: string, stepId?: string): Promise<{ run: RunState; steps: StepResult[]; file: string }> {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error("Invalid run ID");
  const file = join(cwd, ".flow", "runs", `${runId}.json`);
  const run = JSON.parse(await readFile(file, "utf8")) as RunState;
  const steps = stepId ? run.steps.filter((step) => step.id === stepId) : run.steps;
  if (stepId && !steps.length) throw new Error(`Step not found: ${stepId}`);
  return { run, steps, file };
}

function excerpt(value: unknown, limit = 2000): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;
}

export function summarizeRun(run: RunState, cwd: string): RunSummary {
  const changedFiles = new Set<string>();
  const importantOutputs: Record<string, string> = {};
  const steps = run.steps.map((step) => {
    const result = step.result as any;
    for (const file of result?.changed_files ?? []) changedFiles.add(file);
    const output = excerpt(result?.output);
    if (output) importantOutputs[step.id] = output;
    return { id: step.id, type: step.type, status: step.status, exit_code: result?.exit_code, process_succeeded: result?.succeeded, changed: result?.changed, message: step.message, error: step.error };
  });
  return { run_id: run.id, flow: run.workflow, status: run.status, steps, changed_files: [...changedFiles].sort(), important_outputs: importantOutputs, run_file: relative(cwd, join(cwd, ".flow", "runs", `${run.id}.json`)) };
}

export function summarizeStep(step: StepResult, outputLimit = 8000): unknown {
  const result = step.result as any;
  return { ...step, result: result ? { ...result, output: excerpt(result.output, outputLimit), stdout: excerpt(result.stdout, outputLimit), stderr: excerpt(result.stderr, outputLimit) } : undefined };
}

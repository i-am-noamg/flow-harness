import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { resolve, relative, join } from "node:path";
import { execute, type ExecuteOptions } from "./executor.js";
import { loadWorkflow } from "./loader.js";
import type { FlowCatalogEntry, FlowProgressCallback, RunState, RunSummary, StepResult, Workflow, WorkflowInput } from "./types.js";

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
  const result: FlowCatalogEntry[] = [];
  const directories = [
    { path: resolve(cwd, "flows"), temporary: false },
    { path: resolve(cwd, ".flow", "tmp"), temporary: true },
  ];
  for (const directory of directories) {
    if (!existsSync(directory.path)) continue;
    const entries = await readdir(directory.path, { withFileTypes: true });
    for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".flow")).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory.path, entry.name);
      const base = { name: entry.name.slice(0, -5), path, ...(directory.temporary ? { temporary: true } : {}) };
      try {
        const { workflow } = await loadWorkflow(path);
        result.push({
          ...base,
          description: workflow.description,
          inputs: Object.entries(workflow.inputs ?? {}).map(([name, raw]) => {
            const definition = inputDefinition(raw);
            return { name, type: definition.type, ...(definition.default !== undefined ? { default: definition.default } : {}), ...(definition.description ? { description: definition.description } : {}) };
          }),
          outputs: Object.keys(workflow.outputs ?? {}),
        });
      } catch {
        result.push({ ...base, inputs: [], outputs: [] });
      }
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
  onProgress?: FlowProgressCallback;
}

export async function runFlow(request: RunFlowRequest): Promise<{ workflow: Workflow; run: RunState; summary: RunSummary }> {
  const path = resolveFlowPath(request.flow, request.cwd);
  if (!existsSync(path)) throw new Error(`Workflow not found: ${request.flow}`);
  const { workflow, root, workflowSource } = await loadWorkflow(path);
  const inputs = resolveInputs(workflow, request.inputs ?? {});
  const run = await execute({ workflow, root, cwd: request.cwd, inputs, output: request.output ?? "normal", onProgress: request.onProgress, workflowSource });
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

const SUMMARY_STEP_LIMIT = 20;
const SUMMARY_OUTPUT_LIMIT = 20;
const SUMMARY_CHANGED_FILE_LIMIT = 50;

function boundedValue(value: unknown): unknown {
  if (typeof value === "string") return excerpt(value, 1000) ?? "";
  if (Array.isArray(value)) return value.slice(0, SUMMARY_OUTPUT_LIMIT).map(boundedValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, SUMMARY_OUTPUT_LIMIT).map(([key, item]) => [key, boundedValue(item)]));
  return value;
}

export function summarizeRun(run: RunState, cwd: string): RunSummary {
  const changedFiles = new Set<string>();
  const failures: RunSummary["failures"] = [];
  const allSteps = run.steps.map((step) => {
    const result = step.result as any;
    for (const file of result?.changed_files ?? []) changedFiles.add(file);
    if (step.status === "failed") failures.push({ id: step.id, error: excerpt(step.error, 1000), exit_code: result?.exit_code, signal: result?.signal, timed_out: result?.timed_out });
    return { id: step.id, type: step.type, status: step.status, control: step.control, exit_code: result?.exit_code, signal: result?.signal, timed_out: result?.timed_out, changed: result?.changed, message: excerpt(step.message, 1000), error: excerpt(step.error, 1000) };
  });
  const outputEntries = Object.entries(run.outputs ?? {});
  const files = [...changedFiles].sort();
  const omitted = {
    ...(allSteps.length > SUMMARY_STEP_LIMIT ? { steps: allSteps.length - SUMMARY_STEP_LIMIT } : {}),
    ...(outputEntries.length > SUMMARY_OUTPUT_LIMIT ? { outputs: outputEntries.length - SUMMARY_OUTPUT_LIMIT } : {}),
    ...(files.length > SUMMARY_CHANGED_FILE_LIMIT ? { changed_files: files.length - SUMMARY_CHANGED_FILE_LIMIT } : {}),
  };
  return { run_id: run.id, flow: run.workflow, status: run.status, steps: allSteps.slice(0, SUMMARY_STEP_LIMIT), outputs: Object.fromEntries(outputEntries.slice(0, SUMMARY_OUTPUT_LIMIT).map(([key, value]) => [key, boundedValue(value)])), failures: failures.slice(0, SUMMARY_STEP_LIMIT), changed_files: files.slice(0, SUMMARY_CHANGED_FILE_LIMIT), ...(Object.keys(omitted).length ? { omitted } : {}), run_file: relative(cwd, join(cwd, ".flow", "runs", `${run.id}.json`)) };
}

function summarizeToolEvidence(evidence: any): unknown {
  if (!evidence || typeof evidence !== "object") return evidence;
  if (evidence.availability === "available" && Array.isArray(evidence.events)) return { availability: "available", event_count: evidence.events.length };
  if (evidence.availability === "unavailable") return { availability: "unavailable" };
  return undefined;
}

export function summarizeStep(step: StepResult, outputLimit = 8000): unknown {
  const result = step.result as any;
  if (!result) return { ...step, result: undefined };
  const { tool_evidence, ...summary } = result;
  return {
    ...step,
    result: {
      ...summary,
      output: excerpt(result.output, outputLimit),
      stdout: excerpt(result.stdout, outputLimit),
      stderr: excerpt(result.stderr, outputLimit),
      ...(tool_evidence !== undefined ? { tool_evidence: summarizeToolEvidence(tool_evidence) } : {}),
    },
  };
}

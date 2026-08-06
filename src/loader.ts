import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import YAML from "yaml";
import type { Workflow, WorkflowInput } from "./types.js";

export async function loadWorkflow(file: string): Promise<{ workflow: Workflow; root: string }> {
  const path = resolve(file);
  const workflow = YAML.parse(await readFile(path, "utf8")) as Workflow;
  validateWorkflow(workflow);
  return { workflow, root: dirname(path) };
}

export function validateWorkflow(w: Workflow): void {
  if (!w || typeof w.name !== "string") throw new Error("Workflow requires a name");
  if (!Array.isArray(w.steps) || w.steps.length === 0) throw new Error("Workflow requires at least one step");
  if (w.inputs !== undefined) {
    if (!w.inputs || typeof w.inputs !== "object" || Array.isArray(w.inputs)) throw new Error("Workflow inputs must be an object");
    for (const [name, definition] of Object.entries(w.inputs)) {
      const input = typeof definition === "string" ? { type: definition } as WorkflowInput : definition as WorkflowInput;
      if (input.type !== "string" && input.type !== "boolean") throw new Error(`Invalid input type for ${name}`);
      if (input.default !== undefined && typeof input.default !== input.type) throw new Error(`Invalid default for input ${name}`);
    }
  }
  const ids = new Set<string>();
  for (const step of w.steps) {
    if (!step.id || ids.has(step.id)) throw new Error(`Invalid or duplicate step id: ${step.id}`);
    ids.add(step.id);
    const stepId = step.id;
    if (step.type !== "agent" && step.type !== "command") throw new Error(`${stepId}: unsupported type`);
    if (step.type === "agent" && !step.prompt) throw new Error(`${step.id}: agent requires prompt`);
    if (step.type === "agent" && step.outputFormat !== undefined && step.outputFormat !== "text" && step.outputFormat !== "single-line" && step.outputFormat !== "json") throw new Error(`${step.id}: unsupported output format`);
    if (step.type === "command" && !step.command) throw new Error(`${step.id}: command requires command`);
    if (step.type === "command" && step.args !== undefined && (!Array.isArray(step.args) || step.args.some((arg) => typeof arg !== "string"))) throw new Error(`${step.id}: command args must be strings`);
    if (step.stopWhen !== undefined && typeof step.stopWhen !== "string") throw new Error(`${step.id}: stopWhen must be a string`);
    if (step.stopMessage !== undefined && typeof step.stopMessage !== "string") throw new Error(`${step.id}: stopMessage must be a string`);
  }
}

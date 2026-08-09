import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import YAML from "yaml";
import type { Workflow, WorkflowInput, Step } from "./types.js";

export async function loadWorkflow(file: string): Promise<{ workflow: Workflow; root: string }> {
  const path = resolve(file);
  const workflow = YAML.parse(await readFile(path, "utf8")) as Workflow;
  validateWorkflow(workflow);
  return { workflow, root: dirname(path) };
}

export function validateWorkflow(w: Workflow): void {
  if (!w || typeof w.name !== "string") throw new Error("Workflow requires a name");
  if (w.description !== undefined && typeof w.description !== "string") throw new Error("Workflow description must be a string");
  if (!Array.isArray(w.steps) || w.steps.length === 0) throw new Error("Workflow requires at least one step");
  if (w.outputs !== undefined) {
    if (!w.outputs || typeof w.outputs !== "object" || Array.isArray(w.outputs)) throw new Error("Workflow outputs must be an object");
    for (const [name, expression] of Object.entries(w.outputs)) if (typeof expression !== "string" || !expression.trim()) throw new Error(`Invalid output expression for ${name}`);
  }
  if (w.inputs !== undefined) {
    if (!w.inputs || typeof w.inputs !== "object" || Array.isArray(w.inputs)) throw new Error("Workflow inputs must be an object");
    for (const [name, definition] of Object.entries(w.inputs)) {
      const input = typeof definition === "string" ? { type: definition } as WorkflowInput : definition as WorkflowInput;
      if (input.type !== "string" && input.type !== "boolean") throw new Error(`Invalid input type for ${name}`);
      if (input.description !== undefined && typeof input.description !== "string") throw new Error(`Invalid description for input ${name}`);
      if (input.default !== undefined && typeof input.default !== input.type) throw new Error(`Invalid default for ${name}`);
    }
  }
  const ids = new Set<string>();
  validateSteps(w.steps, ids, "steps");
}

function validateCondition(expression: string, id: string, field: string): void {
  for (const alternative of expression.split(/\s*\|\|\s*/)) {
    for (const part of alternative.replace(/[()]/g, "").split(/\s*&&\s*/)) {
      if (!/^[\w.-]+\s*(==|!=)\s*(?:.+)$/.test(part.trim())) throw new Error(`${id}: invalid ${field} condition`);
    }
  }
}

function validateSteps(steps: unknown, ids: Set<string>, path: string): asserts steps is Step[] {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error(`${path} must contain at least one step`);
  for (const [index, raw] of steps.entries()) {
    const step = raw as Partial<Step>;
    const stepPath = `${path}[${index}]`;
    if (!step || typeof step.id !== "string" || !step.id) throw new Error(`${stepPath}: invalid step id`);
    if (ids.has(step.id)) throw new Error(`${stepPath}: duplicate step id: ${step.id}`);
    ids.add(step.id);
    if (step.type !== "agent" && step.type !== "shell" && step.type !== "exec" && step.type !== "loop") throw new Error(`${step.id}: unsupported type`);
    if (step.when !== undefined && typeof step.when !== "string") throw new Error(`${step.id}: when must be a string`);
    if (step.stopWhen !== undefined && typeof step.stopWhen !== "string") throw new Error(`${step.id}: stopWhen must be a string`);
    if (step.stopMessage !== undefined && typeof step.stopMessage !== "string") throw new Error(`${step.id}: stopMessage must be a string`);
    if (step.type === "agent" && typeof step.prompt !== "string" || step.type === "agent" && !step.prompt) throw new Error(`${step.id}: agent requires prompt`);
    if (step.type === "agent" && step.outputFormat !== undefined && !["text", "single-line", "json"].includes(step.outputFormat)) throw new Error(`${step.id}: unsupported agent output format`);
    if ((step.type === "shell" || step.type === "exec") && step.outputFormat !== undefined && !["text", "single-line", "lines"].includes(step.outputFormat)) throw new Error(`${step.id}: unsupported process output format`);
    if (step.type === "shell" && typeof step.command !== "string" || step.type === "shell" && !step.command) throw new Error(`${step.id}: shell requires command`);
    if (step.type === "shell" && step.shell !== undefined && typeof step.shell !== "string") throw new Error(`${step.id}: shell must be a string`);
    if ((step.type === "shell" || step.type === "exec") && step.output !== undefined && step.output !== "always" && step.output !== "failure" && step.output !== "never") throw new Error(`${step.id}: output must be always, failure, or never`);
    if (step.type === "exec" && typeof step.program !== "string" || step.type === "exec" && !step.program) throw new Error(`${step.id}: exec requires program`);
    if (step.type === "exec" && step.args !== undefined && (!Array.isArray(step.args) || step.args.some((arg) => typeof arg !== "string"))) throw new Error(`${step.id}: exec args must be strings`);
    if (step.type === "loop") {
      const allowed = new Set(["id", "type", "when", "inputs", "outputs", "stopWhen", "stopMessage", "steps", "until", "maxIterations"]);
      const unsupported = Object.keys(raw as object).find((key) => !allowed.has(key));
      if (unsupported) throw new Error(`${step.id}: unsupported loop property: ${unsupported}`);
      if (typeof step.until !== "string" || !step.until.trim()) throw new Error(`${step.id}: loop requires until`);
      validateCondition(step.until, step.id, "until");
      if (step.maxIterations !== undefined && (!Number.isInteger(step.maxIterations) || step.maxIterations <= 0)) throw new Error(`${step.id}: maxIterations must be a positive integer`);
      validateSteps(step.steps, ids, `${step.id}.steps`);
    }
  }
}

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import YAML from "yaml";
import { validateCondition as validateConditionSyntax } from "./conditions.js";
import { parseOutputExpression } from "./outputs.js";
import type { Workflow, WorkflowInput, Step } from "./types.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const PI_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

function validateTools(value: unknown, path: string): void {
  if (!Array.isArray(value)) throw new Error(`${path}: tools must be an array`);
  const names = new Set<string>();
  for (const tool of value) {
    if (typeof tool !== "string") throw new Error(`${path}: tools must contain strings`);
    if (!PI_TOOLS.includes(tool as typeof PI_TOOLS[number])) throw new Error(`${path}: unsupported tool: ${tool}`);
    if (names.has(tool)) throw new Error(`${path}: duplicate tool: ${tool}`);
    names.add(tool);
  }
}

function validateSkills(value: unknown, path: string): void {
  if (!Array.isArray(value)) throw new Error(`${path}: skills must be an array`);
  const names = new Set<string>();
  for (const name of value) {
    if (typeof name !== "string" || !name.trim()) throw new Error(`${path}: skills must contain non-empty strings`);
    if (names.has(name)) throw new Error(`${path}: duplicate skill: ${name}`);
    names.add(name);
  }
}

function validateModel(value: unknown, path: string): void {
  if (value === undefined || (typeof value === "string" && !value.trim())) throw new Error(`${path}: model is required`);
  if (typeof value !== "string") throw new Error(`${path}: model must be a string`);
}

function validateThinkingLevel(value: unknown, path: string): void {
  if (value === undefined) throw new Error(`${path}: thinkingLevel is required`);
  if (typeof value !== "string" || !THINKING_LEVELS.includes(value as typeof THINKING_LEVELS[number])) {
    throw new Error(`${path}: thinkingLevel must be one of ${THINKING_LEVELS.join(", ")}`);
  }
}

export async function loadWorkflow(file: string): Promise<{ workflow: Workflow; root: string; workflowSource: string }> {
  const path = resolve(file);
  const workflowSource = await readFile(path, "utf8");
  const workflow = YAML.parse(workflowSource) as Workflow;
  validateWorkflow(workflow);
  return { workflow, root: dirname(path), workflowSource };
}

export function validateWorkflow(w: Workflow): void {
  if (!w || typeof w.name !== "string") throw new Error("Workflow requires a name");
  if (w.description !== undefined && typeof w.description !== "string") throw new Error("Workflow description must be a string");
  if (!Array.isArray(w.steps) || w.steps.length === 0) throw new Error("Workflow requires at least one step");
  if (w.outputs !== undefined) {
    if (!w.outputs || typeof w.outputs !== "object" || Array.isArray(w.outputs)) throw new Error("Workflow outputs must be an object");
    for (const [name, expression] of Object.entries(w.outputs)) {
      if (typeof expression !== "string" || !expression.trim()) throw new Error(`Invalid output expression for ${name}`);
      try { parseOutputExpression(expression); } catch (error) { throw new Error(`Invalid output expression for ${name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
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
  validateSteps(w.steps, ids, "steps", false);
  validateAgentContexts(w.steps);
}

function validateParallelBatches(steps: unknown[], path: string): void {
  const groups = new Set<string>();
  for (let index = 0; index < steps.length;) {
    const parallel = (steps[index] as Partial<Step>)?.parallel;
    if (typeof parallel !== "string" || !parallel.trim()) { index++; continue; }
    if (groups.has(parallel)) throw new Error(`${path}: parallel group name must be unique: ${parallel}`);
    groups.add(parallel);
    const batch: Partial<Step>[] = [];
    while (index < steps.length && (steps[index] as Partial<Step>)?.parallel === parallel) batch.push(steps[index] as Partial<Step>), index++;
    const ids = new Set(batch.map((step) => step.id));
    const outputs = new Set<string>();
    const contexts = new Set<string>();
    for (const step of batch) {
      for (const output of step.outputs ?? []) {
        if (outputs.has(output)) throw new Error(`${path}: parallel steps cannot share output name: ${output}`);
        outputs.add(output);
      }
      if (step.type === "agent" && step.context) {
        if (contexts.has(step.context)) throw new Error(`${path}: parallel agents cannot share context: ${step.context}`);
        contexts.add(step.context);
      }
      const text = JSON.stringify({ when: step.when, inputs: step.inputs, command: (step as any).command, program: (step as any).program, args: (step as any).args, prompt: (step as any).prompt, skills: (step as any).skills, variants: (step as any).variants });
      for (const input of step.inputs ?? []) {
        const root = input.split(".")[0];
        if (ids.has(root)) throw new Error(`${step.id}: parallel step cannot depend on sibling artifact: ${root}`);
      }
      for (const match of text.matchAll(/(?:\{\{\s*)?([A-Za-z_][\w-]*)(?:\.|\s*\}\})/g)) {
        if (ids.has(match[1])) throw new Error(`${step.id}: parallel step cannot depend on sibling artifact: ${match[1]}`);
      }
    }
  }
}

type AgentContextConfig = { id: string; context?: string; forkContext?: string; model: string; writes: boolean; thinkingLevel: string; tools: string[]; parallelBatch?: number };

function effectiveTools(tools: string[] | undefined, writes: boolean): string[] {
  return tools ?? (writes ? [...PI_TOOLS] : ["read", "grep", "find", "ls"]);
}

function sameAgentContextConfig(left: AgentContextConfig, right: AgentContextConfig): boolean {
  return left.model === right.model && left.writes === right.writes && left.thinkingLevel === right.thinkingLevel && left.tools.length === right.tools.length && left.tools.every((tool, index) => tool === right.tools[index]);
}

function validateAgentContexts(steps: Step[]): void {
  const contexts = new Map<string, AgentContextConfig>();
  let nextParallelBatch = 0;
  const visit = (items: Step[]): void => {
    let previousGroup: string | undefined;
    let parallelBatch: number | undefined;
    for (const step of items) {
      const group = typeof step.parallel === "string" && step.parallel.trim() ? step.parallel : undefined;
      if (group !== previousGroup) parallelBatch = group ? ++nextParallelBatch : undefined;
      previousGroup = group;
      if (step.type === "loop") { visit(step.steps); continue; }
      if (step.type !== "agent") continue;
      const candidates = step.variants?.length ? step.variants.map((variant) => ({ ...step, ...variant })) : [step];
      for (const candidate of candidates) {
        const config: AgentContextConfig = { id: step.id, context: candidate.context, forkContext: candidate.forkContext, model: candidate.model, writes: candidate.writes ?? false, thinkingLevel: candidate.thinkingLevel, tools: effectiveTools(candidate.tools, candidate.writes ?? false), parallelBatch };
        if (config.context && config.forkContext) throw new Error(`${step.id}: context and forkContext cannot both be set`);
        if (config.forkContext) {
          const source = contexts.get(config.forkContext);
          if (!source) throw new Error(`${step.id}: forkContext must reference an earlier context: ${config.forkContext}`);
          if (source.parallelBatch !== undefined && source.parallelBatch === config.parallelBatch) throw new Error(`${step.id}: forkContext cannot reference a context in the same parallel batch: ${config.forkContext}`);
          if (!sameAgentContextConfig(source, config)) throw new Error(`${step.id}: forkContext ${config.forkContext} must use the same model, writes setting, thinking level, and tools allowlist`);
        }
        if (config.context) {
          const source = contexts.get(config.context);
          if (source && !sameAgentContextConfig(source, config)) throw new Error(`${step.id}: shared agent context ${config.context} must use the same model, writes setting, thinking level, and tools allowlist`);
          contexts.set(config.context, config);
        }
      }
    }
  };
  visit(steps);
}

function validateConditionField(expression: string, id: string, field: string): void {
  try {
    validateConditionSyntax(expression);
  } catch {
    throw new Error(`${id}: invalid ${field} condition`);
  }
}

function validateAgentVariants(step: Partial<Step>): void {
  const variants = (step as any).variants as unknown;
  if (!Array.isArray(variants) || variants.length === 0) throw new Error(`${step.id}: variants must be a non-empty array`);
  const ids = new Set<string>();
  for (const [index, raw] of variants.entries()) {
    const variant = raw as Record<string, unknown>;
    const id = typeof variant.id === "string" ? variant.id : `${step.id}.variants[${index}]`;
    if (typeof variant.id !== "string" || !variant.id) throw new Error(`${id}: invalid variant id`);
    if (ids.has(variant.id)) throw new Error(`${step.id}: duplicate variant id: ${variant.id}`);
    ids.add(variant.id);
    if (typeof variant.when !== "string" || !variant.when.trim()) throw new Error(`${step.id}.${variant.id}: variant requires when`);
    validateConditionField(variant.when, `${step.id}.${variant.id}`, "when");
    if (typeof variant.prompt !== "string" || !variant.prompt) throw new Error(`${step.id}.${variant.id}: variant requires prompt`);
    validateModel(variant.model, `${step.id}.${variant.id}`);
    validateThinkingLevel(variant.thinkingLevel, `${step.id}.${variant.id}`);
    if (variant.writes !== undefined && typeof variant.writes !== "boolean") throw new Error(`${step.id}.${variant.id}: writes must be a boolean`);
    if (variant.tools !== undefined) validateTools(variant.tools, `${step.id}.${variant.id}`);
    if (variant.skills !== undefined) validateSkills(variant.skills, `${step.id}.${variant.id}`);
    if (variant.context !== undefined && (typeof variant.context !== "string" || !variant.context.trim())) throw new Error(`${step.id}.${variant.id}: context must be a non-empty string`);
    if (variant.forkContext !== undefined && (typeof variant.forkContext !== "string" || !variant.forkContext.trim())) throw new Error(`${step.id}.${variant.id}: forkContext must be a non-empty string`);
    if (variant.outputFormat !== undefined && !["text", "single-line", "json"].includes(variant.outputFormat as string)) throw new Error(`${step.id}.${variant.id}: unsupported output format`);
    if (variant.inputs !== undefined && (!Array.isArray(variant.inputs) || variant.inputs.some((input) => typeof input !== "string"))) throw new Error(`${step.id}.${variant.id}: inputs must be strings`);
    if (variant.outputs !== undefined && (!Array.isArray(variant.outputs) || variant.outputs.some((output) => typeof output !== "string"))) throw new Error(`${step.id}.${variant.id}: outputs must be strings`);
  }
}

function validateSteps(steps: unknown, ids: Set<string>, path: string, allowHistory: boolean): asserts steps is Step[] {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error(`${path} must contain at least one step`);
  validateParallelBatches(steps, path);
  for (const [index, raw] of steps.entries()) {
    const step = raw as Partial<Step>;
    const stepPath = `${path}[${index}]`;
    if (!step || typeof step.id !== "string" || !step.id) throw new Error(`${stepPath}: invalid step id`);
    if (ids.has(step.id)) throw new Error(`${stepPath}: duplicate step id: ${step.id}`);
    ids.add(step.id);
    if (step.type !== "agent" && step.type !== "shell" && step.type !== "exec" && step.type !== "loop") throw new Error(`${step.id}: unsupported type`);
    if (step.when !== undefined && typeof step.when !== "string") throw new Error(`${step.id}: when must be a string`);
    if (step.when !== undefined) validateConditionField(step.when, step.id, "when");
    if (step.type === "agent" && step.context !== undefined && (typeof step.context !== "string" || !step.context.trim())) throw new Error(`${step.id}: context must be a non-empty string`);
    if (step.type === "agent" && step.forkContext !== undefined && (typeof step.forkContext !== "string" || !step.forkContext.trim())) throw new Error(`${step.id}: forkContext must be a non-empty string`);
    if (step.type === "agent") {
      validateModel(step.model, step.id);
      validateThinkingLevel(step.thinkingLevel, step.id);
      if (step.tools !== undefined) validateTools(step.tools, step.id);
      if (step.skills !== undefined) validateSkills(step.skills, step.id);
    }
    if (step.type === "agent" && step.variants !== undefined) validateAgentVariants(step);
    if (step.stopWhen !== undefined && typeof step.stopWhen !== "string") throw new Error(`${step.id}: stopWhen must be a string`);
    if (step.stopWhen !== undefined) validateConditionField(step.stopWhen, step.id, "stopWhen");
    if (step.stopMessage !== undefined && typeof step.stopMessage !== "string") throw new Error(`${step.id}: stopMessage must be a string`);
    if (step.parallel !== undefined && (typeof step.parallel !== "string" || !step.parallel.trim())) throw new Error(`${step.id}: parallel must be a non-empty string`);
    if (step.history !== undefined && typeof step.history !== "boolean") throw new Error(`${step.id}: history must be a boolean`);
    if (step.history && !allowHistory) throw new Error(`${step.id}: history belongs on loop-body steps, not top-level steps`);
    if (step.type === "loop" && step.history) throw new Error(`${step.id}: history belongs on loop-body steps, not loops`);
    if (step.parallel && step.type === "loop") throw new Error(`${step.id}: loops cannot run in parallel`);
    if (step.parallel && step.type === "shell") throw new Error(`${step.id}: shell steps cannot run in parallel`);
    if (step.parallel && step.type === "agent" && step.writes) throw new Error(`${step.id}: writing agents cannot run in parallel`);
    if (step.parallel && step.stopWhen) throw new Error(`${step.id}: stopWhen steps cannot run in parallel`);
    if (step.type === "agent" && step.variants === undefined && (typeof step.prompt !== "string" || !step.prompt)) throw new Error(`${step.id}: agent requires prompt or variants`);
    if (step.type === "agent" && step.variants !== undefined && step.prompt !== undefined && (typeof step.prompt !== "string" || !step.prompt)) throw new Error(`${step.id}: agent prompt must be a non-empty string`);
    if (step.type === "agent" && step.outputFormat !== undefined && !["text", "single-line", "json"].includes(step.outputFormat)) throw new Error(`${step.id}: unsupported agent output format`);
    if ((step.type === "shell" || step.type === "exec") && step.outputFormat !== undefined && !["text", "single-line", "lines"].includes(step.outputFormat)) throw new Error(`${step.id}: unsupported process output format`);
    if (step.type === "shell" && typeof step.command !== "string" || step.type === "shell" && !step.command) throw new Error(`${step.id}: shell requires command`);
    if (step.type === "shell" && step.shell !== undefined && typeof step.shell !== "string") throw new Error(`${step.id}: shell must be a string`);
    if ((step.type === "shell" || step.type === "exec") && Object.prototype.hasOwnProperty.call(raw, "output")) throw new Error(`${step.id}: use console instead of output for process logging`);
    if ((step.type === "shell" || step.type === "exec") && step.console !== undefined && step.console !== "always" && step.console !== "on-failure" && step.console !== "never") throw new Error(`${step.id}: console must be always, on-failure, or never`);
    if (step.type === "exec" && typeof step.program !== "string" || step.type === "exec" && !step.program) throw new Error(`${step.id}: exec requires program`);
    if (step.type === "exec" && step.args !== undefined && (!Array.isArray(step.args) || step.args.some((arg) => typeof arg !== "string"))) throw new Error(`${step.id}: exec args must be strings`);
    if (step.type === "loop") {
      const allowed = new Set(["id", "type", "when", "inputs", "outputs", "stopWhen", "stopMessage", "parallel", "history", "steps", "until", "maxIterations"]);
      const unsupported = Object.keys(raw as object).find((key) => !allowed.has(key));
      if (unsupported) throw new Error(`${step.id}: unsupported loop property: ${unsupported}`);
      if (typeof step.until !== "string" || !step.until.trim()) throw new Error(`${step.id}: loop requires until`);
      validateConditionField(step.until, step.id, "until");
      if (step.maxIterations !== undefined && (!Number.isInteger(step.maxIterations) || step.maxIterations <= 0)) throw new Error(`${step.id}: maxIterations must be a positive integer`);
      validateSteps(step.steps, ids, `${step.id}.steps`, true);
    }
  }
}

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadWorkflow } from "./loader.js";
import { execute } from "./executor.js";
import type { Workflow, WorkflowInput } from "./types.js";

function help(): void {
  console.log(`flow - declarative agent workflows

Usage:
  flow [options]                         Run the default workflow
  flow run [workflow.flow] [options]     Run a workflow
  flow validate <workflow.flow>         Validate a workflow
  flow help <workflow.flow|name>        Show workflow description and inputs

Workflow options:
  -q, --quiet                 Suppress step output (show statuses only)
  --<input> <value>           Set a workflow-defined input

Environment:
  FLOW_WORKFLOW   Default workflow path (default: flows/code-change.flow)
  FLOW_MODEL_CHEAP / CAPABLE / STRONGEST  Model as provider/id
`);
}

function workflowPath(value: string): string {
  if (existsSync(resolve(value))) return value;
  const namedPath = resolve("flows", value.endsWith(".flow") ? value : `${value}.flow`);
  if (existsSync(namedPath)) return namedPath;
  return value;
}

function inputDefinition(definition: string | WorkflowInput): WorkflowInput {
  return typeof definition === "string" ? { type: definition as WorkflowInput["type"] } : definition;
}

function printWorkflowHelp(workflow: Workflow, file: string): void {
  console.log(`${workflow.name}${workflow.description ? ` — ${workflow.description}` : ""}`);
  console.log(`\nUsage:\n  flow run ${file} [options]\n`);
  const inputs = Object.entries(workflow.inputs ?? {});
  if (!inputs.length) return;
  console.log("Inputs:");
  for (const [name, rawDefinition] of inputs) {
    const definition = inputDefinition(rawDefinition);
    const flag = definition.type === "boolean" ? `--${name}` : `--${name} <value>`;
    const defaultValue = definition.default !== undefined ? ` (default: ${String(definition.default)})` : "";
    console.log(`  ${flag}${defaultValue}${definition.description ? `\n      ${definition.description}` : ""}`);
  }
}

function defaultInputs(workflow: Workflow): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [name, definition] of Object.entries(workflow.inputs ?? {})) {
    if (typeof definition !== "string" && definition.default !== undefined) result[name] = definition.default;
    else result[name] = (typeof definition === "string" ? definition : definition.type) === "boolean" ? false : "";
  }
  return result;
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const quiet = rawArgs.some((arg) => arg === "-q" || arg === "--quiet");
  const args = rawArgs.filter((arg) => arg !== "-q" && arg !== "--quiet");
  if (args[0] === "--help" || args[0] === "-h") return help();
  if (args[0] === "help") {
    if (!args[1]) throw new Error("A workflow name or path is required");
    const file = workflowPath(args[1]);
    const { workflow } = await loadWorkflow(file);
    printWorkflowHelp(workflow, args[1]);
    return;
  }
  if (args[0] === "validate") { if (!args[1]) throw new Error("A workflow path is required"); const { workflow } = await loadWorkflow(args[1]); console.log(`valid: ${workflow.name}`); return; }

  let workflowFile = process.env.FLOW_WORKFLOW ?? "flows/code-change.flow";
  let optionArgs: string[];
  if (args[0] === "run") {
    const workflowArg = args[1];
    if (workflowArg && !workflowArg.startsWith("--")) {
      workflowFile = workflowArg;
      optionArgs = args.slice(2);
    } else optionArgs = args.slice(1);
  } else optionArgs = args;
  workflowFile = workflowPath(workflowFile);
  if (!existsSync(resolve(workflowFile))) throw new Error(`Workflow not found: ${workflowFile}`);
  const { workflow, root } = await loadWorkflow(workflowFile);
  const inputs = defaultInputs(workflow);
  const definitions = workflow.inputs ?? {};
  for (let i = 0; i < optionArgs.length; i++) {
    const option = optionArgs[i];
    if (!option.startsWith("--")) throw new Error(`Unexpected argument: ${option}`);
    const inputName = option.slice(2).replace(/-/g, "_");
    const definition = definitions[inputName];
    if (definition === undefined) throw new Error(`Unknown flag: ${option}`);
    const type = typeof definition === "string" ? definition : definition.type;
    if (type === "boolean") inputs[inputName] = true;
    else {
      if (!optionArgs[i + 1] || optionArgs[i + 1].startsWith("--")) throw new Error(`${option} requires a value`);
      inputs[inputName] = optionArgs[++i];
    }
  }
  const run = await execute(workflow, root, process.cwd(), inputs, quiet);
  process.exitCode = run.status === "succeeded" ? 0 : 1;
}

main().catch((error) => { console.error(`flow: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });

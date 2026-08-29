import { existsSync } from "node:fs";
import { defaultInputs, inputDefinition, inspectRun, listFlows, loadFlow, resolveFlowPath, resolveInputs, runFlow, summarizeStep } from "./flow-service.js";
import { formatFlowCatalog } from "./flow-catalog.js";
import type { Workflow, WorkflowInput } from "./types.js";

function help(): void {
  console.log(`flow - declarative agent workflows

Usage:
  flow [options]                         Run the workflow configured by FLOW_WORKFLOW
  flow run [workflow.flow] [options]     Run a workflow
  flow validate <workflow.flow>          Validate a workflow
  flow list                              List available workflows
  flow inspect <run-id> [--step <id>]    Inspect a saved run (<timestamp>--<normalized-workflow-name>)
  flow help <workflow.flow|name>         Show workflow description and inputs

Workflow options:
  -q, --quiet                 Suppress step output
  --<input> <value>           Set a string workflow input
  --<input>                   Set a boolean workflow input

Environment:
  FLOW_WORKFLOW   Default workflow path when no workflow is specified
  FLOW_MODEL_CHEAP / CAPABLE / STRONGEST  Model as provider/id
`);
}

function printWorkflowHelp(workflow: Workflow, file: string): void {
  console.log(`${workflow.name}${workflow.description ? ` — ${workflow.description}` : ""}`);
  console.log(`\nUsage:\n  flow run ${file} [options]\n`);
  const inputs = Object.entries(workflow.inputs ?? {});
  if (!inputs.length) return;
  console.log("Inputs:");
  for (const [name, raw] of inputs) {
    const definition = inputDefinition(raw as string | WorkflowInput);
    const flag = definition.type === "boolean" ? `--${name}` : `--${name} <value>`;
    const defaultValue = definition.default !== undefined ? ` (default: ${String(definition.default)})` : "";
    console.log(`  ${flag}${defaultValue}${definition.description ? `\n      ${definition.description}` : ""}`);
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const quiet = rawArgs.some((arg) => arg === "-q" || arg === "--quiet");
  const args = rawArgs.filter((arg) => arg !== "-q" && arg !== "--quiet");
  if (args[0] === "--help" || args[0] === "-h") return help();

  const cwd = process.cwd();
  if (args[0] === "help") {
    if (!args[1]) throw new Error("A workflow name or path is required");
    const { workflow } = await loadFlow(args[1], cwd);
    printWorkflowHelp(workflow, args[1]);
    return;
  }
  if (args[0] === "validate") {
    if (!args[1]) throw new Error("A workflow name or path is required");
    const { workflow } = await loadFlow(args[1], cwd);
    console.log(`valid: ${workflow.name}`);
    return;
  }
  if (args[0] === "list") {
    console.log(formatFlowCatalog(await listFlows(cwd)));
    return;
  }
  if (args[0] === "inspect") {
    if (!args[1]) throw new Error("A run ID is required");
    const stepIndex = args.indexOf("--step");
    const stepId = stepIndex >= 0 ? args[stepIndex + 1] : undefined;
    if (stepIndex >= 0 && !stepId) throw new Error("--step requires a step ID");
    const inspected = await inspectRun(cwd, args[1], stepId);
    console.log(JSON.stringify({ run_id: inspected.run.id, flow: inspected.run.workflow, status: inspected.run.status, steps: inspected.steps.map((step) => summarizeStep(step)) }, null, 2));
    return;
  }

  let workflowRef = process.env.FLOW_WORKFLOW?.trim();
  let optionArgs: string[];
  if (args[0] === "run") {
    if (args[1] && !args[1].startsWith("--")) { workflowRef = args[1]; optionArgs = args.slice(2); }
    else optionArgs = args.slice(1);
  } else optionArgs = args;

  if (!workflowRef) throw new Error("No default workflow configured. Set FLOW_WORKFLOW or specify one with `flow run <workflow>`.");
  const workflowPath = resolveFlowPath(workflowRef, cwd);
  if (!existsSync(workflowPath)) throw new Error(`Workflow not found: ${workflowRef}`);
  const { workflow } = await loadFlow(workflowRef, cwd);
  const provided: Record<string, unknown> = {};
  for (let i = 0; i < optionArgs.length; i++) {
    const option = optionArgs[i];
    if (!option.startsWith("--")) throw new Error(`Unexpected argument: ${option}`);
    const name = option.slice(2).replace(/-/g, "_");
    const raw = workflow.inputs?.[name];
    if (raw === undefined) throw new Error(`Unknown workflow input: ${option}`);
    const definition = inputDefinition(raw);
    if (definition.type === "boolean") provided[name] = true;
    else {
      const value = optionArgs[++i];
      if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
      provided[name] = value;
    }
  }
  const inputs = resolveInputs(workflow, { ...defaultInputs(workflow), ...provided });
  const { run } = await runFlow({ flow: workflowRef, cwd, inputs, output: quiet ? "quiet" : "normal" });
  process.exitCode = run.status === "succeeded" ? 0 : 1;
}

main().catch((error) => { console.error(`flow: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });

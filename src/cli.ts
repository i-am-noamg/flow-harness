import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadWorkflow } from "./loader.js";
import { execute } from "./executor.js";
import type { Workflow } from "./types.js";

function help(): void {
  console.log(`flow - declarative agent workflows

Usage:
  flow <task>                         Run the default workflow
  flow run <workflow.flow> [options]  Run a workflow
  flow validate <workflow.flow>       Validate a workflow

Git commit options:
  --msg <message>             Use this commit message (otherwise generate one)
  --push                      Push after committing
  --force-with-lease          Use force-with-lease when pushing (requires --push)
  --add-all                   Stage all unstaged files before committing (default: false)
  --new-branch [branch-name]  Create a branch; generate a name when omitted

Environment:
  FLOW_WORKFLOW   Default workflow path (default: flows/code-change.flow)
  FLOW_MODEL_CHEAP / CAPABLE / STRONGEST  Model as provider/id
`);
}

function defaultInputs(workflow: Workflow): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [name, definition] of Object.entries(workflow.inputs ?? {})) {
    if (typeof definition !== "string" && definition.default !== undefined) result[name] = definition.default;
    else result[name] = definition === "boolean" ? false : "";
  }
  return result;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === "--help" || args[0] === "-h") return help();
  if (args[0] === "validate") { if (!args[1]) throw new Error("A workflow path is required"); const { workflow } = await loadWorkflow(args[1]); console.log(`valid: ${workflow.name} v${workflow.version}`); return; }

  let workflowFile = process.env.FLOW_WORKFLOW ?? "flows/code-change.flow";
  let task = "";
  let optionArgs: string[] = [];
  if (args[0] === "run") {
    workflowFile = args[1];
    if (!workflowFile) throw new Error("A workflow path is required");
    optionArgs = args.slice(2);
  } else task = args.join(" ");
  if (!existsSync(resolve(workflowFile))) throw new Error(`Workflow not found: ${workflowFile}`);
  const { workflow, root } = await loadWorkflow(workflowFile);
  const inputs = defaultInputs(workflow);
  for (let i = 0; i < optionArgs.length; i++) {
    const option = optionArgs[i];
    if (option === "--task") {
      if (!optionArgs[i + 1] || optionArgs[i + 1].startsWith("--")) throw new Error("--task requires a value");
      const taskParts: string[] = [];
      while (optionArgs[i + 1] && !optionArgs[i + 1].startsWith("--")) taskParts.push(optionArgs[++i]);
      task = taskParts.join(" ");
    } else if (option === "--msg") {
      if (!optionArgs[i + 1] || optionArgs[i + 1].startsWith("--")) throw new Error("--msg requires a value");
      inputs.msg = optionArgs[++i];
    } else if (option === "--push") inputs.push = true;
    else if (option === "--force-with-lease") inputs.force_with_lease = true;
    else if (option === "--add-all") inputs.add_all = true;
    else if (option === "--new-branch") {
      inputs.new_branch = true;
      if (optionArgs[i + 1] && !optionArgs[i + 1].startsWith("--")) inputs.branch = optionArgs[++i];
      else inputs.branch = "";
    } else if (option.startsWith("--")) throw new Error(`Unknown flag: ${option}`);
    else throw new Error(`Unexpected argument: ${option}`);
  }
  if (inputs.force_with_lease === true && inputs.push !== true) throw new Error("--force-with-lease requires --push");
  if (workflow.name !== "git-commit" && !task) throw new Error("A task is required");
  const run = await execute(workflow, root, process.cwd(), task, inputs);
  process.exitCode = run.status === "succeeded" ? 0 : 1;
}

main().catch((error) => { console.error(`flow: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });

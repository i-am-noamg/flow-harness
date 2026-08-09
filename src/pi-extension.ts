import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execute } from "./executor.js";
import { loadWorkflow } from "./loader.js";

const FlowRunParams = Type.Object({
  flow: Type.String({ description: "Flow name (from flows/) or path to a .flow file" }),
  inputs: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Workflow-defined inputs" })),
  cwd: Type.Optional(Type.String({ description: "Repository directory; defaults to the current Pi directory" })),
});

const FlowParams = Type.Object({
  flow: Type.String({ description: "Flow name or path to a .flow file" }),
});

function flowPath(flow: string, cwd: string): string {
  if (flow.includes("/") || flow.endsWith(".flow")) return resolve(cwd, flow);
  return resolve(cwd, "flows", `${flow}.flow`);
}

async function availableFlows(cwd: string): Promise<string[]> {
  const directory = resolve(cwd, "flows");
  if (!existsSync(directory)) return [];
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".flow"))
    .map((entry) => entry.name.slice(0, -5))
    .sort();
}

function summarize(run: any): string {
  const steps = run.steps.map((step: any) => `${step.id}: ${step.status}`).join(", ");
  return `Flow ${run.workflow} ${run.status}. Run ${run.id}. Steps: ${steps}`;
}

export default function flowExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nFlow guidance: When a user request matches a workflow in the repository's flows/ directory, prefer the run_flow tool instead of manually reproducing the workflow. Use list_flows when unsure. Pass values through the workflow's declared inputs; do not assume a universal task field. Use validate_flow after editing a flow. Treat the flow result as evidence and continue the conversation naturally.`,
  }));

  pi.registerTool({
    name: "run_flow",
    label: "Run flow",
    description: "Run a validated deterministic workflow. Pass all values through workflow-defined inputs. Prefer this for tasks matching an available flow; it returns a compact result while preserving detailed run state on disk.",
    parameters: FlowRunParams,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const cwd = params.cwd ? resolve(ctx.cwd, params.cwd) : ctx.cwd;
      const file = flowPath(params.flow, cwd);
      if (!existsSync(file)) {
        const flows = await availableFlows(cwd);
        return { content: [{ type: "text", text: `Flow not found: ${params.flow}. Available flows: ${flows.join(", ") || "none"}` }], details: { status: "failed" } };
      }
      onUpdate?.({ content: [{ type: "text", text: `Running flow ${params.flow}...` }], details: { status: "running", flow: params.flow } });
      const { workflow, root } = await loadWorkflow(file);
      const run = await execute(workflow, root, cwd, params.inputs ?? {}, true);
      const text = summarize(run);
      onUpdate?.({ content: [{ type: "text", text }], details: run });
      return {
        content: [{ type: "text", text }],
        details: {
          run_id: run.id,
          flow: run.workflow,
          status: run.status,
          steps: run.steps,
          cwd,
          run_file: relative(cwd, resolve(cwd, ".flow", "runs", `${run.id}.json`)),
        },
      };
    },
  });

  pi.registerTool({
    name: "list_flows",
    label: "List flows",
    description: "List workflows available in the current repository.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const flows = await availableFlows(ctx.cwd);
      return { content: [{ type: "text", text: flows.length ? flows.join("\n") : "No flows found in flows/" }], details: { flows } };
    },
  });

  pi.registerTool({
    name: "validate_flow",
    label: "Validate flow",
    description: "Validate a flow before running or after editing it.",
    parameters: FlowParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const file = flowPath(params.flow, ctx.cwd);
      try {
        const { workflow } = await loadWorkflow(file);
        return { content: [{ type: "text", text: `Valid flow: ${workflow.name}` }], details: { valid: true, flow: workflow.name } };
      } catch (error) {
        return { content: [{ type: "text", text: `Invalid flow: ${error instanceof Error ? error.message : String(error)}` }], details: { valid: false } };
      }
    },
  });

  pi.registerCommand("flows", {
    description: "List available flow workflows",
    handler: async (_args, ctx) => {
      const flows = await availableFlows(ctx.cwd);
      ctx.ui.notify(flows.length ? `Flows: ${flows.join(", ")}` : "No flows found in flows/", "info");
    },
  });
}

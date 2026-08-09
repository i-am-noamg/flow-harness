import { resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inspectRun, listFlows, loadFlow, runFlow, summarizeRun, summarizeStep } from "./flow-service.js";

const FlowRunParams = Type.Object({
  flow: Type.String({ description: "Flow name (from flows/) or path to a .flow file" }),
  inputs: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Workflow-defined inputs" })),
  cwd: Type.Optional(Type.String({ description: "Repository directory; defaults to the current Pi directory" })),
});
const FlowParams = Type.Object({ flow: Type.String({ description: "Flow name or path to a .flow file" }) });
const InspectParams = Type.Object({
  run_id: Type.String({ description: "Flow run ID" }),
  step_id: Type.Optional(Type.String({ description: "Only inspect this step" })),
  fields: Type.Optional(Type.Array(Type.String({ description: "Top-level or result field to return" }))),
});

function catalogText(catalog: Awaited<ReturnType<typeof listFlows>>): string {
  return catalog.length ? catalog.map((flow) => `- ${flow.name}${flow.description ? `: ${flow.description}` : ""}${flow.inputs.length ? ` (inputs: ${flow.inputs.join(", ")})` : ""}${flow.outputs.length ? ` (outputs: ${flow.outputs.join(", ")})` : ""}`).join("\n") : "(none)";
}
function summaryText(summary: ReturnType<typeof summarizeRun>): string {
  const steps = summary.steps.map((step) => `${step.id}: ${step.status}${step.outcome && step.outcome !== "completed" ? ` (${step.outcome})` : ""}`).join(", ");
  const outputs = Object.keys(summary.outputs).length ? `\nOutputs:\n${JSON.stringify(summary.outputs, null, 2)}` : "";
  const failures = summary.failures.length ? `\nFailures:\n${JSON.stringify(summary.failures, null, 2)}` : "";
  return `Flow ${summary.flow} ${summary.status}. Run ${summary.run_id}. Steps: ${steps}.${outputs}${failures}\nDetailed evidence: ${summary.run_file}; use inspect_flow_run when a requested fact is not present above.`;
}

export default function flowExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => {
    const catalog = await listFlows(event.systemPromptOptions.cwd);
    return { systemPrompt: `${event.systemPrompt}\n\nFlow guidance: Prefer run_flow for requests matching an available workflow. Available workflows:\n${catalogText(catalog)}\nPass values through declared workflow inputs; do not assume a universal task field. Use validate_flow after editing a flow. Treat flow results as evidence, and use inspect_flow_run before answering factual questions about files, commits, logs, or other details omitted from the compact result. Do not infer omitted details.` };
  });

  pi.registerTool({
    name: "run_flow",
    label: "Run flow",
    description: "Run a deterministic workflow with declared inputs. Returns a compact result; use inspect_flow_run for detailed logs.",
    parameters: FlowRunParams,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const cwd = params.cwd ? resolve(ctx.cwd, params.cwd) : ctx.cwd;
      try {
        onUpdate?.({ content: [{ type: "text", text: `Running flow ${params.flow}...` }], details: { status: "running", flow: params.flow } });
        const { summary } = await runFlow({ flow: params.flow, cwd, inputs: params.inputs, output: "quiet" });
        const text = summaryText(summary);
        onUpdate?.({ content: [{ type: "text", text }], details: summary });
        return { content: [{ type: "text", text }], details: summary };
      } catch (error) {
        const text = `Flow failed to start: ${error instanceof Error ? error.message : String(error)}`;
        return { content: [{ type: "text", text }], details: { status: "failed", error: text } };
      }
    },
  });

  pi.registerTool({
    name: "list_flows",
    label: "List flows",
    description: "List workflows available in the current repository, including descriptions and declared inputs.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const flows = await listFlows(ctx.cwd);
      return { content: [{ type: "text", text: catalogText(flows) }], details: { flows } };
    },
  });

  pi.registerTool({
    name: "inspect_flow_run",
    label: "Inspect flow run",
    description: "Inspect a saved flow run or one of its steps. Detailed output is truncated to protect context.",
    parameters: InspectParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const inspected = await inspectRun(ctx.cwd, params.run_id, params.step_id);
        const steps = inspected.steps.map((step) => {
          const detailed = summarizeStep(step) as Record<string, any>;
          if (!params.fields?.length) return detailed;
          const selected: Record<string, unknown> = {};
          for (const field of params.fields) {
            if (field.startsWith("result.")) selected.result = { ...(selected.result as Record<string, unknown> ?? {}), [field.slice(7)]: detailed.result?.[field.slice(7)] };
            else if (field in detailed) selected[field] = detailed[field];
          }
          return { id: step.id, ...selected };
        });
        const details = { run_id: inspected.run.id, flow: inspected.run.workflow, status: inspected.run.status, outputs: inspected.run.outputs ?? {}, steps };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      } catch (error) {
        const text = `Run inspection failed: ${error instanceof Error ? error.message : String(error)}`;
        return { content: [{ type: "text", text }], details: { status: "failed", error: text } };
      }
    },
  });

  pi.registerTool({
    name: "validate_flow",
    label: "Validate flow",
    description: "Validate a flow before running or after editing it.",
    parameters: FlowParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const { workflow } = await loadFlow(params.flow, ctx.cwd);
        return { content: [{ type: "text", text: `Valid flow: ${workflow.name}` }], details: { valid: true, flow: workflow.name } };
      } catch (error) {
        return { content: [{ type: "text", text: `Invalid flow: ${error instanceof Error ? error.message : String(error)}` }], details: { valid: false } };
      }
    },
  });

  pi.registerCommand("flows", {
    description: "List available flow workflows",
    handler: async (_args, ctx) => ctx.ui.notify(catalogText(await listFlows(ctx.cwd)), "info"),
  });
}

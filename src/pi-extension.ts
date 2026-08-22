import { resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inspectRun, listFlows, loadFlow, runFlow, summarizeRun, summarizeStep } from "./flow-service.js";
import { formatFlowCatalog } from "./flow-catalog.js";

const FlowRunParams = Type.Object({
  flow: Type.String({ description: "Flow name from flows/ or an explicit .flow path; temporary flows under .flow/tmp/ require their path" }),
  inputs: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Workflow-defined inputs" })),
  cwd: Type.Optional(Type.String({ description: "Repository directory; defaults to the current Pi directory" })),
});
const FlowParams = Type.Object({ flow: Type.String({ description: "Flow name from flows/ or an explicit .flow path; temporary flows under .flow/tmp/ require their path" }) });
const InspectParams = Type.Object({
  run_id: Type.String({ description: "Flow run ID" }),
  step_id: Type.Optional(Type.String({ description: "Only inspect this step" })),
  fields: Type.Optional(Type.Array(Type.String({ description: "Dotted raw step paths to return; numeric segments select array indexes (for example result.tool_evidence.events.0.result.details)" }))),
});

function pathValue(value: unknown, path: string): unknown {
  let current: any = value;
  for (const segment of path.split(".")) {
    if (!segment || current === null || typeof current !== "object" || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  let current: any = target;
  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index];
    const nextIsIndex = /^\d+$/.test(segments[index + 1]);
    current = current[segment] ??= nextIsIndex ? [] : {};
  }
  current[segments.at(-1)!] = value;
}

function summaryText(summary: ReturnType<typeof summarizeRun>): string {
  const steps = summary.steps.map((step) => `${step.id}: ${step.status}${step.exit_code !== undefined ? ` (exit ${step.exit_code})` : ""}${step.error ? ` — ${step.error}` : ""}`).join(", ");
  const outputs = Object.keys(summary.outputs).length ? `\nDeclared outputs: ${JSON.stringify(summary.outputs)}` : "";
  const changed = summary.changed_files.length ? `\nChanged files: ${summary.changed_files.join(", ")}` : "";
  const failures = summary.failures.length ? `\nFailures: ${summary.failures.map((failure) => `${failure.id}${failure.error ? ` — ${failure.error}` : ""}`).join("; ")}` : "";
  const omitted = summary.omitted ? ` (${Object.entries(summary.omitted).map(([field, count]) => `${count} ${field}`).join(", ")} omitted)` : "";
  return `Flow ${summary.flow}: ${summary.status}. Steps: ${steps || "none"}.${outputs}${changed}${failures}\nEvidence: ${summary.run_file}.${omitted} Inspect omitted or exact details with inspect_flow_run ${summary.run_id}.`;
}

export default function flowExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => {
    const catalog = await listFlows(event.systemPromptOptions.cwd);
    return { systemPrompt: `${event.systemPrompt}\n\nFlow coordination:\nA flow is a declarative workflow made of explicit agent and process steps. Flows are useful when work is repeatable and benefits from explicit orchestration for reliability, token efficiency, or future optimization. A temporary flow is also appropriate for one-off or session-specific work when orchestration would make the result more reliable or efficient. Trivial one-off actions can be done directly.\n\nPrefer a relevant existing flow. Existing flows may be edited or extended when that improves them or adds needed capabilities; do not change one merely as a side effect of completing an unrelated task. Creating or editing a flow is generally easy to revert, so proceed when the user's intent is clear. Before running a flow with permanent or hard-to-revert consequences, such as commits, pushes, destructive changes, or deployments, ask for approval unless the user explicitly requested that action. When the intended flow or change is unclear, ask the user before proceeding.\n\nTemporary flows live under .flow/tmp/ and are Git-ignored. Lifecycle: create .flow/tmp/<name>.flow; validate with validate_flow or flow validate .flow/tmp/<name>.flow; run with run_flow or flow run .flow/tmp/<name>.flow; optionally promote by moving or copying it to flows/<name>.flow, after checking any flow-local prompt references. Bare names resolve only under flows/; temporary flows must always use their explicit path.

When a listed workflow matches the task, prefer the flow tools: after creating or editing a flow, use validate_flow; then use run_flow with its declared inputs. After a flow, use inspect_flow_run on its saved run whenever you need exact implementation facts, verification evidence, failures, metrics, or evidence to optimize the workflow; request targeted dotted fields to keep context bounded. Use direct shell or file tools for trivial one-off work or when no relevant flow exists.\n\n${formatFlowCatalog(catalog)}\nPass values through declared workflow inputs. Use validate_flow after creating or editing a flow. Treat flow results as evidence: never infer omitted details; inspect the saved run when exact evidence is needed.` };
  });

  pi.registerTool({
    name: "run_flow",
    label: "Run flow",
    description: "Run a declarative workflow with its declared inputs. Use a flows/ name or an explicit path for temporary .flow/tmp/ workflows. Returns its status, declared outputs, failures, changed files, and run ID.",
    parameters: FlowRunParams,
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = params.cwd ? resolve(ctx.cwd, params.cwd) : ctx.cwd;
      const statusKey = `flow:${toolCallId}`;
      let completed = 0;
      let total = 0;
      const setStatus = (current: string) => ctx.ui.setStatus(statusKey, `Flow ${params.flow} · ${completed}/${total || "?"} · ${current}`);
      setStatus("starting");
      try {
        const { summary } = await runFlow({
          flow: params.flow,
          cwd,
          inputs: params.inputs,
          output: "quiet",
          onProgress: (event) => {
            if (event.type === "flow_started") {
              total = event.total_steps;
              setStatus("starting");
            } else if (event.type === "step_started") {
              setStatus(event.id);
            } else {
              if (!event.loop_id) completed++;
              setStatus(`${event.id} ${event.status}`);
            }
          },
        });
        const text = summaryText(summary);
        return { content: [{ type: "text", text }], details: summary };
      } catch (error) {
        const text = `Flow failed to start: ${error instanceof Error ? error.message : String(error)}`;
        return { content: [{ type: "text", text }], details: { status: "failed", error: text } };
      } finally {
        ctx.ui.setStatus(statusKey, undefined);
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
      return { content: [{ type: "text", text: formatFlowCatalog(flows) }], details: { flows } };
    },
  });

  pi.registerTool({
    name: "inspect_flow_run",
    label: "Inspect flow run",
    description: "Inspect saved flow-run evidence or one step. Omit fields for a bounded summary; provide dotted raw step paths (including numeric array indexes) for exact final agent output, tool events, command evidence, failures, or metrics. Never infer details omitted from a bounded result.",
    parameters: InspectParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const inspected = await inspectRun(ctx.cwd, params.run_id, params.step_id);
        const steps = inspected.steps.map((step) => {
          if (!params.fields?.length) return summarizeStep(step);
          const selected: Record<string, unknown> = {};
          for (const field of params.fields) {
            const value = pathValue(step, field);
            if (value !== undefined) setPath(selected, field, value);
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
    description: "Validate a flow before running or after editing it; use an explicit .flow/tmp/ path for temporary workflows.",
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
    handler: async (_args, ctx) => ctx.ui.notify(formatFlowCatalog(await listFlows(ctx.cwd)), "info"),
  });
}

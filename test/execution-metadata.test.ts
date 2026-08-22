import test from "node:test";
import assert from "node:assert/strict";
import { updateRunMetadata } from "../src/executor.js";
import type { RunState } from "../src/types.js";

function agent(overrides: Record<string, unknown> = {}) {
  return {
    output: "answer", model: "requested-model", response_model: "response-model", duration: 1.5,
    thinking_level: "low", prompt_chars: 10, output_chars: 6, prompt_path: "prompt.md", input_chars: { task: 4 },
    context_usage: { availability: "available", tokens: 100 }, turns: 1, tool_calls: 1, retries: 0,
    stop_reasons: [], tool_names: ["read"], effective_tools: ["read", "grep"], tool_results: 0, tool_failures: 0,
    turn_metrics: [], ...overrides,
  };
}

test("run agent metadata aggregates stable evidence without fabricating context totals", () => {
  const run: RunState = {
    id: "run", workflow: "workflow", cwd: process.cwd(), started_at: "2025-01-01T00:00:00.000Z", finished_at: "2025-01-01T00:00:05.000Z", status: "succeeded",
    steps: [
      { id: "inspect", declared_id: "inspect", type: "agent", status: "succeeded", started_at: "2025-01-01T00:00:00.000Z", finished_at: "2025-01-01T00:00:01.000Z", result: agent() as any },
      { id: "check[1].repair", declared_id: "repair", loop_id: "check", type: "agent", status: "succeeded", started_at: "2025-01-01T00:00:01.000Z", finished_at: "2025-01-01T00:00:02.000Z", result: agent({ model: "repair-model", output_chars: 8, input_chars: { test: 7 }, effective_tools: ["edit"], tool_names: ["edit"] }) as any },
      { id: "check[2].repair", declared_id: "repair", loop_id: "check", type: "agent", status: "skipped", started_at: "2025-01-01T00:00:02.000Z", finished_at: "2025-01-01T00:00:03.000Z", result: agent() as any },
    ],
  };

  updateRunMetadata(run);

  assert.deepEqual(run.agent_metrics, {
    agent_steps: 3, total_agent_duration_ms: 4500, prompt_chars: 30, declared_input_chars: 15, output_chars: 20, repair_iterations: 1,
    requested_models: ["repair-model", "requested-model"], turns: 3, tool_calls: 3, retries: 0, providers: [], apis: [], response_models: ["response-model"], contexts: [],
    effective_tools: ["edit", "grep", "read"], actual_tools: ["edit", "read"], tool_names: ["edit", "read"], tool_failures: 0,
    total_context_usage: { availability: "unavailable", reason: "Pi exposes per-agent session snapshots, not a cumulative run context total" },
  });
});

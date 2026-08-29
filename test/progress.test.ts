import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { emitStepProgress, execute } from "../src/executor.js";
import type { FlowLiveActivityEvent, FlowProgressEvent, Workflow } from "../src/types.js";

const node = process.execPath;
const command = (id: string, script: string, parallel?: string) => ({ id, type: "exec" as const, parallel, program: node, args: ["-e", script] });

test("agent progress is a transient payload-safe cumulative invocation snapshot", () => {
  const event: FlowProgressEvent = {
    type: "agent_progress", run_id: "run", flow: "flow", id: "check[1].agent", declared_id: "agent", loop_id: "check", loop_iteration: 1,
    status: "running", duration_ms: 50, usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 }, turns: 1, tool_calls: 0, retries: 0,
  };
  assert.equal(event.type, "agent_progress");
  if (event.type === "agent_progress") {
    assert.equal(event.usage?.totalTokens, 12);
    assert.equal("preview" in event, false);
  }
  const activity: FlowLiveActivityEvent = { run_id: "run", flow: "flow", id: "check[1].agent", declared_id: "agent", duration_ms: 50, kind: "text", preview: "private live text" };
  assert.equal(activity.preview, "private live text");
  assert.equal(JSON.stringify(event).includes(activity.preview), false);
});

test("step finish progress reports lifecycle fields without final agent output", () => {
  const events: FlowProgressEvent[] = [];
  const run = { id: "run", workflow: "flow" } as any;
  const started_at = "2025-01-01T00:00:00.000Z";
  emitStepProgress((event) => events.push(event), "step_finished", run, {
    id: "repeat[1].agent", declared_id: "agent", loop_id: "repeat", type: "agent", status: "succeeded", started_at, finished_at: "2025-01-01T00:00:01.000Z",
    result: { output: "saved agent output" } as any,
  }, 1);
  const agent = events[0];
  assert.equal(agent.type, "step_finished");
  if (agent.type === "step_finished") {
    assert.equal(agent.id, "repeat[1].agent");
    assert.equal(agent.loop_id, "repeat");
    assert.equal(agent.loop_iteration, 1);
    assert.equal("agent_output" in agent, false);
  }
});

test("progress reports ordered step lifecycle events with loop qualification", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "flow-progress-"));
  const events: FlowProgressEvent[] = [];
  const workflow: Workflow = {
    name: "progress",
    steps: [
      { ...command("skipped", "process.exit(0)"), when: "ready == true" },
      command("failed", "process.exit(1)"),
      { id: "repeat", type: "loop", until: "done == true", maxIterations: 1, steps: [command("child", "process.exit(0)", "child")] },
    ],
  };
  try {
    const run = await execute({ workflow, root: cwd, cwd, inputs: { ready: false, done: true }, output: "quiet", onProgress: (event) => events.push(event) });
    assert.equal(events[0]?.type, "flow_started");
    for (const id of ["skipped", "failed", "child", "repeat"]) {
      const started = events.findIndex((event) => event.type === "step_started" && event.id === id);
      const finished = events.findIndex((event) => event.type === "step_finished" && event.id === id);
      assert.ok(started >= 0, `${id} started`);
      assert.ok(finished > started, `${id} finished after start`);
    }
    const skipped = events.find((event) => event.type === "step_finished" && event.id === "skipped");
    const failed = events.find((event) => event.type === "step_finished" && event.id === "failed");
    const child = events.find((event) => event.type === "step_finished" && event.id === "child");
    assert.equal(skipped?.status, "skipped");
    assert.equal(failed?.status, "failed");
    assert.equal(child?.loop_id, "repeat");
    assert.equal(child?.loop_iteration, 1);
    assert.ok((child?.duration_ms ?? -1) >= 0);
    assert.deepEqual(run.steps.map((step) => step.id), ["skipped", "failed", "repeat", "child"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

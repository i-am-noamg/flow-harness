import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execute } from "../src/executor.js";
import { validateWorkflow } from "../src/loader.js";
import type { Workflow } from "../src/types.js";

const node = process.execPath;

function command(id: string, delay: number, parallel = false) {
  return { id, type: "exec" as const, parallel, program: node, args: ["-e", `setTimeout(() => console.log(${JSON.stringify(id)}), ${delay})`] };
}

test("parallel batches preserve declaration order and wait at barriers", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "flow-parallel-"));
  const workflow: Workflow = {
    name: "parallel",
    steps: [command("slow", 180, true), command("fast", 180, true), command("after", 1)],
  };
  const started = Date.now();
  const run = await execute({ workflow, root: cwd, cwd, output: "quiet" });
  const elapsed = Date.now() - started;
  assert.equal(run.status, "succeeded");
  assert.deepEqual(run.steps.map((step) => step.id), ["slow", "fast", "after"]);
  assert.ok(elapsed < 350, `parallel batch took ${elapsed}ms`);
  const saved = JSON.parse(await readFile(join(cwd, ".flow", "runs", `${run.id}.json`), "utf8"));
  assert.deepEqual(saved.steps.map((step: { id: string }) => step.id), ["slow", "fast", "after"]);
});

test("parallel steps cannot depend on sibling artifacts", () => {
  assert.throws(() => validateWorkflow({
    name: "invalid-parallel",
    steps: [
      { ...command("first", 1, true), outputs: ["value"] },
      { ...command("second", 1, true), args: ["-e", "console.log('ok')", "{{first.value}}"] },
    ],
  }), /depend on sibling artifact/);
});

test("parallel batches reject writing agents", () => {
  assert.throws(() => validateWorkflow({
    name: "invalid-agent",
    steps: [
      { id: "agent", type: "agent", parallel: true, writes: true, prompt: "prompt.md" },
    ],
  }), /writing agents cannot run in parallel/);
});

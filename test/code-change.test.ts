import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execute, makePrompt } from "../src/executor.js";
import { loadWorkflow, validateWorkflow } from "../src/loader.js";
import type { Workflow } from "../src/types.js";

async function workspace(scripts: Record<string, string>): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "flow-code-change-"));
  await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "checks", version: "1.0.0", scripts }));
  return cwd;
}

function checks(until = "test.outcome == passed && (lint.outcome == passed || lint.outcome == unavailable)"): Workflow {
  return {
    name: "checks",
    outputs: { test_outcome: "test.outcome", lint_outcome: "lint.outcome" },
    steps: [{
      id: "check_and_repair", type: "loop", maxIterations: 1, until,
      steps: [
        { id: "lint", type: "check", script: "lint", required: false, parallel: true, console: "never" },
        { id: "test", type: "check", script: "test", parallel: true, console: "never" },
      ],
    }],
  };
}

test("checks complete when test passes and lint is unavailable, retaining full check evidence", async () => {
  const cwd = await workspace({ test: "node -e \"console.log('test evidence')\"" });
  try {
    const run = await execute({ workflow: checks(), root: cwd, cwd, output: "quiet" });
    assert.equal(run.status, "succeeded");
    assert.deepEqual(run.outputs, { test_outcome: "passed", lint_outcome: "unavailable" });
    const lint = run.steps.find((step) => step.id === "lint")!;
    const checked = run.steps.find((step) => step.id === "test")!;
    assert.equal((lint.result as any).outcome, "unavailable");
    assert.equal(lint.status, "succeeded");
    assert.equal((checked.result as any).outcome, "passed");
    assert.match((checked.result as any).stdout, /test evidence/);
    const saved = JSON.parse(await readFile(join(cwd, ".flow", "runs", `${run.id}.json`), "utf8"));
    assert.match(saved.steps.find((step: { id: string }) => step.id === "test").result.stdout, /test evidence/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("available lint and test failures are repairable and exhaust only after the bounded loop", async () => {
  for (const [name, scripts] of [
    ["lint only", { lint: "node -e \"process.exit(1)\"", test: "node -e \"process.exit(0)\"" }],
    ["test only", { lint: "node -e \"process.exit(0)\"", test: "node -e \"process.exit(1)\"" }],
    ["both", { lint: "node -e \"process.exit(1)\"", test: "node -e \"process.exit(1)\"" }],
  ] as const) {
    const cwd = await workspace(scripts);
    try {
      const run = await execute({ workflow: checks(), root: cwd, cwd, output: "quiet" });
      assert.equal(run.status, "failed", name);
      const loop = run.steps[0];
      assert.equal((loop.result as any).exhausted, true, name);
      assert.equal(run.steps.filter((step) => step.id === "lint" && step.status === "failed").length, scripts.lint.includes("exit(1)") ? 1 : 0, name);
      assert.equal(run.steps.filter((step) => step.id === "test" && step.status === "failed").length, scripts.test.includes("exit(1)") ? 1 : 0, name);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

test("a required unavailable test check is fatal and takes precedence over repair", async () => {
  const cwd = await workspace({ lint: "node -e \"process.exit(1)\"" });
  try {
    const run = await execute({ workflow: checks(), root: cwd, cwd, output: "quiet" });
    assert.equal(run.status, "failed");
    assert.equal((run.steps.find((step) => step.id === "test")!.result as any).outcome, "unavailable");
    assert.equal((run.steps.find((step) => step.id === "lint")!.result as any).outcome, "failed");
    assert.equal((run.steps[0].result as any).iterations.length, 1);
    assert.equal((run.steps[0].result as any).exhausted, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("check contract is validated and the code-change repair prompt receives only selected check fields", async () => {
  assert.throws(() => validateWorkflow({ name: "bad-check", steps: [{ id: "check", type: "check", script: "", required: "no" as any }] }), /check requires a package script/);
  assert.throws(() => validateWorkflow({ name: "bad-required-check", steps: [{ id: "check", type: "check", script: "test", required: "no" as any }] }), /check required must be a boolean/);
  const { workflow, root } = await loadWorkflow(join(process.cwd(), "flows", "code-change.flow"));
  const loop = workflow.steps.find((step) => step.id === "check_and_repair") as Extract<Workflow["steps"][number], { type: "loop" }>;
  const repair = loop.steps.find((step) => step.id === "repair")! as any;
  const prompt = await makePrompt(repair, root, process.cwd(), {
    task: "task", plan: "plan", repair: { history: ["prior"] },
    lint: { outcome: "failed", exit_code: 1, failure_output: "lint failure", stdout: "hidden lint stream" },
    test: { outcome: "failed", exit_code: 1, failure_output: "test failure", stdout: "hidden test stream" },
  }, workflow.name);
  assert.match(prompt.text, /lint failure/);
  assert.match(prompt.text, /test failure/);
  assert.doesNotMatch(prompt.text, /hidden (lint|test) stream/);
});

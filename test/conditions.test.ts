import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execute } from "../src/executor.js";
import { runFlow } from "../src/flow-service.js";
import type { ExecStep, Workflow } from "../src/types.js";

const node = process.execPath;
const command = (id: string): ExecStep => ({ id, type: "exec", program: node, args: ["-e", "console.log('ran')"] });

async function run(workflow: Workflow, inputs: Record<string, unknown> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "flow-conditions-"));
  try {
    return await execute({ workflow, root: cwd, cwd, inputs, output: "quiet" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("conditions respect parentheses and boolean precedence", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "flow-conditions-"));
  try {
    const flow = join(cwd, "condition.flow");
    await writeFile(flow, [
      "name: condition",
      "inputs:",
      "  left: boolean",
      "  right: boolean",
      "steps:",
      "  - id: matched",
      "    type: exec",
      `    program: ${JSON.stringify(node)}`,
      `    args: ["-e", ${JSON.stringify("console.log('matched')")}]`,
      "    when: '(left == true && right == false) || (left == false && right == true)'",
    ].join("\n"));

    const result = await runFlow({ flow, cwd, inputs: { left: true, right: false }, output: "quiet" });
    assert.equal(result.run.status, "succeeded");
    assert.equal(result.run.steps[0]?.status, "succeeded");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("known false conditions skip, continue, and exhaust loops normally", async () => {
  const when = await run({ name: "when-false", steps: [{ ...command("when"), when: "ready == true && missing.value == true" }] }, { ready: false });
  assert.equal(when.status, "succeeded");
  assert.equal(when.steps[0]?.status, "skipped");

  const stopWhen = await run({ name: "stop-when-false", steps: [{ ...command("stop"), stopWhen: "ready == true" }] }, { ready: false });
  assert.equal(stopWhen.status, "succeeded");
  assert.equal(stopWhen.steps[0]?.status, "succeeded");
  assert.match((stopWhen.steps[0]?.result as { output: string }).output, /ran/);

  const until = await run({ name: "until-false", steps: [{ id: "loop", type: "loop", until: "ready == true", maxIterations: 2, steps: [command("body")] }] }, { ready: false });
  assert.equal(until.status, "failed");
  const loop = until.steps[0]?.result as { iterations: unknown[]; exhausted: boolean };
  assert.equal(loop.iterations.length, 2);
  assert.equal(loop.exhausted, true);
});

test("unknown condition artifacts fail when, stopWhen, and until deterministically", async () => {
  const condition = "missing.value == true";
  const when = await run({ name: "when-unknown", steps: [{ ...command("when"), when: condition }] });
  assert.equal(when.status, "failed");
  assert.equal(when.steps[0]?.status, "failed");
  assert.equal(when.steps[0]?.result, undefined);
  assert.match(when.steps[0]?.error ?? "", /Unknown condition artifact\/path: missing.value/);

  const stopWhen = await run({ name: "stop-when-unknown", steps: [{ ...command("stop"), stopWhen: condition }] });
  assert.equal(stopWhen.status, "failed");
  assert.equal(stopWhen.steps[0]?.status, "failed");
  assert.match((stopWhen.steps[0]?.result as { output: string }).output, /ran/);
  assert.match(stopWhen.steps[0]?.error ?? "", /Unknown condition artifact\/path: missing.value/);

  const until = await run({ name: "until-unknown", steps: [{ id: "loop", type: "loop", until: condition, maxIterations: 2, steps: [command("body")] }] });
  assert.equal(until.status, "failed");
  const loop = until.steps[0]?.result as { iterations: unknown[]; exhausted: boolean };
  assert.equal(loop.iterations.length, 1);
  assert.equal(loop.exhausted, false);
});

test("unsupported conditions fail when, stopWhen, and runtime until evaluation", async () => {
  const condition = "ready";
  const when = await run({ name: "when-invalid", steps: [{ ...command("when"), when: condition }] });
  assert.equal(when.status, "failed");
  assert.equal(when.steps[0]?.result, undefined);
  assert.match(when.steps[0]?.error ?? "", /Unsupported condition: ready/);

  const stopWhen = await run({ name: "stop-when-invalid", steps: [{ ...command("stop"), stopWhen: condition }] });
  assert.equal(stopWhen.status, "failed");
  assert.match((stopWhen.steps[0]?.result as { output: string }).output, /ran/);
  assert.match(stopWhen.steps[0]?.error ?? "", /Unsupported condition: ready/);

  // Construct directly so loader validation does not mask runtime behavior.
  const until = await run({ name: "until-invalid", steps: [{ id: "loop", type: "loop", until: condition, maxIterations: 2, steps: [command("body")] }] });
  assert.equal(until.status, "failed");
  const loop = until.steps[0]?.result as { iterations: unknown[]; exhausted: boolean };
  assert.equal(loop.iterations.length, 1);
  assert.equal(loop.exhausted, false);
  assert.match(until.steps[0]?.error ?? "", /Unsupported condition: ready/);
});

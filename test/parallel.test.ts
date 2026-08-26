import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execute } from "../src/executor.js";
import { validateWorkflow } from "../src/loader.js";
import type { Workflow } from "../src/types.js";

const node = process.execPath;

function command(id: string, delay: number, parallel?: string) {
  return { id, type: "exec" as const, parallel, program: node, args: ["-e", `setTimeout(() => console.log(${JSON.stringify(id)}), ${delay})`] };
}

const parallelBarrier = [
  'const { existsSync, writeFileSync } = require("node:fs");',
  "const [id, ...peers] = process.argv.slice(1);",
  'writeFileSync(`${id}.ready`, "");',
  "const wait = new Int32Array(new SharedArrayBuffer(4));",
  "const deadline = Date.now() + 5_000;",
  "while (!peers.every((peer) => existsSync(`${peer}.ready`))) {",
  '  if (Date.now() >= deadline) throw new Error("parallel peer did not start");',
  "  Atomics.wait(wait, 0, 0, 10);",
  "}",
  'writeFileSync(`${id}.done`, "");',
].join("\n");

function barrierCommand(id: string, peer: string) {
  return { id, type: "exec" as const, parallel: "batch", program: node, args: ["-e", parallelBarrier, id, peer], timeout: 10_000 };
}

test("parallel batches preserve declaration order and wait at barriers", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "flow-parallel-"));
  const workflow: Workflow = {
    name: "parallel",
    steps: [
      barrierCommand("slow", "fast"),
      barrierCommand("fast", "slow"),
      { id: "after", type: "exec", program: node, args: ["-e", 'const { existsSync } = require("node:fs"); if (!existsSync("slow.done") || !existsSync("fast.done")) throw new Error("parallel batch did not finish");'] },
    ],
  };
  const run = await execute({ workflow, root: cwd, cwd, output: "quiet" });
  assert.equal(run.status, "succeeded");
  assert.deepEqual(run.steps.map((step) => step.id), ["slow", "fast", "after"]);
  const saved = JSON.parse(await readFile(join(cwd, ".flow", "runs", `${run.id}.json`), "utf8"));
  assert.deepEqual(saved.steps.map((step: { id: string }) => step.id), ["slow", "fast", "after"]);
});

test("named parallel groups run concurrently and create barriers between groups", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "flow-parallel-groups-"));
  const requireEvidence = 'if (!require("node:fs").existsSync("first.done") || !require("node:fs").existsSync("second.done")) throw new Error("evidence group did not finish");';
  const workflow: Workflow = {
    name: "parallel-groups",
    steps: [
      { ...barrierCommand("first", "second"), parallel: "evidence" },
      { ...barrierCommand("second", "first"), parallel: "evidence" },
      { ...barrierCommand("review-one", "review-two"), parallel: "specialist-review", args: ["-e", `${requireEvidence}\n${parallelBarrier}`, "review-one", "review-two"] },
      { ...barrierCommand("review-two", "review-one"), parallel: "specialist-review", args: ["-e", `${requireEvidence}\n${parallelBarrier}`, "review-two", "review-one"] },
    ],
  };
  const run = await execute({ workflow, root: cwd, cwd, output: "quiet" });
  assert.equal(run.status, "succeeded");
  assert.deepEqual(run.steps.map((step) => step.id), ["first", "second", "review-one", "review-two"]);
});

test("parallel steps cannot depend on sibling artifacts", () => {
  for (const parallel of ["evidence", "review"] as const) {
    assert.throws(() => validateWorkflow({
      name: "invalid-parallel",
      steps: [
        { ...command("first", 1, parallel), outputs: ["value"] },
        { ...command("second", 1, parallel), args: ["-e", "console.log('ok')", "{{first.value}}"] },
      ],
    }), /depend on sibling artifact/);
  }
  assert.doesNotThrow(() => validateWorkflow({
    name: "parallel-barrier-dependency",
    steps: [
      { ...command("first", 1, "evidence"), outputs: ["value"] },
      { ...command("second", 1, "review"), args: ["-e", "console.log('ok')", "{{first.value}}"] },
    ],
  }));
});

test("parallel batches reject writing agents", () => {
  for (const parallel of ["evidence", "review"] as const) {
    assert.throws(() => validateWorkflow({
      name: "invalid-agent",
      steps: [
        { id: "agent", type: "agent", model: "cheap", thinkingLevel: "low", parallel, writes: true, prompt: "prompt.md" },
      ],
    }), /writing agents cannot run in parallel/);
  }
});

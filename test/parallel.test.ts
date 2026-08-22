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
  return { id, type: "exec" as const, parallel: true, program: node, args: ["-e", parallelBarrier, id, peer], timeout: 10_000 };
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
      { id: "agent", type: "agent", model: "cheap", thinkingLevel: "low", parallel: true, writes: true, prompt: "prompt.md" },
    ],
  }), /writing agents cannot run in parallel/);
});

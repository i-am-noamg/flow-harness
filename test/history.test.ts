import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execute, historyEntry } from "../src/executor.js";
import { validateWorkflow } from "../src/loader.js";
import type { Workflow } from "../src/types.js";

const node = process.execPath;

test("loop step history keeps all outputs while the alias stays latest", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "flow-history-"));
  const workflow: Workflow = {
    name: "history",
    outputs: { latest: "value.output", all: "value.history" },
    steps: [{
      id: "repeat",
      type: "loop",
      until: "value.exit_code == 0",
      maxIterations: 3,
      steps: [{
        id: "value",
        type: "exec",
        history: true,
        outputFormat: "single-line",
        program: node,
        args: ["-e", "const fs=require('node:fs'); const n=fs.existsSync('.counter') ? Number(fs.readFileSync('.counter','utf8')) : 0; fs.writeFileSync('.counter', String(n+1)); console.log(n); process.exitCode = n === 0 ? 1 : 0;"],
      }],
    }],
  };
  const run = await execute({ workflow, root: cwd, cwd, output: "quiet" });
  assert.equal(run.status, "succeeded");
  assert.equal(run.outputs?.latest, "1");
  assert.deepEqual(run.outputs?.all, ["0", "1"]);
});

test("ANSI process output is stripped from workflow values and history", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "flow-history-ansi-"));
  const workflow: Workflow = {
    name: "ansi-history",
    outputs: { latest: "value.output", all: "value.history" },
    steps: [{
      id: "repeat",
      type: "loop",
      until: "value.exit_code == 0",
      maxIterations: 1,
      steps: [{
        id: "value",
        type: "exec",
        history: true,
        outputFormat: "single-line",
        program: node,
        args: ["-e", "process.stdout.write('\\u001b[33m1\\u001b[39m\\n')"],
      }],
    }],
  };
  const run = await execute({ workflow, root: cwd, cwd, output: "quiet" });
  assert.equal(run.status, "succeeded");
  assert.equal(run.outputs?.latest, "1");
  assert.deepEqual(run.outputs?.all, ["1"]);
});

test("agent history entries preserve multiple named outputs", () => {
  const artifact = { x: "first", y: "second", z: "third" };
  assert.deepEqual(historyEntry(artifact, ["x", "y", "z"], JSON.stringify(artifact)), artifact);
});

test("history must be boolean and belongs on loop-body steps", () => {
  assert.throws(() => validateWorkflow({
    name: "invalid-history",
    steps: [{ id: "step", type: "exec", program: node, history: "yes" as any }],
  }), /history must be a boolean/);
  assert.throws(() => validateWorkflow({
    name: "invalid-top-level-history",
    steps: [{ id: "agent", type: "agent", model: "cheap", thinkingLevel: "low", prompt: "prompt.md", history: true }],
  }), /history belongs on loop-body steps/);
  assert.doesNotThrow(() => validateWorkflow({
    name: "valid-agent-history",
    steps: [{
      id: "loop",
      type: "loop",
      until: "done == true",
      steps: [{ id: "agent", type: "agent", model: "cheap", thinkingLevel: "low", prompt: "prompt.md", outputFormat: "json", outputs: ["x", "y", "z"], history: true }],
    }],
  }));
  assert.throws(() => validateWorkflow({
    name: "invalid-loop-history",
    steps: [{ id: "loop", type: "loop", history: true, until: "step.exit_code == 0", steps: [{ id: "step", type: "exec", program: node }] }],
  }), /history belongs on loop-body steps/);
});

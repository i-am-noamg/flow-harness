import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateOutputExpression, parseOutputExpression } from "../src/outputs.js";
import { execute } from "../src/executor.js";
import type { Workflow } from "../src/types.js";

function lookup(path: string, artifacts: Record<string, unknown>): unknown {
  return path.split(".").reduce<unknown>((value, part) => value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined, artifacts);
}

test("output expressions parse paths, literals, comparisons, and conditions", () => {
  assert.deepEqual(parseOutputExpression("step.output || false || 0 || \"\""), {
    kind: "fallback",
    candidates: [
      { kind: "path", path: "step.output" },
      { kind: "literal", value: false },
      { kind: "literal", value: 0 },
      { kind: "literal", value: "" },
    ],
  });
  assert.deepEqual(parseOutputExpression("condition(push.status == succeeded || force_push.status == succeeded)").candidates[0], {
    kind: "condition",
    expression: "push.status == succeeded || force_push.status == succeeded",
  });
});

test("output evaluation preserves falsey values and falls back only from undefined", () => {
  const artifacts = { false_value: false, zero: 0, empty: "", step: { status: "succeeded" }, force_push: { status: "succeeded" } };
  for (const [expression, expected] of [["false_value || true", false], ["zero || 1", 0], ["empty || \"fallback\"", ""], ["missing || \"fallback\"", "fallback"], ["step.status == succeeded", true], ["condition(missing.status == succeeded || force_push.status == succeeded)", true]] as const) {
    assert.equal(evaluateOutputExpression("result", expression, (path) => lookup(path, artifacts)), expected);
  }
});

test("unresolved output expressions identify the missing path", () => {
  assert.throws(() => evaluateOutputExpression("result", "missing.value || absent", () => undefined), /unknown artifact\/path: missing.value/);
  assert.throws(() => parseOutputExpression("condition(ready)"), /Unsupported condition: ready/);
  assert.throws(() => parseOutputExpression("value ||"), /Invalid output expression/);
});

const node = process.execPath;
async function runWithOutputError(name: string, workflow: Workflow, expression = "missing.value") {
  const cwd = await mkdtemp(join(tmpdir(), "flow-outputs-"));
  try {
    const run = await execute({ workflow: { ...workflow, name, outputs: { result: expression } }, root: cwd, cwd, output: "quiet" });
    const persisted = JSON.parse(await readFile(join(cwd, ".flow", "runs", `${run.id}.json`), "utf8"));
    assert.equal(run.status, "failed");
    assert.equal(run.output_error?.output, "result");
    assert.equal(run.output_error?.expression, expression);
    assert.equal(persisted.status, "failed");
    assert.equal(persisted.output_error.output, "result");
    return { run, persisted };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("unresolved outputs fail and persist on normal, stopped, and failed-step completion", async () => {
  for (const [name, workflow] of [
    ["normal-output-error", { name: "ignored", steps: [{ id: "ok", type: "exec", program: node, args: ["-e", ""] }] }],
    ["stopped-output-error", { name: "ignored", steps: [{ id: "stop", type: "exec", program: node, args: ["-e", ""], stopWhen: "stop.exit_code == 0" }] }],
    ["failed-output-error", { name: "ignored", steps: [{ id: "fail", type: "exec", program: node, args: ["-e", "process.exit(1)"] }] }],
  ] as const) {
    const { run, persisted } = await runWithOutputError(name, workflow);
    assert.equal(run.output_error?.path, "missing.value");
    assert.equal(persisted.output_error.path, "missing.value");
  }
});

test("invalid output expressions fail with persisted output-resolution evidence", async () => {
  const { run, persisted } = await runWithOutputError("invalid-output-error", { name: "ignored", steps: [{ id: "ok", type: "exec", program: node, args: ["-e", ""] }] }, "value ||");
  assert.match(run.output_error?.error ?? "", /Invalid output expression/);
  assert.match(persisted.output_error.error, /Invalid output expression/);
});

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

test("output expressions parse scalar values, boolean expressions, and if selection", () => {
  assert.deepEqual(parseOutputExpression("if((push.status == succeeded || force_push.status == succeeded) && enabled != false, message, \"not pushed\")"), {
    kind: "if",
    condition: "(push.status == succeeded || force_push.status == succeeded) && enabled != false",
    whenTrue: { kind: "path", path: "message" },
    whenFalse: { kind: "literal", value: "not pushed" },
  });
  assert.deepEqual(parseOutputExpression("(step.status == succeeded && enabled == true) || override == true"), {
    kind: "condition",
    expression: "(step.status == succeeded && enabled == true) || override == true",
  });
});

test("output evaluation preserves exact scalar values and evaluates boolean expressions", () => {
  const artifacts = { false_value: false, zero: 0, empty: "", step: { status: "succeeded" }, force_push: { status: "succeeded" }, enabled: true, msg: "" };
  for (const [expression, expected] of [["false_value", false], ["zero", 0], ["empty", ""], ["step.status == succeeded && enabled == true", true], ["step.status == failed || force_push.status == succeeded", true], ["(step.status == succeeded && enabled == false) || force_push.status == succeeded", true], ["if(msg != \"\", msg, \"generated\")", "generated"]] as const) {
    assert.equal(evaluateOutputExpression("result", expression, (path) => lookup(path, artifacts)), expected);
  }
});

test("if evaluates only its selected branch and supports nested, quoted arguments", () => {
  assert.equal(evaluateOutputExpression("result", "if(ready == true, present, missing.value)", (path) => lookup(path, { ready: true, present: "selected" })), "selected");
  assert.equal(evaluateOutputExpression("result", "if(ready == false, missing.value, false_value)", (path) => lookup(path, { ready: true, false_value: false })), false);
  assert.equal(evaluateOutputExpression("result", "if((ready == true && enabled == true), if(other == true, \"yes, indeed\", \"no\"), \"fallback\")", (path) => lookup(path, { ready: true, enabled: true, other: true })), "yes, indeed");
});

test("removed and malformed output syntax fails clearly", () => {
  for (const expression of ["condition(ready == true)", "value || fallback", "if(ready == true, value)", "if(ready, value, fallback)", "if(ready == true, value,)", "value > 1"] as const) {
    assert.throws(() => parseOutputExpression(expression));
  }
  assert.throws(() => evaluateOutputExpression("result", "missing.value", () => undefined), /unknown artifact\/path: missing.value/);
  assert.throws(() => evaluateOutputExpression("result", "if(ready == true, missing.value, fallback)", (path) => lookup(path, { ready: true, fallback: "unused" })), /unknown artifact\/path: missing.value/);
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
  assert.match(run.output_error?.error ?? "", /Invalid condition/);
  assert.match(persisted.output_error.error, /Invalid condition/);
});

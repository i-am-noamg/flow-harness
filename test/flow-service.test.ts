import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { listFlows, loadFlow, resolveFlowPath, runFlow, summarizeRun } from "../src/flow-service.js";

const node = process.execPath;

function flowYaml(name: string, label: string): string {
  return [
    `name: ${name}`,
    `description: ${label} flow`,
    "steps:",
    "  - id: report",
    "    type: exec",
    `    program: ${JSON.stringify(node)}`,
    `    args: ["-e", ${JSON.stringify(`console.log(${JSON.stringify(label)})`)}]`,
  ].join("\n");
}

async function fixture(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "flow-service-"));
  await mkdir(join(cwd, "flows"), { recursive: true });
  await mkdir(join(cwd, ".flow", "tmp"), { recursive: true });
  return cwd;
}

test("listFlows keeps repository and temporary workflows distinct", async () => {
  const cwd = await fixture();
  try {
    await writeFile(join(cwd, "flows", "repository.flow"), flowYaml("repository", "repository"));
    await writeFile(join(cwd, ".flow", "tmp", "session.flow"), flowYaml("session", "temporary"));

    const flows = await listFlows(cwd);
    assert.deepEqual(flows.map((flow) => flow.name), ["repository", "session"]);
    assert.equal(flows[0].temporary, undefined);
    assert.equal(flows[1].temporary, true);
    assert.equal(relative(cwd, flows[1].path), ".flow/tmp/session.flow");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("run summaries are bounded and exclude raw command output", () => {
  const run: any = {
    id: "run", workflow: "summary", cwd: "/repo", started_at: "2025-01-01T00:00:00.000Z", status: "failed",
    outputs: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`output_${index}`, "x".repeat(2_000)])),
    steps: Array.from({ length: 21 }, (_, index) => ({
      id: `step_${index}`, declared_id: `step_${index}`, type: "exec", status: index === 0 ? "failed" : "succeeded", started_at: "2025-01-01T00:00:00.000Z",
      error: index === 0 ? "failed command" : undefined,
      result: { exit_code: index === 0 ? 1 : 0, stdout: "secret stdout", stderr: "secret stderr", changed_files: index === 0 ? ["changed.ts"] : [] },
    })),
  };
  const summary = summarizeRun(run, "/repo");
  assert.equal(summary.steps.length, 20);
  assert.equal(Object.keys(summary.outputs).length, 20);
  assert.deepEqual(summary.changed_files, ["changed.ts"]);
  assert.equal(summary.failures[0]?.error, "failed command");
  assert.equal("stdout" in summary.failures[0]!, false);
  assert.match(summary.run_file, /^\.flow\/runs\/run\.json$/);
  assert.deepEqual(summary.omitted, { steps: 1, outputs: 1 });
});

test("temporary flows require explicit paths while bare names resolve under flows", async () => {
  const cwd = await fixture();
  try {
    await writeFile(join(cwd, "flows", "same.flow"), flowYaml("repository", "repository"));
    await writeFile(join(cwd, ".flow", "tmp", "same.flow"), flowYaml("temporary", "temporary"));

    assert.equal(resolveFlowPath("same", cwd), join(cwd, "flows", "same.flow"));
    assert.equal((await loadFlow("same", cwd)).workflow.name, "repository");
    assert.equal((await loadFlow(".flow/tmp/same.flow", cwd)).workflow.name, "temporary");

    const result = await runFlow({ flow: ".flow/tmp/same.flow", cwd, output: "quiet" });
    assert.equal(result.run.status, "succeeded");
    assert.match(String(result.run.steps[0].result && "stdout" in result.run.steps[0].result ? result.run.steps[0].result.stdout : ""), /temporary/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

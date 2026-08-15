import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { listFlows, loadFlow, resolveFlowPath, runFlow } from "../src/flow-service.js";

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

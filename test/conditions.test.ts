import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { runFlow } from "../src/flow-service.js";

const node = process.execPath;

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

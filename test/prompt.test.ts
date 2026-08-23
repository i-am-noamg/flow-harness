import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makePrompt } from "../src/executor.js";

const workflowSource = `name: workflow
steps:
  - id: check
    type: exec
    program: npm
    args: [test]
  - id: diagnose
    type: shell
    command: git status --short
`;

test("execution metadata coordinates agent work and declared commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-prompt-"));
  try {
    await writeFile(join(root, "prompt.md"), "Work on {{task}}.");
    const prompt = await makePrompt({
      id: "agent", type: "agent", model: "cheap", thinkingLevel: "low", prompt: "prompt.md", inputs: ["task"],
    }, root, root, { task: "the change" }, "workflow", { stepId: "agent", workflowSource });

    assert.match(prompt.text, /Do not duplicate any `exec` or `shell` command declared in this workflow YAML\./);
    assert.match(prompt.text, /You may run commands needed for implementation or diagnosis when they are not declared in the workflow\./);
    assert.match(prompt.text, /Do not duplicate work assigned to other agent steps\./);
    assert.match(prompt.text, /Use available declared artifacts from prior agent steps, and leave work assigned to later agent steps for those steps\./);
    assert.match(prompt.text, /You may perform work needed for your own assignment\./);
    assert.ok(prompt.text.includes(workflowSource));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

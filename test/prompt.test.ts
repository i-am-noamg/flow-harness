import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("named local skills are injected in declaration order with evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-prompt-"));
  try {
    await writeFile(join(root, "prompt.md"), "Follow the instructions.");
    await mkdir(join(root, "skills", "first"), { recursive: true });
    await mkdir(join(root, "skills", "nested", "second-directory"), { recursive: true });
    const first = "---\nname: first\ndescription: First skill.\n---\nFirst skill complete content.";
    const second = "---\nname: second\ndescription: Second skill.\n---\nSecond skill complete content.";
    await writeFile(join(root, "skills", "first", "SKILL.md"), first);
    await writeFile(join(root, "skills", "nested", "second-directory", "SKILL.md"), second);
    const prompt = await makePrompt({ id: "agent", type: "agent", model: "cheap", thinkingLevel: "low", prompt: "prompt.md", skills: ["first", "second"] }, root, root, {}, "workflow");

    const firstPath = join(root, "skills", "first", "SKILL.md");
    const secondPath = join(root, "skills", "nested", "second-directory", "SKILL.md");
    assert.ok(prompt.text.indexOf("First skill complete content.") < prompt.text.indexOf("Second skill complete content."));
    assert.match(prompt.text, new RegExp(`<skill name="first" location="${firstPath}">\\nReferences are relative to ${join(root, "skills", "first")}\\.\\n\\nFirst skill complete content\\.\\n</skill>`));
    assert.ok(!prompt.text.includes("description: First skill."));
    assert.deepEqual(prompt.loaded_skills, [
      { name: "first", path: firstPath, content_chars: first.length },
      { name: "second", path: secondPath, content_chars: second.length },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing named local skill fails clearly", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-prompt-"));
  try {
    await writeFile(join(root, "prompt.md"), "Follow the instructions.");
    await assert.rejects(() => makePrompt({ id: "agent", type: "agent", model: "cheap", thinkingLevel: "low", prompt: "prompt.md", skills: ["missing"] }, root, root, {}, "workflow"), /agent: failed to load skill missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

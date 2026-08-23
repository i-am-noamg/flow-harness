import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execute, makePrompt, resolveEffectiveAgentStep } from "../src/executor.js";
import { loadWorkflow } from "../src/loader.js";
import type { AgentStep, Workflow } from "../src/types.js";

async function workspace(scripts: Record<string, string>): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "flow-code-change-"));
  await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "checks", version: "1.0.0", scripts }));
  return cwd;
}

function checks(until = "lint.exit_code == 0 && test.exit_code == 0"): Workflow {
  return {
    name: "checks",
    outputs: { test_exit_code: "test.exit_code", lint_exit_code: "lint.exit_code" },
    steps: [{
      id: "check_and_repair", type: "loop", maxIterations: 1, until,
      steps: [
        { id: "lint", type: "exec", program: "npm", args: ["run", "lint", "--if-present"], parallel: true, console: "never" },
        { id: "test", type: "exec", program: "npm", args: ["test"], parallel: true, console: "never" },
      ],
    }],
  };
}

test("lint --if-present and test run independently, retaining full command evidence", async () => {
  const cwd = await workspace({ test: "node -e \"console.log('test evidence')\"" });
  try {
    const run = await execute({ workflow: checks(), root: cwd, cwd, output: "quiet" });
    assert.equal(run.status, "succeeded");
    assert.deepEqual(run.outputs, { test_exit_code: 0, lint_exit_code: 0 });
    const lint = run.steps.find((step) => step.id === "lint")!;
    const tested = run.steps.find((step) => step.id === "test")!;
    assert.equal((lint.result as any).exit_code, 0);
    assert.equal(lint.status, "succeeded");
    assert.equal((tested.result as any).exit_code, 0);
    assert.match((tested.result as any).stdout, /test evidence/);
    const saved = JSON.parse(await readFile(join(cwd, ".flow", "runs", `${run.id}.json`), "utf8"));
    assert.match(saved.steps.find((step: { id: string }) => step.id === "test").result.stdout, /test evidence/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("lint and test failures exhaust only after the bounded loop", async () => {
  for (const [name, scripts] of [
    ["lint only", { lint: "node -e \"process.exit(1)\"", test: "node -e \"process.exit(0)\"" }],
    ["test only", { lint: "node -e \"process.exit(0)\"", test: "node -e \"process.exit(1)\"" }],
    ["both", { lint: "node -e \"process.exit(1)\"", test: "node -e \"process.exit(1)\"" }],
  ] as const) {
    const cwd = await workspace(scripts);
    try {
      const run = await execute({ workflow: checks(), root: cwd, cwd, output: "quiet" });
      assert.equal(run.status, "failed", name);
      const loop = run.steps[0];
      assert.equal((loop.result as any).exhausted, true, name);
      assert.equal(run.steps.filter((step) => step.id === "lint" && step.status === "failed").length, scripts.lint.includes("exit(1)") ? 1 : 0, name);
      assert.equal(run.steps.filter((step) => step.id === "test" && step.status === "failed").length, scripts.test.includes("exit(1)") ? 1 : 0, name);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

test("the code-change workflow uses scoped research guidance and a strong plan agent", async () => {
  const { workflow, root } = await loadWorkflow(join(process.cwd(), "flows", "code-change.flow"));
  const simple = workflow.inputs!.simple as { description: string };
  const plan = workflow.steps.find((step) => step.id === "plan") as AgentStep;

  assert.match(simple.description, /narrow, well-scoped changes with clear expected behavior/);
  assert.equal(plan.model, "strongest");
  assert.equal(plan.thinkingLevel, "high");

  const [inspectPrompt, planPrompt, implementPrompt] = await Promise.all([
    readFile(join(root, "prompts", "code-change", "inspect.md"), "utf8"),
    readFile(join(root, "prompts", "code-change", "plan.md"), "utf8"),
    readFile(join(root, "prompts", "code-change", "implement.md"), "utf8"),
  ]);
  assert.match(inspectPrompt, /avoid duplicate investigation and broad research/);
  assert.match(planPrompt, /Rely on `repo_summary` unless it lacks a fact required to make the plan/);
  assert.match(planPrompt, /avoid duplicate investigation and broad research/);
  assert.match(implementPrompt, /Inspect only the files you must change or verify/);
  assert.match(implementPrompt, /avoid duplicate or broad research/);
  assert.match(implementPrompt, /do not reopen external documentation unless the plan leaves a specific question/);
});

test("the code-change repair prompt receives only requested command results", async () => {
  const { workflow, root } = await loadWorkflow(join(process.cwd(), "flows", "code-change.flow"));
  const loop = workflow.steps.find((step) => step.id === "check_and_repair") as Extract<Workflow["steps"][number], { type: "loop" }>;
  const lint = loop.steps.find((step) => step.id === "lint")! as any;
  const tested = loop.steps.find((step) => step.id === "test")! as any;
  assert.deepEqual(lint.args, ["run", "lint", "--if-present"]);
  assert.deepEqual(tested.args, ["test"]);
  const repair = loop.steps.find((step) => step.id === "repair")! as any;
  const prompt = await makePrompt(repair, root, process.cwd(), {
    task: "task", plan: "plan", repair: { history: ["prior"] },
    lint: { exit_code: 1, output: "lint failure", stdout: "hidden lint stream" },
    test: { exit_code: 1, output: "test failure", stdout: "hidden test stream" },
  }, workflow.name);
  assert.match(prompt.text, /lint failure/);
  assert.match(prompt.text, /test failure/);
  assert.doesNotMatch(prompt.text, /hidden (lint|test) stream/);
});

async function isolatedPrompt(step: Partial<AgentStep>, artifacts: Record<string, unknown>): Promise<Awaited<ReturnType<typeof makePrompt>>> {
  const root = await mkdtemp(join(tmpdir(), "flow-prompt-inputs-"));
  try {
    await writeFile(join(root, "prompt.md"), "declared={{declared}} nested={{nested.visible}} hidden={{hidden}} sibling={{nested.sibling}}");
    return await makePrompt({ id: "agent", type: "agent", model: "cheap", thinkingLevel: "low", prompt: "prompt.md", ...step }, root, root, artifacts, "workflow");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("agent prompts expose only declared artifacts and declared nested paths", async () => {
  const result = await isolatedPrompt({ inputs: ["declared", "nested.visible"] }, {
    declared: "allowed", hidden: "secret", nested: { visible: "shown", sibling: "secret sibling" },
  });

  assert.match(result.text, /declared=allowed nested=shown hidden= sibling=/);
  assert.match(result.text, /--- declared ---\n"allowed"/);
  assert.match(result.text, /--- nested\.visible ---\n"shown"/);
  assert.doesNotMatch(result.text, /secret/);
  assert.deepEqual(result.input_chars, { declared: 9, "nested.visible": 7 });
});

test("agent prompts retain skipped inputs and omit unavailable inputs", async () => {
  const skipped = { status: "skipped", output: "" };
  const result = await isolatedPrompt({ inputs: ["skipped", "unavailable"] }, { skipped });

  assert.match(result.text, /--- skipped ---\n\{\n  "status": "skipped",\n  "output": ""\n\}/);
  assert.doesNotMatch(result.text, /--- unavailable ---|undefined/);
  assert.deepEqual(result.input_chars, { skipped: JSON.stringify(skipped, null, 2).length });
});

test("selected variant inputs override parent inputs for prompt visibility", async () => {
  const step: AgentStep = {
    id: "agent", type: "agent", model: "cheap", thinkingLevel: "low", inputs: ["parent"],
    variants: [{ id: "selected", when: "route == true", model: "cheap", thinkingLevel: "low", prompt: "prompt.md", inputs: ["declared"] }],
  };
  const effective = resolveEffectiveAgentStep(step, { route: true, parent: "secret", declared: "allowed" })!;
  const result = await isolatedPrompt(effective.step, { parent: "secret", declared: "allowed" });

  assert.equal(effective.variant?.id, "selected");
  assert.match(result.text, /declared=allowed/);
  assert.doesNotMatch(result.text, /secret|--- parent ---/);
});

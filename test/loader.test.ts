import test from "node:test";
import assert from "node:assert/strict";
import { validateWorkflow } from "../src/loader.js";
import type { ThinkingLevel } from "../src/types.js";

const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function agent(overrides: Record<string, unknown> = {}) {
  return { id: "agent", type: "agent", model: "cheap", thinkingLevel: "low", prompt: "prompt.md", ...overrides } as any;
}

test("agent thinkingLevel accepts all Pi levels on steps and variants", () => {
  for (const thinkingLevel of levels) {
    assert.doesNotThrow(() => validateWorkflow({
      name: "thinking-levels",
      steps: [agent({ thinkingLevel })],
    }));
    assert.doesNotThrow(() => validateWorkflow({
      name: "variant-thinking-levels",
      steps: [agent({
        prompt: undefined,
        variants: [{ id: "variant", when: "ready == true", model: "cheap", thinkingLevel, prompt: "prompt.md" }],
      })],
    }));
  }
});

test("agent model and thinkingLevel are required on steps", () => {
  assert.throws(() => validateWorkflow({
    name: "missing-model",
    steps: [agent({ model: undefined })],
  }), /agent: model is required/);
  assert.throws(() => validateWorkflow({
    name: "missing-thinking-level",
    steps: [agent({ thinkingLevel: undefined })],
  }), /agent: thinkingLevel is required/);
});

test("agent variant model and thinkingLevel are required", () => {
  assert.throws(() => validateWorkflow({
    name: "missing-variant-model",
    steps: [agent({
      prompt: undefined,
      variants: [{ id: "variant", when: "ready == true", thinkingLevel: "low", prompt: "prompt.md" }],
    })],
  }), /agent\.variant: model is required/);
  assert.throws(() => validateWorkflow({
    name: "missing-variant-thinking-level",
    steps: [agent({
      prompt: undefined,
      variants: [{ id: "variant", when: "ready == true", model: "cheap", prompt: "prompt.md" }],
    })],
  }), /agent\.variant: thinkingLevel is required/);
});

test("agent thinkingLevel rejects invalid step values", () => {
  for (const thinkingLevel of ["default", 1, true]) {
    assert.throws(() => validateWorkflow({
      name: "invalid-thinking-level",
      steps: [agent({ thinkingLevel })],
    }), /agent: thinkingLevel must be one of/);
  }
});

test("agent variant thinkingLevel rejects invalid values", () => {
  for (const thinkingLevel of ["default", 1, false]) {
    assert.throws(() => validateWorkflow({
      name: "invalid-variant-thinking-level",
      steps: [agent({
        prompt: undefined,
        variants: [{ id: "variant", when: "ready == true", model: "cheap", thinkingLevel, prompt: "prompt.md" }],
      })],
    }), /agent\.variant: thinkingLevel must be one of/);
  }
});

test("agent tools accepts valid and empty step and variant allowlists", () => {
  assert.doesNotThrow(() => validateWorkflow({
    name: "agent-tools",
    steps: [agent({ tools: [], prompt: undefined, variants: [{ id: "variant", when: "ready == true", model: "cheap", thinkingLevel: "low", prompt: "prompt.md", tools: ["read", "grep"] }] })],
  }));
});

test("agent tools rejects invalid allowlists on steps and variants", () => {
  for (const [tools, message] of [
    ["read", "tools must be an array"],
    [["read", 1], "tools must contain strings"],
    [["unknown"], "unsupported tool: unknown"],
    [["read", "read"], "duplicate tool: read"],
  ] as const) {
    assert.throws(() => validateWorkflow({ name: "invalid-tools", steps: [agent({ tools })] }), new RegExp(`agent: ${message}`));
    assert.throws(() => validateWorkflow({
      name: "invalid-variant-tools",
      steps: [agent({ prompt: undefined, variants: [{ id: "variant", when: "ready == true", model: "cheap", thinkingLevel: "low", prompt: "prompt.md", tools }] })],
    }), new RegExp(`agent\\.variant: ${message}`));
  }
});

test("output expressions validate paths, fallbacks, and explicit conditions", () => {
  assert.doesNotThrow(() => validateWorkflow({
    name: "outputs",
    outputs: { value: "missing.value || false", pushed: "condition(push.status == succeeded || force_push.status == succeeded)" },
    steps: [{ id: "step", type: "exec", program: "echo" }],
  }));
  for (const expression of ["value ||", "condition(ready)", "value > 1"] as const) {
    assert.throws(() => validateWorkflow({
      name: "invalid-output",
      outputs: { value: expression },
      steps: [{ id: "step", type: "exec", program: "echo" }],
    }), /Invalid output expression for value/);
  }
});

test("condition syntax supports nested boolean expressions without resolving artifacts", () => {
  assert.doesNotThrow(() => validateWorkflow({
    name: "conditions",
    steps: [
      { id: "first", type: "exec", program: "echo", when: "(missing.ready == true || fallback == false) && enabled != false", stopWhen: "(first.exit_code == 0 && missing.stop != true) || override == true" },
      {
        id: "loop", type: "loop", until: "(nested.done == true || missing.until == false) && enabled == true", steps: [
          { id: "nested", type: "exec", program: "echo", when: "(missing.value == 1 || enabled == true) && nested.ready != false" },
          agent({ id: "select", prompt: undefined, variants: [{ id: "chosen", when: "(missing.variant == true || enabled == true) && nested.ready != false", model: "cheap", thinkingLevel: "low", prompt: "prompt.md" }] }),
        ],
      },
    ],
  }));
});

test("condition syntax rejects malformed when, stopWhen, until, and variant conditions", () => {
  for (const [field, expression, step, message] of [
    ["when", "ready == true &&", { id: "when", type: "exec", program: "echo" }, /when: invalid when condition/],
    ["stopWhen", "(ready == true", { id: "stop", type: "exec", program: "echo" }, /stop: invalid stopWhen condition/],
    ["until", "ready > true", { id: "loop", type: "loop", steps: [{ id: "body", type: "exec", program: "echo" }] }, /loop: invalid until condition/],
  ] as const) {
    assert.throws(() => validateWorkflow({ name: `invalid-${field}`, steps: [{ ...step, [field]: expression }] as any }), message);
  }
  assert.throws(() => validateWorkflow({
    name: "invalid-variant",
    steps: [agent({ prompt: undefined, variants: [{ id: "variant", when: "ready", model: "cheap", thinkingLevel: "low", prompt: "prompt.md" }] })],
  }), /agent\.variant: invalid when condition/);
});

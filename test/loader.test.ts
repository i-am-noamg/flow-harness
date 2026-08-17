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

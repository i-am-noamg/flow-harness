import test from "node:test";
import assert from "node:assert/strict";
import { validateWorkflow } from "../src/loader.js";
import type { ThinkingLevel } from "../src/types.js";

const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function agent(overrides: Record<string, unknown> = {}) {
  return { id: "agent", type: "agent", prompt: "prompt.md", ...overrides } as any;
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
        variants: [{ id: "variant", when: "ready == true", prompt: "prompt.md", thinkingLevel }],
      })],
    }));
  }
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
        variants: [{ id: "variant", when: "ready == true", prompt: "prompt.md", thinkingLevel }],
      })],
    }), /agent\.variant: thinkingLevel must be one of/);
  }
});

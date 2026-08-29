import test from "node:test";
import assert from "node:assert/strict";
import { resolveEffectiveAgentStep } from "../src/executor.js";
import type { AgentStep } from "../src/types.js";

const step: AgentStep = {
  id: "agent",
  type: "agent",
  model: "cheap",
  thinkingLevel: "low",
  prompt: "parent.md",
  variants: [
    { id: "selected", when: "enabled == true", prompt: "variant.md", writes: true },
  ],
};

test("resolveEffectiveAgentStep inherits parent fields and preserves variant overrides", () => {
  const resolved = resolveEffectiveAgentStep(step, { enabled: true });
  assert.equal(resolved?.variant?.id, "selected");
  assert.deepEqual(resolved?.step, { ...step, ...step.variants![0], id: "agent", variants: undefined });
});

test("resolveEffectiveAgentStep returns undefined when no variant matches", () => {
  assert.equal(resolveEffectiveAgentStep(step, { enabled: false }), undefined);
});

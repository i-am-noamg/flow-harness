import test from "node:test";
import assert from "node:assert/strict";
import { AgentExecutionError, resolveEffectiveTools, runAgent, type AgentSessionHandle } from "../src/pi-agent.js";

test("resolveEffectiveTools uses documented defaults and preserves explicit lists", () => {
  assert.deepEqual(resolveEffectiveTools(undefined, false), ["read", "grep", "find", "ls"]);
  assert.deepEqual(resolveEffectiveTools(undefined, true), ["read", "bash", "edit", "write", "grep", "find", "ls"]);
  assert.deepEqual(resolveEffectiveTools(["grep"], true), ["grep"]);
  assert.deepEqual(resolveEffectiveTools([], true), []);
});

test("runAgent sets a shared session thinking level before prompting and records the effective level", async () => {
  const calls: string[] = [];
  const session: any = {
    messages: [],
    thinkingLevel: "low",
    sessionId: "test-session",
    subscribe() {
      calls.push("subscribe");
      return () => undefined;
    },
    setThinkingLevel(level: string) {
      calls.push(`set:${level}`);
      this.thinkingLevel = level === "high" ? "medium" : level;
    },
    async prompt() {
      calls.push("prompt");
      this.messages.push({ role: "assistant", content: "done", stopReason: "stop" });
    },
  };
  const shared: AgentSessionHandle = { session, model: "test-model", writes: false, effective_tools: ["read"] };

  const result = await runAgent("prompt", process.cwd(), undefined, false, true, shared, "", {}, "high");

  assert.deepEqual(calls, ["set:high", "subscribe", "prompt"]);
  assert.equal(result.output, "done");
  assert.equal(result.thinking_level, "medium");
  assert.deepEqual(result.effective_tools, ["read"]);
});

test("runAgent preserves metadata when prompting throws", async () => {
  const session: any = {
    messages: [],
    thinkingLevel: "high",
    sessionId: "failed-session",
    subscribe() { return () => undefined; },
    async prompt() { throw new Error("provider failed"); },
  };
  const shared: AgentSessionHandle = { session, model: "test-model", writes: false, effective_tools: [] };

  await assert.rejects(
    runAgent("prompt", process.cwd(), undefined, false, true, shared),
    (error: unknown) => error instanceof AgentExecutionError
      && error.agentResult.thinking_level === "high"
      && error.agentResult.error_message === "provider failed"
      && error.agentResult.effective_tools.length === 0,
  );
});

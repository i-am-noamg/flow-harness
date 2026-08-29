import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "../src/artifacts.js";
import { AgentExecutionError, copyPublicMessages, resolveEffectiveTools, runAgent, seedAgentSession, type AgentSessionHandle } from "../src/pi-agent.js";

test("copyPublicMessages creates an independent public-transcript snapshot", () => {
  const session = { messages: [{ role: "assistant", content: [{ type: "text", text: "seed" }] }] };
  const copy = copyPublicMessages(session);
  session.messages[0].content[0].text = "changed";
  assert.deepEqual(copy, [{ role: "assistant", content: [{ type: "text", text: "seed" }] }]);
  assert.throws(() => copyPublicMessages({}), /does not expose public messages/);
});

test("seedAgentSession installs an independent baseline in Pi agent state", () => {
  const source = { messages: [{ role: "user", content: "evidence" }] };
  const baseline = copyPublicMessages(source);
  const fork = { agent: { state: { messages: [] as any[] } } };
  seedAgentSession(fork, baseline);
  fork.agent.state.messages[0].content = "changed";
  assert.equal(source.messages[0].content, "evidence");
  assert.throws(() => seedAgentSession({}, baseline), /does not expose agent state/);
});

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
  assert.equal(result.output_chars, 4);
  assert.equal(result.thinking_level, "medium");
  assert.deepEqual(result.context_usage, { availability: "unavailable", reason: "Pi session does not expose getContextUsage" });
  assert.deepEqual(result.effective_tools, ["read"]);
});

test("runAgent reports transient cumulative turn usage without changing final usage", async () => {
  let listener: ((event: any) => void) | undefined;
  const session: any = {
    messages: [], thinkingLevel: "low",
    subscribe(callback: (event: any) => void) { listener = callback; return () => undefined; },
    async prompt() {
      this.messages.push({ role: "assistant", content: "done", stopReason: "stop", usage: { input: 10, output: 5, totalTokens: 15, cost: { input: 0.01, output: 0.02, total: 0.03 } } });
      listener?.({ type: "agent_end" });
    },
  };
  const shared: AgentSessionHandle = { session, writes: false, effective_tools: ["read"] };
  const updates: any[] = [];
  const result = await runAgent("prompt", process.cwd(), undefined, false, true, shared, "", {}, undefined, undefined, (update) => updates.push(update));

  assert.deepEqual(updates.at(-1), { usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } }, turns: 1, tool_calls: 0, retries: 0 });
  assert.equal(result.usage?.totalTokens, 15);
  assert.equal(result.usage?.cost?.total, 0.03);
});

test("runAgent reports partial Pi usage immediately without double counting completed usage", async () => {
  let listener: ((event: any) => void) | undefined;
  const reportedUsage = { input: 10, output: 5, totalTokens: 15 };
  const session: any = {
    messages: [], thinkingLevel: "low",
    subscribe(callback: (event: any) => void) { listener = callback; return () => undefined; },
    async prompt() {
      listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done", partial: { usage: reportedUsage } } });
      this.messages.push({ role: "assistant", content: "done", stopReason: "stop", usage: reportedUsage });
      listener?.({ type: "agent_end" });
    },
  };
  const shared: AgentSessionHandle = { session, writes: false, effective_tools: ["read"] };
  const updates: any[] = [];
  const result = await runAgent("prompt", process.cwd(), undefined, false, true, shared, "", {}, undefined, undefined, (update) => updates.push(update));

  assert.deepEqual(updates[0], { usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }, turns: 0, tool_calls: 0, retries: 0 });
  assert.deepEqual(updates.at(-1), { usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }, turns: 1, tool_calls: 0, retries: 0 });
  assert.equal(result.usage?.totalTokens, 15);
});

test("runAgent records stable tool calls and Pi context snapshots", async () => {
  const session: any = {
    messages: [], thinkingLevel: "low", subscribe() { return () => undefined; },
    getContextUsage() { return { tokens: 123, contextWindow: 200, percent: 61.5 }; },
    async prompt() { this.messages.push({ role: "assistant", content: [{ type: "toolCall", name: "read" }, { type: "text", text: "done" }], stopReason: "stop" }); },
  };
  const shared: AgentSessionHandle = { session, writes: false, effective_tools: ["read"] };
  const result = await runAgent("prompt", process.cwd(), undefined, false, true, shared);
  assert.equal(result.output, "done");
  assert.equal(result.output_chars, 4);
  assert.deepEqual(result.tool_names, ["read"]);
  assert.deepEqual(result.context_usage, { availability: "available", tokens: 123, context_window: 200, percent: 61.5 });
});

test("runAgent persists complete ordered transcript-derived tool evidence", async () => {
  const session: any = {
    messages: [{ role: "assistant", content: "earlier" }], thinkingLevel: "low", subscribe() { return () => undefined; },
    async prompt() {
      this.messages.push(
        { role: "assistant", timestamp: 10, content: [{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "src/a.ts" } }, { type: "toolCall", id: "call-bash", name: "bash", arguments: { command: "npm test" } }] },
        { role: "toolResult", timestamp: 11, toolCallId: "call-read", toolName: "read", content: [{ type: "text", text: "file contents" }], details: { path: "src/a.ts" }, isError: false },
        { role: "toolResult", timestamp: 12, toolCallId: "call-bash", toolName: "bash", content: [{ type: "text", text: "failed" }], details: { exitCode: 1 }, isError: true },
        { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
      );
    },
  };
  const shared: AgentSessionHandle = { session, writes: false, effective_tools: ["read", "bash"] };
  const result = await runAgent("prompt", process.cwd(), undefined, false, true, shared);

  assert.equal(result.output, "done");
  assert.deepEqual(result.tool_evidence, {
    availability: "available",
    events: [
      { call_id: "call-read", name: "read", arguments: { path: "src/a.ts" }, source_order: 0, timestamp: 10, result: { content: [{ type: "text", text: "file contents" }], details: { path: "src/a.ts" }, is_error: false, source_order: 2, timestamp: 11 } },
      { call_id: "call-bash", name: "bash", arguments: { command: "npm test" }, source_order: 1, timestamp: 10, result: { content: [{ type: "text", text: "failed" }], details: { exitCode: 1 }, is_error: true, source_order: 3, timestamp: 12 } },
    ],
  });

  const cwd = await mkdtemp(join(tmpdir(), "flow-agent-evidence-"));
  try {
    const store = new RunStore(cwd);
    await store.save({ id: "run", workflow: "test", cwd, started_at: "2025-01-01T00:00:00.000Z", status: "succeeded", steps: [{ id: "agent", declared_id: "agent", type: "agent", status: "succeeded", started_at: "2025-01-01T00:00:00.000Z", result }] });
    const saved = JSON.parse(await readFile(join(cwd, ".flow", "runs", "run.json"), "utf8"));
    assert.deepEqual(saved.steps[0].result.tool_evidence, result.tool_evidence);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runAgent explicitly reports unavailable public transcript evidence", async () => {
  const session: any = {
    agent: { state: { messages: [{ role: "assistant", content: [{ type: "toolCall", id: "private", name: "read", arguments: { path: "secret" } }] }] } },
    thinkingLevel: "low", subscribe() { return () => undefined; }, async prompt() { /* private state must not be read */ },
  };
  const shared: AgentSessionHandle = { session, writes: false, effective_tools: ["read"] };
  const result = await runAgent("prompt", process.cwd(), undefined, false, true, shared);
  assert.equal(result.output, "");
  assert.deepEqual(result.tool_evidence, { availability: "unavailable", reason: "Pi session does not expose public messages" });
  assert.equal(result.tool_calls, 0);
});

test("runAgent preserves partial Pi context snapshots", async () => {
  const session: any = {
    messages: [], thinkingLevel: "low", subscribe() { return () => undefined; },
    getContextUsage() { return { contextWindow: 200 }; },
    async prompt() { this.messages.push({ role: "assistant", content: "done", stopReason: "stop" }); },
  };
  const shared: AgentSessionHandle = { session, writes: false, effective_tools: ["read"] };

  const result = await runAgent("prompt", process.cwd(), undefined, false, true, shared);

  assert.deepEqual(result.context_usage, { availability: "available", context_window: 200 });
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
      && error.agentResult.effective_tools.length === 0
      && error.agentResult.context_usage.availability === "unavailable",
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { agentWorkspaceChanges } from "../src/executor.js";

const before = { fingerprint: "before", files: { "changed.ts": "before", "removed.ts": "removed" } };
const after = { fingerprint: "after", files: { "changed.ts": "after", "added.ts": "added" } };

test("non-writing agents report an unchanged workspace", () => {
  assert.deepEqual(agentWorkspaceChanges(false), { changed: false, changed_files: [] });
});

test("writing agents derive workspace changes from snapshots", () => {
  assert.deepEqual(agentWorkspaceChanges(true, before, after), { changed: true, changed_files: ["added.ts", "changed.ts", "removed.ts"] });
});

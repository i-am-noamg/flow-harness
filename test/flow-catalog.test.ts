import test from "node:test";
import assert from "node:assert/strict";
import { formatFlowCatalog } from "../src/flow-catalog.js";
import type { FlowCatalogEntry } from "../src/types.js";

test("formatFlowCatalog separates flows and shows explicit temporary paths", () => {
  const catalog: FlowCatalogEntry[] = [
    { name: "repository", path: "/repo/flows/repository.flow", description: "A repository workflow", inputs: [{ name: "task", type: "string" }], outputs: ["result"] },
    { name: "session", path: "/repo/.flow/tmp/session.flow", temporary: true, description: "A session workflow", inputs: [], outputs: [] },
  ];

  const text = formatFlowCatalog(catalog);
  assert.match(text, /Available workflows:/);
  assert.match(text, /Temporary workflows:/);
  assert.match(text, /- repository: A repository workflow \(inputs: task:string\) \(outputs: result\)/);
  assert.match(text, /- \.flow\/tmp\/session\.flow: A session workflow/);
  assert.doesNotMatch(text, /use the displayed path/);
  assert.doesNotMatch(text, /session \[temporary:/);
});

test("formatFlowCatalog stays compact for an empty catalog", () => {
  assert.equal(formatFlowCatalog([]), "(none)");
});

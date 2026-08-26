# Flow harness

`flow` is a small declarative workflow harness for coding agents. Its mission is to add determinism to agent work for faster, more reliable results using fewer tokens.

## Core values

Prioritize, in every change:

- **Reliability** — fail clearly, preserve evidence, validate inputs, and make state transitions predictable.
- **Efficiency** — minimize model calls, prompt/context size, process work, and unnecessary output.
- **Simplicity** — prefer small explicit mechanisms over implicit behavior or broad abstractions.
- **Optimizability** — preserve structured artifacts and metrics so workflows can be measured and improved.

## Repository map

- `src/` — TypeScript implementation.
  - `executor.ts` — workflow execution, conditions, loops, parallel batches, artifacts, and run persistence.
  - `loader.ts` — YAML loading and workflow validation.
  - `flow-service.ts` — workflow discovery, input resolution, execution, and compact summaries.
  - `pi-agent.ts` — Pi SDK agent sessions and model/tool configuration.
  - `pi-extension.ts` — Pi tools, injected guidance, and flow presentation.
  - `command.ts` — bounded process execution and output capture.
  - `artifacts.ts` / `workspace.ts` — persisted runs and workspace change tracking.
- `flows/` — declarative workflow definitions.
- `flows/prompts/<flow-name>/` — flow-local prompts; relative `prompt:` references in a workflow resolve from its flow-local prompt directory.
- `test/` — Node test-runner tests.
- `dist/` — generated build output; edit source instead.
- `.flow/runs/` — local run evidence; normally generated and not source code.

## Development

Use:

```bash
npm test       # typecheck and tests
npm run build  # build dist/
npm run dev -- --help
```

When changing a workflow, validate it with `npm run dev -- validate <flow>` or the equivalent Pi tool. Declarative workflow and flow-prompt-only changes should be validated but should not add flow-specific tests unless the task explicitly requests tests or changes harness semantics. Add focused tests for executor, loader, and summary behavior. For changes to prompts or presentation, keep outputs concise and test the underlying structured data where practical.

## Implementation guidance

- Keep workflow semantics explicit and deterministic. Do not silently convert unknown state into success.
- Preserve complete command/agent evidence in run records while returning bounded summaries to callers.
- Treat declared inputs, artifacts, outputs, conditions, and step IDs as public interfaces; update validation and tests when they change.
- Keep parallel steps independent, read-only where required, and deterministic in persisted declaration order.
- Keep agent prompts focused. Pass only the artifacts a step needs, with bounded output sizes and clear formats.
- Avoid unnecessary dependencies and avoid changing generated files by hand.
- Do not weaken tests or hide failures to make a workflow pass.

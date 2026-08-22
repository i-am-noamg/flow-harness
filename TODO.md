# TODO

Ideas for making flow better fulfill its mission: **sprinkle some determinism on your agent for faster, more reliable results using fewer tokens**.

Each item should be independently implementable as a focused commit.

## Agent execution

- [x] Allow each agent step to declare its Pi `tools` allowlist explicitly, and use a documented default when it is omitted. Validate tool names and persist the effective allowlist with the step evidence.
- [x] Ensure `session.dispose()` runs in `runAgent()` even when `session.prompt()` throws.
- [x] Persist agent execution metadata consistently in `.flow/runs/<run-id>.json`, including failures, model metadata, token usage when reported by the SDK, retries, and other relevant execution details.
- [ ] Add measurable agent execution metrics to `.flow/runs/<run-id>.json`: prompt/input size, output size, model, duration, repair-iteration count, total agent time, and total context usage when available. Record effective tools and tools actually used if Pi exposes that information; otherwise document the limitation rather than reconstructing it unreliably from text. Skill/context files loaded may also be useful metadata, but should only be added if Pi exposes them through a stable API or if the run record already captures the relevant session events.

## Artifacts and conditions

- [x] Make artifact passing explicit: ensure agent prompts receive only artifacts listed in the step's `inputs` field, and add tests covering omitted, nested, skipped, and unavailable inputs. Do not impose truncation or hard size limits; users should be able to choose their own context tradeoffs in workflow definitions.
- [x] Make condition handling deterministic: distinguish a known `false` condition from an unknown artifact or unsupported expression instead of silently skipping or retrying. Define and test the resulting failure behavior.
- [x] Validate `when` and `stopWhen` expressions when loading a workflow. This is a fail-fast syntax check only; evaluation still happens during execution after artifacts exist. Share the condition grammar/parser with `until` validation so all three condition types behave consistently.
- [x] Make workflow output expressions explicit and type-safe: support scalar paths/literals, boolean conditions, and `if(condition, when_true, when_false)` while preserving intentional `false`, `0`, and empty strings.

## `code-change` flow

- [x] Replace the current combined `test_and_repair` loop with independent `npm run lint --if-present` and `npm test` commands that run in parallel, then invoke the bounded repair agent only when either command fails.
- [x] Preserve complete lint and test command evidence in `.flow/runs/<run-id>.json` while passing only the explicitly requested, useful results into repair prompts.

## Workflow authoring

- [ ] Add a maintained machine-readable YAML schema for `.flow` files, use it in editor/tooling integrations, and keep it synchronized with runtime validation.

## Pi-flow extension

These skills should ship with the Pi flow extension, alongside the flow tools, rather than live as repository-local skills.

- [x] Add a `flow-authoring` skill to the Pi flow extension that guides agents through creating, improving, extending, validating, documenting, and testing workflows. Include output-format guidance: use `single-line` or `text`/multi-line output for a single output variable, and `json` when an agent step produces multiple named output variables; keep fields and schemas flow-specific rather than hardcoding them in the harness.
- [x] Add an `optimize-flow` skill to the Pi flow extension that analyzes workflow definitions and `.flow/runs/` evidence, then proposes measurable improvements to reliability, efficiency, simplicity, and optimizability.

## Pi integration and presentation

- [ ] Let harness-mode users manually run a flow by addressing it as `$flow-name`, with a clear syntax or interactive prompt for supplying its declared input fields; validate required inputs and present the bounded run result with an inspection path.
- [ ] Rewrite the extension's injected prompt to be clearer and more concise: explain the flow tools, when to use them, input conventions, output semantics, and run-inspection path without duplicating README material. Consider writing the available flows and how to use them so the agent won't need to run list_flows at the start every time.
- [x] Improve `list_flows` output so it is compact and immediately actionable: include a one-line purpose, input types and explicit defaults, and declared outputs without noisy schema repetition.
- [ ] Improve flow output presentation so results are concise and consistently structured, while making failures, changed files, status, and the run-inspection command easy to find.
- [x] Keep routine logs out of compact tool responses, but expose enough evidence to make the next deterministic action obvious.

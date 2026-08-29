---
name: optimize-flow
description: Optimize a workflow, its prompts, models, and tools using run evidence and direct review. Use when improving reliability, accuracy, duration, token cost, prompt quality, simplicity, or optimizability.
---

# Optimize a flow

Optimize the whole workflow, not just its YAML. This can include prompts, model selection, tool selection, step structure, parallelism, conditions, retries, and output handling. Optimize from evidence when available, while also reviewing prompts and workflow design directly. Existing flows are user-owned and may be improved or extended when that serves their real repository workflow. Preserve the intended behavior and public contract unless the requested improvement changes them deliberately.

Use a flow when work is repeatable and benefits from explicit orchestration for reliability, token-cost efficiency, or future optimization. When an optimization workflow agent must follow this local skill, declare `skills: [optimize-flow]`; do not add a command step that reads the skill. A repository-local optimization workflow may consume this general skill, but this skill must not require or point to that workflow.

## Process

1. Read the target `.flow` file, its prompts, relevant harness source, and `AGENTS.md`.
2. Inspect representative `.flow/runs/<run-id>.json` records. Use the run summary first, then inspect individual steps when needed.
3. Establish a baseline:
   - run status and failure modes;
   - agent and command durations;
   - repeated steps and repair iterations;
   - prompt/artifact sizes when recorded;
   - unnecessary model calls, tools, context, or output;
   - explicit `model` and `thinkingLevel` choices relative to each step's difficulty;
   - prompt accuracy, clarity, concision, and instruction conflicts;
   - parallel opportunities and dependency barriers;
   - opportunities to replace agentic work with reliable deterministic steps.
4. Identify the smallest high-confidence improvement. Separate measured problems from hypotheses.
5. Edit the flow, prompts, or implementation as appropriate. Keep user-configurable tradeoffs configurable; do not introduce arbitrary hard limits.
6. After editing a flow, validate it using the `validate_flow` tool.
7. Execute a representative run and compare it with the baseline when possible. Inspect the saved run evidence, including skipped and conditional steps; do not treat a successful run alone as proof that every branch worked.
8. Report the change, evidence, tradeoffs, and remaining uncertainty.

## Review checklist

### Reliability

- Are inputs, outputs, conditions, and step dependencies explicit?
- Are conditional branches exercised independently when practical, including unknown and skipped artifacts? Use run evidence for workflow behavior.
- Can an unknown artifact or command failure be mistaken for success?
- Are retries bounded and does each retry change something relevant?
- Is complete evidence retained in `.flow/runs/`?

### Efficiency

- Can independent read-only steps run in parallel?
- Can an expensive agent call be avoided with a deterministic command or an existing artifact? Prefer deterministic `exec` or `shell` steps whenever they can reliably perform the task; reserve agents for judgment, interpretation, or adaptation.
- Is each step using the least expensive model that can reliably do its job?
- Does each agent receive only the artifacts declared in its `inputs`?
- Are prompts and returned summaries concise without hiding useful evidence?
- Can prompt context, tool availability, retries, or repair iterations be reduced without hurting outcomes?
- Are workflow duration and agentic costs improving relative to a baseline?

### Prompt quality

- Does each prompt state the task, constraints, available inputs, and expected result clearly?
- Does it avoid redundant context, vague instructions, conflicting requirements, and unnecessary role-setting?
- Can it be shorter without reducing accuracy or reliability?

### Simplicity

- Can steps, conditions, or prompt instructions be removed without losing behavior?
- Is shell syntax being used where `exec` would be clearer and safer?

### Optimizability

- Are outputs and failures structured enough to compare runs, without echoing direct flow inputs the caller already knows?
- Are durations, model information, context/tool information, and iteration counts available when Pi exposes them?
- Does the flow preserve a clear baseline and a measurable success condition?

## Constraints

- Do not optimize solely for fewer tokens if it reduces reliability.
- Do not impose hard artifact or prompt-size limits on users. Prefer explicit `inputs`, concise prompts, and flow-level choices.
- Do not infer missing run facts. Inspect the saved run evidence instead.
- Do not commit unless explicitly asked.

---
name: flow-authoring
description: Design, add, improve, or extend a declarative flow workflow. Use when creating a new .flow file, changing an existing workflow, or deciding how an agent task should be orchestrated.
---

# Add or improve a flow

Create the smallest workflow that reliably solves the stated task. See [the workflow YAML reference](references/workflow-schema.md) for the supported shape and examples. It is an authoring reference, not a machine-readable schema; the installed `flow validate` command is authoritative.

Use a flow when work is repeatable and benefits from explicit orchestration for reliability, token-cost efficiency, or future optimization. A temporary flow is also useful for one-off or session-specific work when orchestration improves reliability or efficiency without needing a committed reusable workflow.

## Temporary flows

Temporary flows are Git-ignored and must live under `.flow/tmp/`. Create, validate, and run one with an explicit path:

```bash
mkdir -p .flow/tmp
# create .flow/tmp/<name>.flow
flow validate .flow/tmp/<name>.flow
flow run .flow/tmp/<name>.flow
```

Bare names select only flows under `flows/`; they cannot select temporary flows. To promote a useful temporary flow, use `mv` or `cp` to `flows/<name>.flow` and check any flow-local prompt references after the move.

## Core values

Apply these values to every flow design:

- **Reliability:** make inputs, dependencies, failure behavior, retries, and verification explicit.
- **Efficiency:** choose an appropriately capable model and minimize unnecessary model calls, tools, context, output, and process work.
- **Simplicity:** prefer the smallest clear workflow and avoid abstractions that do not improve the result.
- **Optimizability:** preserve useful artifacts, outputs, and run evidence so future changes can be measured.

## Process

1. Inspect the relevant existing flows and prompts.
2. Decide whether to create a new flow, improve or extend an existing flow, create a temporary flow, or work directly. Existing flows are user-owned and may be changed when the change improves them or adds a useful capability.
3. Identify the workflow contract:
   - required and optional inputs, with useful defaults;
   - public outputs callers actually need;
   - steps, dependencies, failure behavior, and side effects;
   - the explicit model and `thinkingLevel` for each agent step; both are required, with no implicit defaults. Use Pi levels `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
   - the cheapest model/tool set that can perform each agent step; grant the smallest explicit `tools` allowlist needed and keep `writes` accurate when any allowed tool can modify the workspace. Run evidence records the declared effective allowlist separately from tools actually called.
4. Write the `.flow` file under `flows/` and add or update prompt files under `prompts/` when needed. Keep temporary workflows under `.flow/tmp/`, which is ignored by Git.
5. Keep agent boundaries narrow. Declare only the artifacts a step needs with `inputs`; do not rely on an implicit universal `task` input.
6. Every agent step and variant must explicitly declare `model` and `thinkingLevel`; choose levels deliberately and remember Pi may clamp them to model capabilities.
7. Choose output formats deliberately:
   - one output variable: use `single-line` for a scalar line or `text` for prose/multi-line text;
   - multiple named output variables: use `json` and declare the field names in `outputs`;
   - keep the fields and any schema flow-specific. Do not add harness-wide assumptions for one workflow.
8. Use `exec` for direct commands and `shell` only when shell syntax is required. Use a non-empty named group such as `parallel: evidence` only for independent, read-only steps; preserve barriers before dependent steps.
9. Validate the flow and run a representative invocation when practical. Before running a flow with permanent or hard-to-revert consequences, obtain user approval unless that action was explicitly requested.

## Design rules

- Prefer deterministic `exec` or `shell` steps over agent steps whenever they can reliably perform the task; reserve agents for judgment, interpretation, or adaptation.
- Keep prompts concise, operational, and explicit about whether the agent may modify files.
- Write short, specific, indicative descriptions for the workflow and its inputs: state what the flow does, when it applies, and what each input controls. Prefer one useful sentence over implementation detail or generic wording.
- Keep complete evidence in run artifacts but expose only useful declared outputs to later steps.
- Make retries bounded and meaningful. A repair loop must have a concrete success condition and an iteration limit.
- Do not hide command failures with `when`, `stopWhen`, or output formatting.
- Respect repository values: reliability, efficiency, simplicity, and optimizability.
- If a temporary flow proves useful, offer to move it into the repository's available flow location for future reuse.
- Do not commit unless explicitly asked.

## Verification

Run the installed harness to validate the workflow:

```bash
flow validate flows/<name>.flow
```

Use a temporary or representative invocation when practical. Check that the compact result exposes the intended outputs and that detailed evidence is available under `.flow/runs/`.

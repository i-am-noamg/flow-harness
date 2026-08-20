# Flow

## Make agent work repeatable.

Agents are remarkably capable—but a useful agent session is still a hard-to-repeat experiment. It can take a different path next time, spend model calls on routine commands, fail without a clear trail, and leave little evidence for making the next run better.

**Flow is a [Pi](https://pi.dev)-based declarative workflow harness for agents.** It makes agent work **more reliable, faster, cheaper, and easier to debug and optimize** by combining deterministic code with agent judgment in explicit YAML workflows. Each step has explicit inputs, model settings, conditions, and outputs. Every run leaves behind the evidence to inspect, debug, and improve it.

Most useful work is repeatable at some level. The goal may require judgment, but its shape is usually familiar: gather context, make a decision, run known checks, handle expected failures, and produce a result. Flows encode that repeatable structure while leaving the genuinely uncertain parts to an agent.

> Flow brings a little determinism back to agentic work—so it is faster, cheaper, more reliable, and easier to optimize.

## The orchestration layer

The ecosystem already has valuable point solutions: caching, skills, subagents, and model routing. Flow does not replace them; it gives them an explicit, measurable workflow in which to work together.

| Approach | Lowers cost | Reuses instructions | Keeps handoffs bounded | Runs deterministic work directly | Repeatable execution | Bounded failure handling | Inspectable evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Caching | ✓ | — | — | — | — | — | — |
| Skills | — | ✓ | — | — | — | — | — |
| Subagents | ✓ | — | — | — | — | — | — |
| Model routing | ✓ | — | — | — | — | — | — |
| **Flow** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

Flow makes the repeatable parts of a task explicit: commands, dependencies, handoffs, checks, conditions, and retries. Agents receive the context they need and focus on the decisions that require judgment. That is the difference between a chat session and a workflow.

## What a flow looks like

This code-change workflow keeps judgment and mechanics separate: a cheap agent inspects, a stronger one plans, an implementation agent writes, and a bounded loop repairs only failing tests.

```yaml
name: code-change
inputs:
  task:
    type: string
    description: Change to make.

steps:
  - id: inspect
    type: agent
    model: cheap
    thinkingLevel: low
    prompt: inspect.md
    inputs: [task]
    outputs: [repo_summary]

  - id: plan
    type: agent
    model: strongest
    thinkingLevel: high
    prompt: plan.md
    inputs: [task, repo_summary]
    outputs: [plan]

  - id: implement
    type: agent
    model: capable
    thinkingLevel: medium
    prompt: implement.md
    inputs: [task, plan]
    writes: true

  - id: test_and_repair
    type: loop
    maxIterations: 3
    until: test.exit_code == 0
    steps:
      - id: test
        type: exec
        program: npm
        args: [test]

      - id: repair
        type: agent
        model: cheap
        thinkingLevel: medium
        prompt: repair.md
        when: test.exit_code != 0
        inputs: [task, test.output]
        writes: true
```

Flow validates the workflow before it runs. It persists full run evidence—including command output, agent usage, model settings, tool calls, timing, and failures—under `.flow/runs/`. Routine results stay compact; inspect a run when you need the details.

See the complete, production-ready examples: [`code-change`](flows/code-change.flow) and [`git-commit`](flows/git-commit.flow).

## Install

```bash
npm install --global flow-harness
flow --help
```

Or develop from source:

```bash
git clone https://github.com/i-am-noamg/flow-harness.git flow
cd flow
npm install
npm run build
npm link # optional: makes `flow` available globally
```

Flow includes Pi. Authenticate with Pi and configure the model profiles Flow should use:

```bash
export FLOW_MODEL_CHEAP=anthropic/claude-haiku-4-5
export FLOW_MODEL_CAPABLE=anthropic/claude-sonnet-4-5
export FLOW_MODEL_STRONGEST=anthropic/claude-opus-4-5
```

## Use Flow

```bash
# Start Pi with Flow's extension and skills
flow

# Run a named workflow in the current repository
flow run my-flow --task "add input validation to the API"

# Or run an explicit workflow file
flow run flows/my-flow.flow --task "fix the failing tests"

# Optionally configure the workflow used when `flow run` has no workflow argument
FLOW_WORKFLOW=flows/my-flow.flow flow run --task "fix the failing tests"
```

`flow` launches Pi unless the first argument is a workflow command. In Pi, agents can discover, validate, run, and inspect flows directly. From the CLI:

```bash
flow list
flow help my-flow
flow validate flows/my-flow.flow
flow inspect <run-id>
flow inspect <run-id> --step test
```

Workflows are project-local: a name resolves under `flows/`, while an explicit path can point anywhere. Headless runs require an explicit workflow unless `FLOW_WORKFLOW` is set; Flow does not assume a repository-specific default. Workflow flags come from declared `inputs`: use `--name value` for strings and `--name` for booleans.

## Build your own

Put reusable workflows in `flows/`. Prompts can sit alongside their flow under `flows/prompts/<workflow-name>/`.

- Use `agent` steps for inspection, planning, implementation, or other judgment.
- Use `exec` steps for direct commands and `shell` only when shell syntax is necessary.
- Connect steps with declared `inputs` and `outputs`.
- Use `when` for conditional work, `loop` for bounded retries, and `parallel: true` for independent read-only steps.
- Validate before running: `flow validate flows/my-flow.flow`.

For one-off work, create a Git-ignored flow in `.flow/tmp/` and address it by path. If it proves useful, move it to `flows/` to make it reusable:

```bash
flow validate .flow/tmp/release-check.flow
flow run .flow/tmp/release-check.flow
mv .flow/tmp/release-check.flow flows/release-check.flow
```

## Development

```bash
npm test
npm run build
npm run dev -- --help
```

## License

MIT

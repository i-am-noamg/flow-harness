# Workflow YAML reference

`flow` currently validates workflows in code; this is a concise authoring reference, not a machine-readable JSON Schema.

## Top level

```yaml
name: workflow-name
# description: What the workflow does

inputs:
  input_name:
    type: string # or boolean
    description: What the caller supplies
    default: value # optional; booleans default to false, strings to ""

outputs:
  public_name: step_id.artifact_or_field

steps:
  - id: step_id
    type: agent # agent, exec, shell, or loop
```

## Agent step

```yaml
- id: inspect
  type: agent
  model: cheap # required profile or provider/model
  thinkingLevel: medium # required: off, minimal, low, medium, high, xhigh, or max
  prompt: prompts/inspect.md
  writes: false # true when the agent may edit files
  tools: [read, grep, find, ls] # optional; when supported
  inputs: [task, status.output]
  outputs: [summary]
  history: true # optional; expose prior executions as step_id.history
  outputFormat: text # text, single-line, or json
  when: task != "" # optional condition
```

Use `single-line` or `text`/multi-line output for one output variable. Use `json` when producing multiple named output variables. Every agent, shell, and exec step exposes its latest canonical `step_id.output`. This is available whether or not `outputs` is declared. `outputs` adds named values alongside it; it does not replace the canonical output. Agent output is the final response text, while process output is captured stdout/stderr. Thinking, tool calls, and usage remain execution metadata rather than part of `output`.

## Process steps

```yaml
- id: tests
  type: exec
  program: npm
  args: [test]
  cwd: . # optional, relative to the flow working directory
  timeout: 600000 # optional, milliseconds
  console: on-failure # terminal streaming: always, on-failure, or never
  outputFormat: text # text, single-line, or lines
```

Use `exec` for a program and argument list. Use `shell` only for pipes, redirects, chaining, globbing, or other shell syntax:

```yaml
- id: search
  type: shell
  command: rg "TODO" src | sort
  shell: bash # optional
```

## Loops and parallelism

```yaml
- id: repair_loop
  type: loop
  maxIterations: 5
  until: tests.exit_code == 0
  steps:
    - id: tests
      type: exec
      program: npm
      args: [test]
    - id: repair
      type: agent
      model: cheap
      thinkingLevel: medium
      prompt: prompts/repair.md
      writes: true
      when: tests.exit_code != 0
```

Consecutive `parallel: true` steps form a read-only batch. They must be independent, cannot be shell steps or loops, and writing agents cannot run in parallel. The next unmarked step is a barrier.

## Conditions

Conditions support comparisons using `==` and `!=`, combined with `&&` and `||`, for example:

```yaml
when: tests.exit_code != 0
until: lint.exit_code == 0 && tests.exit_code == 0
```

Conditions refer to inputs or step artifacts. Validate the completed flow with the installed `flow` command.

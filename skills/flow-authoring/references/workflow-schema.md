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
  tools: [read, grep, find, ls] # optional allowlist: read, bash, edit, write, grep, find, ls
  skills: [flow-authoring] # optional local named skills
  context: evidence # optional retained session name
  # forkContext: evidence # optional isolated copy of an earlier retained context
  inputs: [task, status.output]
  outputs: [summary]
  history: true # optional; expose prior executions as step_id.history
  outputFormat: text # text, single-line, or json
  when: task != "" # optional condition
```

When `tools` is omitted, `writes: false` defaults to `[read, grep, find, ls]`; `writes: true` defaults to `[read, bash, edit, write, grep, find, ls]`. An explicit list, including `tools: []`, is used unchanged. Grant the smallest allowlist needed. `writes` remains the safety declaration for workspace snapshots and parallel-write restrictions; set it accurately whenever the allowlist could mutate the workspace—it is not inferred from `tools`. Variants may override their step's `tools` list.

`skills` must be an array of unique, non-empty names. Flow resolves each name through Pi's loader in the run working directory's `skills/` directory, then injects the same frontmatter-stripped `<skill>` block Pi uses after an explicit skill load, in declaration order before execution. This is a Flow-required preload, not Pi's ordinary on-demand skill selection (which advertises descriptions and lets the model decide whether to load a body). An absent or unreadable skill fails the step before the agent starts. Persisted agent evidence records ordered `loaded_skills` metadata with each skill's name, resolved path, and content character count; skill bodies are not artifacts or public outputs. Variants may override their step's `skills` declaration.

Use `single-line` or `text`/multi-line output for one output variable. Use `json` when producing multiple named output variables. Every agent, shell, and exec step exposes its latest canonical `step_id.output`. This is available whether or not `outputs` is declared. `outputs` adds named values alongside it; it does not replace the canonical output. Agent output is the final response text, while process output is captured stdout/stderr. Thinking, tool calls, and usage remain execution metadata rather than part of `output`.

An agent's prompt interpolation and appended artifact sections are restricted to its declared `inputs`. A nested declaration such as `status.output` exposes only that path, not sibling fields under `status`; unavailable declared paths are omitted.

Use `context` to retain a compatible agent session for later sequential agents. It carries the full public conversation and tool transcript, and can reuse provider prompt caches. Use `forkContext` to give an agent an isolated in-memory copy of an earlier retained context's public messages; it cannot be combined with `context`. The source must be declared earlier and cannot be in the same parallel batch. Source and fork must use the same model, `writes` setting, `thinkingLevel`, and effective tool allowlist. Forks are independently disposed after their run, so they are appropriate for read-only parallel fan-out.

`history: true` is different: it is available only on a loop-body step and exposes that step's prior execution results as the explicit `step_id.history` artifact. It works for agent and process steps and can cross model, tool, and write-permission boundaries, but contains selected step outputs rather than a full agent transcript and adds prompt input when declared. Use it when a later step must start fresh or is incompatible with a retained session. Do not combine it with `context` for the same compatible repeated agent unless the duplicate explicit artifact is deliberately needed.

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

Consecutive steps with the same unique, non-empty named group (for example, `parallel: evidence`) form a read-only batch. A group name cannot be reused within the same step list. They must be independent, cannot be shell steps or loops, and writing agents cannot run in parallel. An unmarked step or a different group is a barrier.

## Outputs

Expose results the caller needs, not direct input values: the caller that ran the flow already knows what it supplied. Each output declaration is a string using this grammar:

```text
output = value | condition | "if(" condition "," value "," value ")"
value = path | literal
path = identifier ("." identifier)*
literal = true | false | number | quoted string
condition = comparison | "(" condition ")" | condition "&&" condition | condition "||" condition
comparison = path ("==" | "!=") (literal | identifier)
```

`&&`, `||`, and parentheses have ordinary boolean-expression semantics. Use `if` to select a value; only the selected branch is resolved, and values are returned exactly, including `false`, `0`, and `""`:

```yaml
outputs:
  commit_message: if(msg != "", msg, generated_commit_message)
  pushed: push.status == succeeded || force_push.status == succeeded
```

There is no fallback/coalesce syntax and no `condition(...)` wrapper. An unavailable direct path, selected `if` branch, or condition path causes runtime resolution to mark the run `failed`. Syntax errors fail during loading. The persisted run includes `output_error` with the output name, expression, unresolved path when available, and error message.

## Conditions

Conditions support comparisons using `==` and `!=`, combined with `&&` and `||`, for example:

```yaml
when: tests.exit_code != 0
until: lint.exit_code == 0 && tests.exit_code == 0
```

Conditions refer to inputs or step artifacts. Validate the completed flow with the installed `flow` command.

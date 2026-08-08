# flow

A small, declarative workflow harness for coding agents, powered by the Pi SDK.

## Quick start

```bash
npm install
npm run dev -- --task "add input validation to the API"
```

Configure model profiles with provider/model IDs:

```bash
export FLOW_MODEL_CHEAP=anthropic/claude-haiku-4-5
export FLOW_MODEL_CAPABLE=anthropic/claude-sonnet-4-5
export FLOW_MODEL_STRONGEST=anthropic/claude-opus-4-5
```

Or run a workflow directly:

```bash
npm run dev -- run flows/code-change.flow --task "fix the failing tests"
# Skip inspection and planning when the implementation approach is already known
npm run dev -- run flows/code-change.flow --task "fix the failing tests" --simple
```

Inspect a workflow before running it:

```bash
npm run dev -- help code-change
# Paths also work: npm run dev -- help flows/git-commit.flow
```

Workflow options come from the workflow's `inputs` definition: use `--<input> <value>` for string inputs and `--<input>` for boolean inputs. Inputs can include a `description` and `default` to document their usage.

`--simple` skips the `inspect` and `plan` steps, but still runs implementation, tests, and conditional repair.

Runs are persisted under `.flow/runs/`. Process steps always produce `output`, `stdout`, `stderr`, `exit_code`, `succeeded`, and `duration`; workflow inputs control what is handed to agents.

## Process steps

Use `exec` for a direct executable invocation (no shell parsing):

```yaml
- id: tests
  type: exec
  program: npm
  args: [test]
```

Use `shell` for pipes, redirects, chaining, globbing, or other shell syntax:

```yaml
- id: search
  type: shell
  command: rg "TODO" src | sort
```

A shell can be selected explicitly with `shell: bash` or `shell: sh`.

## Loops

Use a structured `loop` to retry a sequence until a condition is true:

```yaml
- id: test_and_repair
  type: loop
  maxIterations: 5
  until: test.succeeded == true
  steps:
    - id: test
      type: exec
      program: npm
      args: [test]
    - id: repair
      type: agent
      prompt: prompts/repair.md
      when: test.exit_code != 0
      writes: true
```

The body runs sequentially and `until` is evaluated after each complete iteration. `maxIterations` defaults to 10 and must be a positive integer; exhausting it fails the loop and run. Loops may be nested, and declared step IDs must be unique across the workflow. Conditions and artifacts use logical child IDs (the latest iteration overwrites them), while persisted records use qualified IDs such as `test_and_repair[2].test`. Command failures can be recovered by later loop steps; agent failures and `stopWhen` failures terminate the run.

## Git commits

The included `git-commit` flow commits the current changes. If `--msg` is omitted, it gives Git status and staged/unstaged diffs to the cheap agent, which returns a structured commit message (including optional multiline text):

```bash
npm run dev -- run flows/git-commit.flow --msg "fix auth bug"
npm run dev -- run flows/git-commit.flow --push
npm run dev -- run flows/git-commit.flow --new-branch --branch feature/auth --push
npm run dev -- run flows/git-commit.flow --new-branch --push
npm run dev -- run flows/git-commit.flow --add-all --push --force-with-lease
```

Pushing and force-with-lease are opt-in. `--add-all` is opt-in (default false) and stages all unstaged files. Without it, the flow stops before branching or committing when there are no staged changes. Generated commit messages may be multiline. Use `--branch <name>` with `--new-branch` to choose a branch name; when `--branch` is omitted, the cheap commit-message agent generates one. Branches are created with `git checkout -b`.

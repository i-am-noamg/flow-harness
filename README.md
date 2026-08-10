# flow

A small, declarative workflow harness for coding agents, powered by the Pi SDK.

## Quick start

```bash
npm install
npm run dev -- --task "add input validation to the API"
# The default code-change flow defines `task` as an input; other flows expose their own inputs.
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

There is no global task argument. Workflow options come from the workflow's `inputs` definition: use `--<input> <value>` for string inputs and `--<input>` for boolean inputs. For example, `code-change.flow` defines `task`, while `git-commit.flow` defines `msg`, `push`, and other inputs. Inputs can include a `description` and `default` to document their usage.

`--simple` skips the `inspect` and `plan` steps, but still runs implementation, tests, and conditional repair.

Runs are persisted as one complete JSON record under `.flow/runs/<run-id>.json`. Process steps preserve `output`, `stdout`, `stderr`, `exit_code`, `signal`, `timed_out`, and `duration`; workflow inputs control what is handed to agents. A `stopWhen` guard reports workflow `status: succeeded` and uses `control: stop` or `control: continue`; its underlying exit code remains available, but a nonzero guard exit is not itself a flow failure. Workflows can declare public `outputs` mapped from step artifacts; these are returned to Pi without exposing routine raw logs.

## Pi integration

The built extension turns flows into tools inside a persistent Pi session:

```bash
npm run build
pi -e ./dist/pi-extension.js
```

The Pi agent can use `list_flows`, `run_flow`, `inspect_flow_run`, and `validate_flow`. Flow results contain statuses, declared outputs, failures, and changed files; routine raw logs remain in the run record and can be selected with `inspect_flow_run` using `step_id` and `fields`. The existing `flow` CLI remains available for headless runs. Shared run inspection is also available with `flow list` and `flow inspect <run-id> [--step <id>].

## Flow outputs

A workflow may declare its public outputs by mapping names to step artifacts. The compact Pi result includes statuses, failures, changed files, and these named workflow values; complete step evidence remains in the single run JSON file.

```yaml
outputs:
  commit_hash: commit_details.commit_hash
  pushed: push.status == succeeded || force_push.status == succeeded

steps:
  - id: commit_details
    type: exec
    program: git
    args: [rev-parse, HEAD]
    outputFormat: single-line
    outputs: [commit_hash]
```

Process steps support `text`, `single-line`, and `lines` output formats. With `lines` and two declared outputs, the first line is assigned to the first output and the remaining lines to the second. Use `inspect_flow_run` with `step_id` and `fields` to retrieve raw evidence when needed.

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

A shell can be selected explicitly with `shell: bash` or `shell: sh`. Set `output` on a shell or exec step to control CLI output: `always` (default) streams output, `failure` buffers it and prints only when the command fails, and `never` suppresses it. Output is always retained in the run JSON.

## Loops

Use a structured `loop` to retry a sequence until a condition is true:

```yaml
- id: test_and_repair
  type: loop
  maxIterations: 5
  until: test.exit_code == 0
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

The body runs sequentially and `until` is evaluated after each complete iteration. `maxIterations` defaults to 10 and must be a positive integer; exhausting it fails the loop and run. Loops may be nested, and declared step IDs must be unique across the workflow. Conditions and artifacts use logical child IDs (the latest iteration overwrites them), while persisted records use qualified IDs such as `test_and_repair[2].test`. Command failures can be recovered by later loop steps; agent failures fail the run, while a triggered `stopWhen` ends it successfully with `control: stop`.

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

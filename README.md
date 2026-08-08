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

Workflow options come from the workflow's `inputs` definition: use `--<input> <value>` for string inputs and `--<input>` for boolean inputs. All workflow inputs must be supplied through their named flags.

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

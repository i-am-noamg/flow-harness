# flow

A small, declarative workflow harness for coding agents, powered by the Pi SDK.

## Quick start

```bash
npm install
npm run dev -- "add input validation to the API"
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
```

Runs are persisted under `.flow/runs/`. Commands always produce `output`, `stdout`, `stderr`, `exit_code`, `succeeded`, and `duration`; workflow inputs control what is handed to agents.

## Git commits

The included `git-commit` flow commits the current changes. If `--msg` is omitted, it gives Git status and staged/unstaged diffs to the cheap agent, which returns a structured commit message (including optional multiline text):

```bash
npm run dev -- run flows/git-commit.flow --msg "fix auth bug"
npm run dev -- run flows/git-commit.flow --push
npm run dev -- run flows/git-commit.flow --new-branch feature/auth --push
npm run dev -- run flows/git-commit.flow --new-branch --push
npm run dev -- run flows/git-commit.flow --add-all --push --force-with-lease
```

Pushing and force-with-lease are both opt-in; force-with-lease requires `--push`. `--add-all` is opt-in (default false) and stages all unstaged files. Without it, the flow stops before branching or committing when there are no staged changes. Generated commit messages may be multiline. `--new-branch` accepts an optional name; when omitted, the cheap commit-message agent generates the branch name. Branches are created with `git checkout -b`.

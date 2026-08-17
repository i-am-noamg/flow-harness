# flow

Sprinkle some determinism on your agent for faster, more reliable results using fewer tokens.

A declarative workflow harness for coding agents, powered by the Pi SDK.

## Install

Install the published package globally:

```bash
npm install --global flow-harness
flow --help
```

For source development or before the first registry release:

```bash
git clone https://github.com/i-am-noamg/flow-harness.git flow
cd flow
npm install
npm run build
npm link                         # optional: makes `flow` available globally
```

Without `npm link`, run the local CLI with `npm run dev -- ...`. After linking, use `flow ...` from any repository. The `prepack` script rebuilds `dist/` automatically when creating the npm package.

The package includes the Pi SDK and its `pi` executable. Configure Pi authentication/provider credentials as required by Pi. Model profiles are selected with provider/model IDs:

```bash
export FLOW_MODEL_CHEAP=anthropic/claude-haiku-4-5
export FLOW_MODEL_CAPABLE=anthropic/claude-sonnet-4-5
export FLOW_MODEL_STRONGEST=anthropic/claude-opus-4-5
```

## Use the CLI

`flow` without a workflow subcommand launches Pi with the Flow extension loaded. `flow run` is the headless workflow runner:

```bash
# Run the default flows/code-change.flow
flow --task "add input validation to the API"

# Run a named or explicit workflow
flow run code-change --task "fix the failing tests"
flow run flows/git-commit.flow --msg "fix auth bug"

# Local development equivalent
npm run dev -- run flows/code-change.flow --task "fix the failing tests"
```

The default workflow is `flows/code-change.flow`. Override it with `FLOW_WORKFLOW`:

```bash
FLOW_WORKFLOW=flows/git-commit.flow flow --msg "prepare release"
```

Workflow options come from the workflow's declared `inputs`: string inputs use `--<input> <value>` and boolean inputs use `--<input>`. There is no global `--task` argument; `task` is simply an input of the default `code-change` workflow. `--simple` is specific to `code-change`: it skips inspection and planning while retaining implementation, testing, and conditional repair. Use `flow help <name-or-path>` to see a workflow's inputs, defaults, and descriptions.

Useful CLI commands:

```bash
flow --help
flow list
flow help code-change
flow validate flows/code-change.flow
flow inspect <run-id>
flow inspect <run-id> --step test
```

`flow list` shows workflows in `flows/` and explicitly addressed temporary workflows in `.flow/tmp/`. Names resolve under `flows/`; temporary workflows require their path. `flow validate` checks a workflow without running it. `flow inspect` reads the saved run record and can focus on one qualified or logical step ID.

Runs are persisted as complete JSON records under `.flow/runs/<run-id>.json`. Process steps preserve `output`, `stdout`, `stderr`, `exit_code`, `signal`, `timed_out`, and `duration`; routine CLI responses are bounded summaries. Workflow inputs control what is handed to agents, and declared workflow `outputs` are returned in the summary.

## Pi integration

The package includes the extension and skills needed to use Flow as a Pi harness:

```bash
npm run build
flow                 # launch Pi with this package loaded
flow --model ...     # pass options to Pi
flow run ...         # use the headless workflow CLI
```

`flow` launches Pi with the installed Flow package explicitly loaded, so it works from any repository. Pi keeps the current directory as the working repository: its local `flows/`, `.flow/`, and source files are not taken from the Flow package. `PI_BIN` can override the Pi executable when needed.

For local development, the equivalent is:

```bash
pi -e .
```

The Pi agent can use `list_flows`, `run_flow`, `inspect_flow_run`, and `validate_flow`. Flow results contain statuses, declared outputs, failures, and changed files; routine raw logs remain in the run record and can be selected with `inspect_flow_run` using `step_id` and `fields`. With the unified command, `flow` launches Pi unless its first argument is a CLI command (`run`, `validate`, `list`, `inspect`, or `help`). Shared run inspection is available with `flow list` and `flow inspect <run-id> [--step <id>].

## Temporary flows

Temporary flows are Git-ignored and live under `.flow/tmp/`. Create and use one explicitly:

```bash
mkdir -p .flow/tmp
# create .flow/tmp/<name>.flow
flow validate .flow/tmp/<name>.flow
flow run .flow/tmp/<name>.flow
```

Bare names resolve only under `flows/`, so temporary flows cannot be selected by name alone. Promote a useful one with `mv` or `cp` to `flows/<name>.flow`, then check any flow-local prompt references.

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

Every agent, shell, and exec step exposes its latest canonical `step_id.output`, regardless of whether `outputs` is declared. `outputs` adds named values alongside it. Agent output is the final response text; process output is captured stdout/stderr. Thinking, tool calls, and usage remain execution metadata. Process steps support `text`, `single-line`, and `lines` output formats. With `lines` and two declared outputs, the first line is assigned to the first output and the remaining lines to the second. Use `inspect_flow_run` with `step_id` and `fields` to retrieve raw evidence when needed.

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

A shell can be selected explicitly with `shell: bash` or `shell: sh`. Set `console` on a shell or exec step to control terminal streaming: `always` (default) streams output, `on-failure` buffers it and prints only when the command fails, and `never` suppresses it. Captured output is always retained in the run JSON.

Consecutive read-only steps can run concurrently with `parallel: true`. A group starts at a marked step and includes consecutive marked steps; unmarked steps are barriers. The group completes before the next unmarked step runs. Parallel shell steps, loops, `stopWhen` steps, writing agents, sibling artifact dependencies, and duplicate output names are rejected during validation. Parallel workers use isolated artifact snapshots and their persisted results are merged in declared order.

## Agent context and usage

Agent steps record provider-reported token usage in run evidence, including input, output, cache-read, cache-write, total tokens, cache-hit rate, and cost when available. They also record the resolved provider/model, API, response IDs, raw stop reasons, error messages, thinking level, exact rendered prompt length, session context ID, turns, tool names/results/failures, retries, per-turn usage, and stop reasons. Run records aggregate usage, provider/API/model/context sets, tool metrics, agent metrics, and wall/step durations. Providers that support prompt caching report cache activity; unsupported or unreported fields remain zero.

Sequential agent steps can share a Pi session with `context`. The first step creates the session and later steps continue it, allowing the provider to reuse its cached prefix and preserving the conversation context:

```yaml
- id: inspect
  type: agent
  context: analysis
  prompt: inspect.md
- id: summarize
  type: agent
  context: analysis
  prompt: plan.md
```

Context groups must not be used by parallel agents. Sharing reuses one Pi agent session (rather than manually copying artifacts between independent sessions), so later prompts include the earlier conversation and providers can reuse their cached prefix. It is also a semantic choice: use it only when seeing earlier prompts and responses is useful.

Agent steps may also define ordered `variants`, each with its own `when`, prompt, inputs, outputs, and optional model/context/thinking-level settings. The first matching variant runs and is recorded in the step evidence; if none match, the step is skipped. This keeps mutually exclusive agent behavior in one logical step.

Use `thinkingLevel` to request Pi's `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` level:

```yaml
- id: implementation
  type: agent
  model: strongest
  thinkingLevel: high
  prompt: prompts/implementation.md
```

Pi clamps the requested level to the selected model's capabilities; the effective level is recorded as `thinking_level` in the step evidence. Variants can override the step level. For shared contexts, the level is applied before each prompt.

Prompt paths may be absolute or relative. A bare filename defaults to `flows/prompts/<workflow-name>/<filename>`; relative paths also resolve from `flows/` and `flows/prompts/` for compatibility.

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
      prompt: repair.md
      when: test.exit_code != 0
      writes: true
```

The body runs sequentially and `until` is evaluated after each complete iteration. `maxIterations` defaults to 10 and must be a positive integer; exhausting it fails the loop and run. Loops may be nested, and declared step IDs must be unique across the workflow. Conditions and artifacts use logical child IDs (the latest iteration overwrites them), while persisted records use qualified IDs such as `test_and_repair[2].test`. Set `history: true` on a loop-body step to retain its logical outputs in `step_id.history`; `step_id.output` and declared output aliases still refer to only the latest execution. History entries are output values, or objects keyed by the step's declared outputs. Command failures can be recovered by later loop steps; agent failures fail the run, while a triggered `stopWhen` ends it successfully with `control: stop`.

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

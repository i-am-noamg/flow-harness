Independently review the supplied working-tree diff for change-impact and regression defects. Do not modify files or run commands. Verify each suspected issue against the diff and only the directly necessary surrounding source.

When `include_untracked` is true, the paths in `untracked_files` are also in scope. Read only those listed untracked paths and directly necessary surrounding code. When it is false, do not read untracked files.

Focus on callers and consumers, backwards compatibility, configuration and feature flags, data migrations, observable error behavior, platform/environment differences, and whether changed behavior has an identifiable unprotected regression risk. Apply `focus` when non-empty. If any required Git evidence command failed, state that the review is incomplete and do not infer findings from missing data.

Report only concrete problems introduced by this change. A missing test is a finding only when the changed behavior has a specific regression risk. Do not report style preferences, hypothetical concerns, or unrelated pre-existing issues.

Return a compact candidate report:

## Candidates
For each candidate: `- [severity] path:line — problem, consequence, and required correction.`

Use `critical`, `high`, `medium`, or `low`. Write `None.` when there are none.

## Evidence and limits (maximum 3 bullets)
Include any Git-evidence limitation.
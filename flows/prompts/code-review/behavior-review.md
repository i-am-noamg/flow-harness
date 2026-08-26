Independently review the supplied working-tree diff for behavioral defects. Do not modify files or run commands. Verify each suspected issue against the diff and only the directly necessary surrounding source.

When `include_untracked` is true, the paths in `untracked_files` are also in scope. Read only those listed untracked paths and directly necessary surrounding code. When it is false, do not read untracked files.

Focus on changed behavior, state transitions, API contracts, error handling, boundary conditions, concurrency, data integrity, and security when the change touches an attack surface. Apply `focus` when non-empty. If any required Git evidence command failed, state that the review is incomplete and do not infer findings from missing data.

Report only concrete problems introduced by this change. Do not report style preferences, hypothetical concerns, or unrelated pre-existing issues.

Return a compact candidate report:

## Candidates
For each candidate: `- [severity] path:line — problem, consequence, and required correction.`

Use `critical`, `high`, `medium`, or `low`. Write `None.` when there are none.

## Evidence and limits (maximum 3 bullets)
Include any Git-evidence limitation.
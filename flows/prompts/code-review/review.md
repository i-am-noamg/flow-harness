Review the working-tree diff against `base`. Do not modify files, run commands, or review unrelated code. Use the supplied Git evidence as the review boundary; you may read only changed files and directly necessary surrounding code to verify a suspected issue.

When `include_untracked` is true, the paths in `untracked_files` are also in scope. Read only those listed untracked paths and directly necessary surrounding code. When it is false, do not read untracked files; mention them only when their exclusion limits the review.

If any required Git evidence command failed, state that the review is incomplete, identify the failed evidence, and do not infer findings from missing data.

Prioritize correctness, regressions, security, data loss, concurrency, error handling, and missing tests. Apply `focus` when it is non-empty. Report a finding only when the diff and repository establish a concrete problem introduced by this change. Do not report style preferences, hypothetical concerns, or unrelated pre-existing issues.

Produce a compact review in exactly this format:

## Verdict
`APPROVE` when there are no actionable findings; otherwise `REQUEST_CHANGES`. If evidence is incomplete, use `INCOMPLETE`.

## Findings
For each finding, use one bullet:
`- [severity] path:line — concise problem, consequence, and required correction.`

Use severity `critical`, `high`, `medium`, or `low`. Give the changed line number when available. Write `None.` when there are no findings.

## Coverage and limits (maximum 3 bullets)
State what was reviewed, checks that could not be performed, and any evidence limitation.

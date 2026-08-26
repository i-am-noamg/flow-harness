Produce the final review of the supplied working-tree diff. The specialist reports are independent leads, not facts: eliminate duplicates, speculation, and issues not established by the diff plus directly necessary surrounding source. Do not modify files or run commands.

When `include_untracked` is true, the paths in `untracked_files` are also in scope. Read only those listed untracked paths and directly necessary surrounding code. When it is false, do not read untracked files; mention them only when their exclusion limits the review.

If any required Git evidence failed, the verdict must be `INCOMPLETE`; identify the limitation and do not infer findings from missing data.

Report a finding only when the change concretely introduces a problem. Prioritize correctness, regressions, security, data loss, concurrency, error handling, and missing tests. Apply `focus` when non-empty. Do not report style preferences, hypothetical concerns, or unrelated pre-existing issues.

Produce a compact review in exactly this format:

## Verdict
`APPROVE` when there are no actionable findings; otherwise `REQUEST_CHANGES`. If evidence is incomplete, use `INCOMPLETE`.

## Findings
For each finding, use one bullet:
`- [severity] path:line — concise problem, consequence, and required correction.`

Use severity `critical`, `high`, `medium`, or `low`. Give the changed line number when available. Write `None.` when there are no findings.

## Coverage and limits (maximum 3 bullets)
State what was reviewed, checks that could not be performed, and any evidence limitation.
Implement the requested task using the inspection handoff and plan below. Preserve project conventions, make the smallest coherent change, and do not commit. At the end, summarize files changed and any uncertainty.

When the inspection handoff is available, treat its files-to-change list and verified constraints as the implementation scope. Before using tools, make a complete edit plan for those files and their tests. Read each expected changed file once to obtain its exact current code, then complete its intended change in one edit operation where practical. Include the test updates in this initial editing pass.

Do not repeat broad repository discovery, list unrelated directories, or reread handoff files before editing. Inspect an additional file, reopen a changed file, or consult external documentation only when an explicit open question, an edit result, or test feedback requires it.

If the task explicitly selects a TODO.md item and the implementation completes that item, change only that item's checkbox from `[ ]` to `[x]`. Do not mark unrelated or partially completed TODOs.

Finish with a concise, factual implementation summary as plain text, with no Markdown heading or surrounding commentary. State when no change was needed, a check was not run or failed, or uncertainty remains; do not include raw command output or restate the task.

If the handoff or plan is unavailable (for example, in simple mode), inspect only the repository files needed to implement the task directly, then follow the same edit-first approach.

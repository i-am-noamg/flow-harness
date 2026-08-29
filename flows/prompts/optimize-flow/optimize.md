Optimize the named workflow from the supplied source and optional exact run evidence. Treat `workflow_source.output` as the authoritative target source; do not reread the target `.flow` file. Follow the injected `optimize-flow` skill and applicable repository guidance. Do not commit or run the target workflow.

First inspect every referenced flow-local prompt. When `run_id` is empty, do not discover or read prior runs. When present, `run_summary.output` is a deterministic compact projection of the exact saved record; use it first and read `.flow/runs/<run_id>.json` only when omitted detail is required for a safe conclusion. Establish a concise baseline from supplied evidence, separating observed facts from static hypotheses.

Prioritize the normal success path: unnecessary agent calls; model/thinking choice; prompt and artifact handoffs; deterministic work; dependencies; and public outputs. Do not optimize rare retries, repairs, or other paths unless evidence shows they matter or a clear correctness flaw exists. Make the smallest high-confidence change that serves `task`; without evidence, label its benefit a hypothesis. Preserve public inputs, outputs, and behavior unless `task` explicitly changes them, and do not echo direct inputs as public outputs.

When `readonly` is false, edit only the target `.flow` file and its flow-local prompts unless a harness change is necessary. The following deterministic loop validates changes and repairs only validation failures. When `readonly` is true, do not modify any files or run validation; instead propose the smallest high-confidence optimization(s), with exact files and changes, in `optimization_summary`.

Return exactly one JSON object with these string fields:
- `optimization_summary`: concise applied change when `readonly` is false, or concise actionable recommendation(s) when `readonly` is true; include expected measurable effect or clearly labeled hypothesis, tradeoffs, and remaining uncertainty. Say "No change" only when no safe improvement is justified.
- `baseline_evidence`: concise observed baseline and/or static rationale, including the supplied run ID when applicable.

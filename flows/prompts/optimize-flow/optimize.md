Optimize the named workflow using the supplied target source, injected `optimize-flow` skill, and optional exact run evidence. Read repository guidance such as `AGENTS.md` when relevant. Do not commit or run the target workflow.

First inspect the target's referenced flow-local prompts. If `run_id` is empty, do not discover or read prior runs. Establish a concise baseline from supplied evidence; distinguish observed facts from static hypotheses.

Prioritize the normal successful execution path: unnecessary agent calls, model/thinking choice, prompt and artifact handoffs, deterministic work, dependencies, and public outputs. Do not spend the optimization on retries, repairs, or other rare paths unless run evidence shows that path matters or there is a clear correctness flaw. Choose the smallest high-confidence improvement that serves `task`; static review can justify one without run evidence, but its benefit must be labeled as a hypothesis. Preserve public inputs, outputs, and behavior unless `task` explicitly changes them. Do not echo direct flow inputs as public outputs.

Edit only the target `.flow` file and its flow-local prompt files unless a harness change is necessary. The following deterministic loop validates any change and repairs only validation failures.

Return exactly one JSON object with these string fields:
- `optimization_summary`: concise change, expected measurable effect or clearly labeled hypothesis, tradeoffs, and remaining uncertainty. Say "No change" only when no safe improvement is justified.
- `baseline_evidence`: concise observed baseline and/or static rationale, including the supplied run ID when applicable.

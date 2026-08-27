export type StepType = "agent" | "shell" | "exec" | "loop";
export type ModelProfile = string;
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface WorkflowInput { type: "string" | "boolean"; description?: string; default?: string | boolean; }
export type WorkflowInputs = Record<string, string | WorkflowInput>;

export interface Workflow {
  name: string;
  description?: string;
  inputs?: WorkflowInputs;
  outputs?: Record<string, string>;
  steps: Step[];
}

export type ParallelGroup = string;
export interface StepBase { id: string; type: StepType; when?: string; inputs?: string[]; outputs?: string[]; stopWhen?: string; stopMessage?: string; parallel?: ParallelGroup; history?: boolean; }
export type StepOutputFormat = "text" | "single-line" | "lines" | "json";
export interface AgentVariant {
  id: string;
  when: string;
  prompt: string;
  model: ModelProfile;
  thinkingLevel: ThinkingLevel;
  writes?: boolean;
  tools?: string[];
  outputFormat?: StepOutputFormat;
  inputs?: string[];
  outputs?: string[];
  context?: string;
  forkContext?: string;
}
export interface AgentStep extends StepBase { type: "agent"; model: ModelProfile; thinkingLevel: ThinkingLevel; prompt?: string; writes?: boolean; tools?: string[]; outputFormat?: StepOutputFormat; context?: string; forkContext?: string; variants?: AgentVariant[]; }
export type CommandConsole = "always" | "on-failure" | "never";
export interface ShellStep extends StepBase { type: "shell"; command: string; shell?: string; cwd?: string; timeout?: number; console?: CommandConsole; outputFormat?: Exclude<StepOutputFormat, "json">; }
export interface ExecStep extends StepBase { type: "exec"; program: string; args?: string[]; cwd?: string; timeout?: number; console?: CommandConsole; outputFormat?: Exclude<StepOutputFormat, "json">; }
export interface LoopStep extends StepBase { type: "loop"; steps: Step[]; until: string; maxIterations?: number; }
export type Step = AgentStep | ShellStep | ExecStep | LoopStep;

export interface CommandResult {
  output: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  signal?: string;
  timed_out: boolean;
  duration: number;
  execution_error?: string;
}
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cache_hit_rate?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
export interface AgentContextUsage {
  availability: "available" | "unavailable";
  reason?: string;
  tokens?: number;
  context_window?: number;
  percent?: number;
}
export interface AgentToolResultEvidence {
  content: unknown;
  details?: unknown;
  is_error: boolean;
  source_order: number;
  timestamp?: number;
}
export interface AgentToolEventEvidence {
  call_id: string;
  name: string;
  arguments: unknown;
  source_order: number;
  timestamp?: number;
  result?: AgentToolResultEvidence;
}
/** Transcript-derived Pi tool evidence; hidden model reasoning is not exposed. */
export type AgentToolEvidence =
  | { availability: "available"; events: AgentToolEventEvidence[] }
  | { availability: "unavailable"; reason: string };
export interface AgentTurnMetrics {
  api?: string;
  provider?: string;
  model?: string;
  response_model?: string;
  response_id?: string;
  stop_reason?: string;
  raw_stop_reason?: string;
  error_message?: string;
  usage?: AgentUsage;
  tool_names: string[];
}
export interface AgentResult {
  output: string;
  model?: string;
  duration: number;
  usage?: AgentUsage;
  provider?: string;
  api?: string;
  response_model?: string;
  raw_stop_reason?: string;
  error_message?: string;
  thinking_level: string;
  prompt_chars: number;
  output_chars: number;
  prompt_path: string;
  input_chars: Record<string, number>;
  context_id?: string;
  /** Pi-reported post-prompt session snapshot; not a cumulative run total. */
  context_usage: AgentContextUsage;
  turns: number;
  tool_calls: number;
  retries: number;
  stop_reasons: string[];
  tool_names: string[];
  effective_tools: string[];
  tool_results: number;
  tool_failures: number;
  tool_evidence: AgentToolEvidence;
  turn_metrics: AgentTurnMetrics[];
  changed?: boolean;
  changed_files?: string[];
}
export interface LoopIteration {
  iteration: number;
  started_at: string;
  finished_at: string;
  status: "succeeded" | "failed";
  until: boolean;
}
export interface LoopResult {
  iterations: LoopIteration[];
  until: string;
  maxIterations: number;
  exhausted: boolean;
}
export type ProcessOutput = { stream: "stdout" | "stderr"; data: string };

export interface WorkspaceSnapshot {
  fingerprint: string;
  files: Record<string, string>;
}
export interface FlowProgressStartEvent {
  type: "flow_started";
  run_id: string;
  flow: string;
  total_steps: number;
}
export interface FlowStepProgressEvent {
  type: "step_started" | "step_finished";
  run_id: string;
  flow: string;
  id: string;
  declared_id: string;
  status: StepResult["status"];
  duration_ms: number;
  loop_id?: string;
  loop_iteration?: number;
}
/** Transient, payload-safe agent snapshot; usage is cumulative for this invocation, not a context snapshot. */
export interface FlowAgentProgressEvent {
  type: "agent_progress";
  run_id: string;
  flow: string;
  id: string;
  declared_id: string;
  status: "running";
  duration_ms: number;
  usage?: AgentUsage;
  turns: number;
  tool_calls: number;
  retries: number;
  loop_id?: string;
  loop_iteration?: number;
}
/** Payload-safe lifecycle updates; detailed evidence remains in the saved run. */
export type FlowProgressEvent = FlowProgressStartEvent | FlowStepProgressEvent | FlowAgentProgressEvent;
export type FlowProgressCallback = (event: FlowProgressEvent) => void;

export interface StepResult {
  id: string;
  /** Declared workflow step ID; differs from id for loop children. */
  declared_id: string;
  loop_id?: string;
  type: StepType;
  status: "running" | "succeeded" | "failed" | "skipped";
  started_at: string;
  finished_at?: string;
  result?: CommandResult | AgentResult | LoopResult;
  error?: string;
  message?: string;
  variant?: string;
  control?: "continue" | "stop";
}
export interface RunMetrics {
  wall_duration_ms: number;
  step_duration_ms: number;
}
export interface RunContextUsage {
  availability: "available" | "unavailable";
  reason?: string;
  /** Sum of `tokens` from reported per-agent Pi snapshots; may overlap for shared sessions. */
  aggregation?: "sum_reported_snapshots";
  /** Number of per-agent snapshots included in `tokens`. */
  token_snapshot_count?: number;
  tokens?: number;
}
export interface RunAgentMetrics {
  agent_steps: number;
  total_agent_duration_ms: number;
  prompt_chars: number;
  declared_input_chars: number;
  output_chars: number;
  repair_iterations: number;
  requested_models: string[];
  turns: number;
  tool_calls: number;
  retries: number;
  providers: string[];
  apis: string[];
  response_models: string[];
  contexts: string[];
  /** Stable declared Pi tool allowlists from persisted agent evidence. */
  effective_tools: string[];
  /** Stable assistant toolCall names from persisted agent evidence. */
  actual_tools: string[];
  tool_names: string[];
  /** Sum of reported per-agent Pi context snapshots, not a Pi cumulative run value. */
  total_context_usage: RunContextUsage;
  tool_failures: number;
}
export interface OutputResolutionErrorEvidence {
  output: string;
  expression: string;
  path?: string;
  error: string;
}
export interface RunState {
  id: string;
  workflow: string;
  cwd: string;
  started_at: string;
  finished_at?: string;
  status: "running" | "succeeded" | "failed";
  steps: StepResult[];
  usage?: AgentUsage;
  metrics?: RunMetrics;
  agent_metrics?: RunAgentMetrics;
  outputs?: Record<string, unknown>;
  output_error?: OutputResolutionErrorEvidence;
}
export interface FlowInputSummary { name: string; type: WorkflowInput["type"]; default?: string | boolean; description?: string; }
export interface FlowCatalogEntry { name: string; path: string; temporary?: boolean; description?: string; inputs: FlowInputSummary[]; outputs: string[]; }
export interface RunSummary {
  run_id: string;
  flow: string;
  status: RunState["status"];
  steps: Array<{ id: string; type: StepType; status: StepResult["status"]; control?: StepResult["control"]; exit_code?: number; signal?: string; timed_out?: boolean; changed?: boolean; message?: string; error?: string }>;
  changed_files: string[];
  outputs: Record<string, unknown>;
  failures: Array<{ id: string; error?: string; exit_code?: number; signal?: string; timed_out?: boolean }>;
  /** Indicates summary fields were bounded; inspect the saved run for omitted evidence. */
  omitted?: { steps?: number; outputs?: number; changed_files?: number };
  run_file: string;
}

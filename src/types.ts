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

export interface StepBase { id: string; type: StepType; when?: string; inputs?: string[]; outputs?: string[]; stopWhen?: string; stopMessage?: string; parallel?: boolean; history?: boolean; }
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
}
export interface AgentStep extends StepBase { type: "agent"; model: ModelProfile; thinkingLevel: ThinkingLevel; prompt?: string; writes?: boolean; tools?: string[]; outputFormat?: StepOutputFormat; context?: string; variants?: AgentVariant[]; }
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
  prompt_path: string;
  input_chars: Record<string, number>;
  context_id?: string;
  turns: number;
  tool_calls: number;
  retries: number;
  stop_reasons: string[];
  tool_names: string[];
  effective_tools: string[];
  tool_results: number;
  tool_failures: number;
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
export interface StepResult {
  id: string;
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
export interface RunAgentMetrics {
  agent_steps: number;
  turns: number;
  tool_calls: number;
  retries: number;
  providers: string[];
  apis: string[];
  response_models: string[];
  contexts: string[];
  tool_names: string[];
  tool_failures: number;
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
  failures: Array<{ id: string; error?: string; exit_code?: number; signal?: string; timed_out?: boolean; stdout?: string; stderr?: string }>;
  run_file: string;
}

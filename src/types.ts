export type StepType = "agent" | "shell" | "exec" | "loop";
export type ModelProfile = string;

export interface WorkflowInput { type: "string" | "boolean"; description?: string; default?: string | boolean; }
export type WorkflowInputs = Record<string, string | WorkflowInput>;

export interface Workflow {
  name: string;
  description?: string;
  inputs?: WorkflowInputs;
  outputs?: Record<string, string>;
  steps: Step[];
}

export interface StepBase { id: string; type: StepType; when?: string; inputs?: string[]; outputs?: string[]; stopWhen?: string; stopMessage?: string; parallel?: boolean; }
export type StepOutputFormat = "text" | "single-line" | "lines" | "json";
export interface AgentStep extends StepBase { type: "agent"; model?: ModelProfile; prompt: string; writes?: boolean; outputFormat?: StepOutputFormat; }
export type CommandOutput = "always" | "failure" | "never";
export interface ShellStep extends StepBase { type: "shell"; command: string; shell?: string; cwd?: string; timeout?: number; output?: CommandOutput; outputFormat?: Exclude<StepOutputFormat, "json">; }
export interface ExecStep extends StepBase { type: "exec"; program: string; args?: string[]; cwd?: string; timeout?: number; output?: CommandOutput; outputFormat?: Exclude<StepOutputFormat, "json">; }
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
}
export interface AgentResult {
  output: string;
  model?: string;
  duration: number;
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
  control?: "continue" | "stop";
}
export interface RunState {
  id: string;
  workflow: string;
  cwd: string;
  started_at: string;
  finished_at?: string;
  status: "running" | "succeeded" | "failed";
  steps: StepResult[];
  outputs?: Record<string, unknown>;
}
export interface FlowCatalogEntry { name: string; path: string; description?: string; inputs: string[]; outputs: string[]; }
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

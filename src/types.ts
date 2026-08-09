export type StepType = "agent" | "shell" | "exec" | "loop";
export type ModelProfile = string;

export interface WorkflowInput { type: "string" | "boolean"; description?: string; default?: string | boolean; }
export type WorkflowInputs = Record<string, string | WorkflowInput>;

export interface Workflow {
  name: string;
  description?: string;
  inputs?: WorkflowInputs;
  steps: Step[];
}

export interface StepBase { id: string; type: StepType; when?: string; inputs?: string[]; outputs?: string[]; stopWhen?: string; stopMessage?: string; }
export interface AgentStep extends StepBase { type: "agent"; model?: ModelProfile; prompt: string; writes?: boolean; outputFormat?: "text" | "single-line" | "json"; }
export type CommandOutput = "always" | "failure" | "never";
export interface ShellStep extends StepBase { type: "shell"; command: string; shell?: string; cwd?: string; timeout?: number; output?: CommandOutput; }
export interface ExecStep extends StepBase { type: "exec"; program: string; args?: string[]; cwd?: string; timeout?: number; output?: CommandOutput; }
export interface LoopStep extends StepBase { type: "loop"; steps: Step[]; until: string; maxIterations?: number; }
export type Step = AgentStep | ShellStep | ExecStep | LoopStep;

export interface CommandResult {
  output: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  succeeded: boolean;
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
}
export interface RunState {
  id: string;
  workflow: string;
  cwd: string;
  started_at: string;
  finished_at?: string;
  status: "running" | "succeeded" | "failed";
  steps: StepResult[];
}
export interface FlowCatalogEntry { name: string; path: string; description?: string; inputs: string[]; }
export interface RunSummary {
  run_id: string;
  flow: string;
  status: RunState["status"];
  steps: Array<{ id: string; type: StepType; status: StepResult["status"]; exit_code?: number; process_succeeded?: boolean; changed?: boolean; message?: string; error?: string }>;
  changed_files: string[];
  important_outputs: Record<string, string>;
  run_file: string;
}

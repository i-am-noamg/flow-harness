export type StepType = "agent" | "command";
export type ModelProfile = string;

export interface WorkflowInput { type: "string" | "boolean"; default?: string | boolean; }
export type WorkflowInputs = Record<string, string | WorkflowInput>;

export interface Workflow {
  name: string;
  inputs?: WorkflowInputs;
  steps: Step[];
}

export interface StepBase { id: string; type: StepType; when?: string; inputs?: string[]; outputs?: string[]; stopWhen?: string; stopMessage?: string; }
export interface AgentStep extends StepBase { type: "agent"; model?: ModelProfile; prompt: string; writes?: boolean; outputFormat?: "text" | "single-line" | "json"; }
export interface CommandStep extends StepBase { type: "command"; command: string; args?: string[]; cwd?: string; timeout?: number; }
export type Step = AgentStep | CommandStep;

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
}
export interface StepResult {
  id: string;
  type: StepType;
  status: "running" | "succeeded" | "failed" | "skipped";
  started_at: string;
  finished_at?: string;
  result?: CommandResult | AgentResult;
  error?: string;
}
export interface RunState {
  id: string;
  workflow: string;
  task: string;
  cwd: string;
  started_at: string;
  finished_at?: string;
  status: "running" | "succeeded" | "failed";
  steps: StepResult[];
}

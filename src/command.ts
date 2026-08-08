import { spawn } from "node:child_process";
import type { CommandResult } from "./types.js";

type ProcessSpec = { program: string; args?: string[]; shell?: string | boolean };

export function runShell(command: string, cwd: string, timeout?: number, shell?: string, quiet = false): Promise<CommandResult> {
  return runProcess({ program: command, shell: shell ?? true }, cwd, timeout, quiet);
}

export function runExec(program: string, args: string[] = [], cwd = process.cwd(), timeout?: number, quiet = false): Promise<CommandResult> {
  return runProcess({ program, args }, cwd, timeout, quiet);
}

async function runProcess(spec: ProcessSpec, cwd: string, timeout = 10 * 60_000, quiet = false): Promise<CommandResult> {
  return new Promise((resolve) => {
    const started = Date.now(); let stdout = ""; let stderr = ""; let settled = false;
    const child = spawn(spec.program, spec.args ?? [], { cwd, shell: spec.shell, env: process.env });
    const finish = (exit_code: number, extra = "") => {
      if (settled) return; settled = true;
      if (extra) stderr += `\n${extra}`;
      resolve({ output: [stdout, stderr].filter(Boolean).join("\n"), stdout, stderr, exit_code, succeeded: exit_code === 0, duration: (Date.now() - started) / 1000 });
    };
    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); if (!quiet) process.stdout.write(data); });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); if (!quiet) process.stderr.write(data); });
    child.on("error", (error) => finish(1, error.message));
    child.on("close", (code) => finish(code ?? 1));
    const timer = setTimeout(() => { child.kill("SIGTERM"); finish(124, "command timed out"); }, timeout);
    child.on("close", () => clearTimeout(timer));
  });
}

import { spawn } from "node:child_process";
import type { CommandConsole, CommandResult } from "./types.js";

type ProcessSpec = { program: string; args?: string[]; shell?: string | boolean };

export function runShell(command: string, cwd: string, timeout?: number, shell?: string, consoleMode: CommandConsole = "always"): Promise<CommandResult> {
  return runProcess({ program: command, shell: shell ?? true }, cwd, timeout, consoleMode);
}

export function runExec(program: string, args: string[] = [], cwd = process.cwd(), timeout?: number, consoleMode: CommandConsole = "always"): Promise<CommandResult> {
  return runProcess({ program, args }, cwd, timeout, consoleMode);
}

async function runProcess(spec: ProcessSpec, cwd: string, timeout = 10 * 60_000, consoleMode: CommandConsole = "always"): Promise<CommandResult> {
  return new Promise((resolve) => {
    const started = Date.now(); let stdout = ""; let stderr = ""; let settled = false;
    const finish = (exit_code: number, extra = "", signal?: string, timed_out = false) => {
      if (settled) return; settled = true;
      if (extra) stderr += `${stderr ? "\n" : ""}${extra}`;
      const processSucceeded = exit_code === 0 && !timed_out && !signal;
      if (consoleMode === "on-failure" && !processSucceeded) {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
      }
      resolve({ output: [stdout, stderr].filter(Boolean).join("\n"), stdout, stderr, exit_code, ...(signal ? { signal } : {}), timed_out, duration: (Date.now() - started) / 1000 });
    };
    const child = spawn(spec.program, spec.args ?? [], { cwd, shell: spec.shell, env: process.env });
    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); if (consoleMode === "always") process.stdout.write(data); });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); if (consoleMode === "always") process.stderr.write(data); });
    child.on("error", (error) => finish(1, error.message));
    child.on("close", (code, signal) => finish(code ?? 1, "", signal ?? undefined));
    const timer = setTimeout(() => { child.kill("SIGTERM"); finish(124, "command timed out", undefined, true); }, timeout);
    child.on("close", () => clearTimeout(timer));
  });
}

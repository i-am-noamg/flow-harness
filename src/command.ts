import { spawn } from "node:child_process";
import type { CommandResult } from "./types.js";

export function runCommand(command: string, cwd: string, timeout?: number): Promise<CommandResult>;
export function runCommand(command: { executable: string; args: string[] } | string, cwd: string, timeout?: number): Promise<CommandResult>;
export function runCommand(command: string | { executable: string; args: string[] }, cwd: string, timeout = 10 * 60_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    const started = Date.now(); let stdout = ""; let stderr = ""; let settled = false;
    const child = typeof command === "string"
      ? spawn(command, { cwd, shell: true, env: process.env })
      : spawn(command.executable, command.args, { cwd, env: process.env });
    const finish = (exit_code: number, extra = "") => {
      if (settled) return; settled = true;
      if (extra) stderr += `\n${extra}`;
      resolve({ output: [stdout, stderr].filter(Boolean).join("\n"), stdout, stderr, exit_code, succeeded: exit_code === 0, duration: (Date.now() - started) / 1000 });
    };
    child.stdout.on("data", (d) => { stdout += d.toString(); process.stdout.write(d); });
    child.stderr.on("data", (d) => { stderr += d.toString(); process.stderr.write(d); });
    child.on("error", (e) => finish(1, e.message));
    child.on("close", (code) => finish(code ?? 1));
    const timer = setTimeout(() => { child.kill("SIGTERM"); finish(124, "command timed out"); }, timeout);
    child.on("close", () => clearTimeout(timer));
  });
}

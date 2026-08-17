import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The launcher always loads this package explicitly, so it works whether the
// package was installed through Pi, npm, or invoked from a checkout.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const cliCommands = new Set(["run", "validate", "list", "inspect", "help"]);
const isCliInvocation = cliCommands.has(args[0] ?? "");
const command = isCliInvocation ? process.execPath : (process.env.PI_BIN ?? "pi");
const commandArgs = isCliInvocation
  ? [join(dirname(fileURLToPath(import.meta.url)), "cli.js"), ...args]
  : ["-e", packageRoot, ...args];
const child = spawn(command, commandArgs, {
  cwd: process.cwd(),
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(`flow: unable to start Pi (${error.message})`);
  process.exitCode = 1;
});

child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});

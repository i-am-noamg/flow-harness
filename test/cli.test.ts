import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../src/cli.ts");
const tsx = fileURLToPath(import.meta.resolve("tsx"));

function runCli(cwd: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ["--import", tsx, cli, ...args], {
      cwd,
      env: { ...process.env, FLOW_WORKFLOW: "" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolveRun({ code, stderr }));
  });
}

async function fixture(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "flow-cli-"));
  await mkdir(join(cwd, "flows"));
  await writeFile(join(cwd, "flows", "explicit.flow"), [
    "name: explicit",
    "steps:",
    "  - id: report",
    "    type: exec",
    `    program: ${JSON.stringify(process.execPath)}`,
    "    args: [\"-e\", \"process.exit(0)\"]",
  ].join("\n"));
  return cwd;
}

test("CLI requires default workflow configuration but accepts explicit workflows", async () => {
  const cwd = await fixture();
  try {
    const missingDefault = await runCli(cwd, ["run"]);
    assert.equal(missingDefault.code, 1);
    assert.match(missingDefault.stderr, /No default workflow configured\. Set FLOW_WORKFLOW or specify one with `flow run <workflow>`\./);

    const explicit = await runCli(cwd, ["run", "explicit"]);
    assert.equal(explicit.code, 0, explicit.stderr);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

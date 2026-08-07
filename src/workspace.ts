import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { WorkspaceSnapshot } from "./types.js";

function git(cwd: string, args: string[]): string | undefined {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return undefined; }
}

export function snapshotWorkspace(cwd: string): WorkspaceSnapshot {
  const changed = git(cwd, ["diff", "HEAD", "--name-only", "-z"]);
  const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (changed !== undefined && untracked !== undefined) {
    const files: Record<string, string> = {};
    for (const path of changed.split("\0").filter(Boolean)) {
      const diff = git(cwd, ["diff", "HEAD", "--binary", "--", path]);
      files[path] = hash(diff ?? "");
    }
    for (const path of untracked.split("\0").filter(Boolean)) {
      try { files[path] = hash(readFileSync(join(cwd, path))); }
      catch { files[path] = "<unreadable>"; }
    }
    return makeSnapshot(files);
  }
  // Non-Git directories get a conservative result: a write-enabled step is considered changed.
  return { fingerprint: hash(`${cwd}:${Date.now()}`), files: {} };
}

export function workspaceChanged(before: WorkspaceSnapshot, after: WorkspaceSnapshot): boolean {
  return before.fingerprint !== after.fingerprint;
}

export function changedFiles(before: WorkspaceSnapshot, after: WorkspaceSnapshot): string[] {
  const paths = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  return [...paths].filter((path) => before.files[path] !== after.files[path]).sort();
}

function makeSnapshot(files: Record<string, string>): WorkspaceSnapshot {
  return { fingerprint: hash(JSON.stringify(Object.entries(files).sort())), files };
}
function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

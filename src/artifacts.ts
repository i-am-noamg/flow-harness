import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunState } from "./types.js";

export class RunStore {
  readonly dir: string;
  constructor(root: string) { this.dir = join(root, ".flow", "runs"); }
  async save(run: RunState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${run.id}.json`), JSON.stringify(run, null, 2));
  }
}

export function makeRunId(): string { return new Date().toISOString().replace(/[:.]/g, "-"); }

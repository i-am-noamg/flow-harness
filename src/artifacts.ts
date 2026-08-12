import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunState } from "./types.js";

export interface RunStoreLike { save(run: RunState): Promise<void>; }

export class RunStore implements RunStoreLike {
  readonly dir: string;
  private pending: Promise<void> = Promise.resolve();
  constructor(root: string) { this.dir = join(root, ".flow", "runs"); }
  async save(run: RunState): Promise<void> {
    this.pending = this.pending.catch(() => undefined).then(async () => {
      await mkdir(this.dir, { recursive: true });
      await writeFile(join(this.dir, `${run.id}.json`), JSON.stringify(run, null, 2));
    });
    await this.pending;
  }
}

export function makeRunId(): string { return new Date().toISOString().replace(/[:.]/g, "-"); }

const ANSI_ESCAPE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE, "");
}

import { evaluateCondition, validateCondition } from "./conditions.js";

export type OutputLiteral = string | number | boolean;
export type OutputExpression = { kind: "fallback"; candidates: OutputValueExpression[] };
export type OutputValueExpression =
  | { kind: "path"; path: string }
  | { kind: "literal"; value: OutputLiteral }
  | { kind: "comparison"; path: string; operator: "==" | "!="; expected: OutputLiteral }
  | { kind: "condition"; expression: string };

export class OutputResolutionError extends Error {
  constructor(readonly output: string, readonly expression: string, readonly path?: string, detail?: string) {
    super(detail ?? (path ? `Unable to resolve workflow output ${output}: unknown artifact/path: ${path}` : `Unable to resolve workflow output ${output}: ${expression}`));
    this.name = "OutputResolutionError";
  }
}

const PATH = /^[\w.-]+$/;

export function parseOutputExpression(expression: string): OutputExpression {
  const candidates = splitTopLevel(expression.trim(), "||").map(parseValueExpression);
  return { kind: "fallback", candidates };
}

export function evaluateOutputExpression(output: string, expression: string, lookup: (path: string) => unknown): unknown {
  let parsed: OutputExpression;
  try { parsed = parseOutputExpression(expression); } catch (error) {
    throw new OutputResolutionError(output, expression, undefined, error instanceof Error ? error.message : String(error));
  }
  let unresolvedPath: string | undefined;
  for (const candidate of parsed.candidates) {
    const result = evaluateValueExpression(candidate, lookup);
    if (result.path) unresolvedPath ??= result.path;
    if (result.value !== undefined) return result.value;
  }
  throw new OutputResolutionError(output, expression, unresolvedPath);
}

function parseValueExpression(expression: string): OutputValueExpression {
  if (!expression) throw new Error("Output expression contains an empty fallback candidate");
  if (expression.startsWith("condition(")) {
    if (!expression.endsWith(")")) throw new Error(`Invalid output condition: ${expression}`);
    const condition = expression.slice("condition(".length, -1).trim();
    if (!condition) throw new Error("Output condition must not be empty");
    validateCondition(condition);
    return { kind: "condition", expression: condition };
  }
  const comparison = expression.match(/^([\w.-]+)\s*(==|!=)\s*(.+)$/);
  if (comparison) {
    const expected = parseLiteral(comparison[3].trim(), true);
    if (expected === undefined) throw new Error(`Invalid output comparison value: ${comparison[3].trim()}`);
    return { kind: "comparison", path: comparison[1], operator: comparison[2] as "==" | "!=", expected };
  }
  const literal = parseLiteral(expression, false);
  if (literal !== undefined) return { kind: "literal", value: literal };
  if (PATH.test(expression)) return { kind: "path", path: expression };
  throw new Error(`Invalid output expression: ${expression}`);
}

function parseLiteral(value: string, allowBareString: boolean): OutputLiteral | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  if (allowBareString && PATH.test(value)) return value;
  if (allowBareString) throw new Error(`Invalid output comparison value: ${value}`);
  return undefined;
}

function evaluateValueExpression(expression: OutputValueExpression, lookup: (path: string) => unknown): { value: unknown; path?: string } {
  if (expression.kind === "literal") return { value: expression.value };
  if (expression.kind === "path") {
    const value = lookup(expression.path);
    return value === undefined ? { value, path: expression.path } : { value };
  }
  if (expression.kind === "comparison") {
    const actual = lookup(expression.path);
    return actual === undefined ? { value: undefined, path: expression.path } : { value: expression.operator === "==" ? actual === expression.expected : actual !== expression.expected };
  }
  const evaluation = evaluateCondition(expression.expression, lookup);
  if (evaluation.kind === "true") return { value: true };
  if (evaluation.kind === "false") return { value: false };
  if (evaluation.kind === "unknown") return { value: undefined, path: evaluation.path };
  if (evaluation.kind === "invalid") throw new Error(evaluation.error);
  throw new Error(`Invalid output condition: ${expression.expression}`);
}

function splitTopLevel(expression: string, operator: "||"): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | "\"" | undefined;
  for (let index = 0; index < expression.length; index++) {
    const character = expression[index];
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === "\"") { quote = character; continue; }
    if (character === "(") depth++;
    else if (character === ")") {
      depth--;
      if (depth < 0) throw new Error(`Unbalanced output expression: ${expression}`);
    }
    if (depth === 0 && expression.startsWith(operator, index)) {
      parts.push(expression.slice(start, index).trim());
      start = index + operator.length;
      index++;
    }
  }
  if (quote || depth !== 0) throw new Error(`Unbalanced output expression: ${expression}`);
  parts.push(expression.slice(start).trim());
  if (parts.some((part) => !part)) throw new Error(`Invalid output expression: ${expression}`);
  return parts;
}

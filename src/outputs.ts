import { evaluateCondition, validateCondition } from "./conditions.js";

export type OutputLiteral = string | number | boolean;
export type OutputExpression = OutputValueExpression;
export type OutputValueExpression =
  | { kind: "path"; path: string }
  | { kind: "literal"; value: OutputLiteral }
  | { kind: "condition"; expression: string }
  | { kind: "if"; condition: string; whenTrue: OutputValueExpression; whenFalse: OutputValueExpression };

export class OutputResolutionError extends Error {
  constructor(readonly output: string, readonly expression: string, readonly path?: string, detail?: string) {
    super(detail ?? (path ? `Unable to resolve workflow output ${output}: unknown artifact/path: ${path}` : `Unable to resolve workflow output ${output}: ${expression}`));
    this.name = "OutputResolutionError";
  }
}

const PATH = /^[\w.-]+$/;

export function parseOutputExpression(expression: string): OutputExpression {
  return parseValueExpression(expression.trim());
}

export function evaluateOutputExpression(output: string, expression: string, lookup: (path: string) => unknown): unknown {
  let parsed: OutputExpression;
  try {
    parsed = parseOutputExpression(expression);
  } catch (error) {
    throw new OutputResolutionError(output, expression, undefined, error instanceof Error ? error.message : String(error));
  }
  try {
    return evaluateValueExpression(output, expression, parsed, lookup);
  } catch (error) {
    if (error instanceof OutputResolutionError) throw error;
    throw new OutputResolutionError(output, expression, undefined, error instanceof Error ? error.message : String(error));
  }
}

function parseValueExpression(expression: string): OutputValueExpression {
  if (!expression) throw new Error("Output expression must not be empty");
  const ifArguments = parseIfArguments(expression);
  if (ifArguments) {
    const [condition, whenTrue, whenFalse] = ifArguments;
    if (!condition || !whenTrue || !whenFalse) throw new Error("if(condition, when_true, when_false) requires three non-empty arguments");
    validateCondition(condition);
    return { kind: "if", condition, whenTrue: parseValueExpression(whenTrue), whenFalse: parseValueExpression(whenFalse) };
  }
  const literal = parseLiteral(expression);
  if (literal !== undefined) return { kind: "literal", value: literal };
  if (PATH.test(expression)) return { kind: "path", path: expression };
  validateCondition(expression);
  return { kind: "condition", expression };
}

function parseLiteral(value: string): OutputLiteral | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return undefined;
}

function parseIfArguments(expression: string): [string, string, string] | undefined {
  if (!expression.startsWith("if(")) return undefined;
  if (!expression.endsWith(")")) throw new Error(`Invalid output expression: ${expression}`);
  const arguments_ = splitArguments(expression.slice(3, -1), expression);
  if (arguments_.length !== 3) throw new Error("if(condition, when_true, when_false) requires exactly three arguments");
  return arguments_ as [string, string, string];
}

function splitArguments(value: string, original: string): string[] {
  const arguments_: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | "\"" | undefined;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === "\"") { quote = character; continue; }
    if (character === "(") depth++;
    else if (character === ")") {
      if (--depth < 0) throw new Error(`Unbalanced output expression: ${original}`);
    } else if (character === "," && depth === 0) {
      arguments_.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quote || depth !== 0) throw new Error(`Unbalanced output expression: ${original}`);
  arguments_.push(value.slice(start).trim());
  return arguments_;
}

function evaluateValueExpression(output: string, source: string, expression: OutputValueExpression, lookup: (path: string) => unknown): unknown {
  if (expression.kind === "literal") return expression.value;
  if (expression.kind === "path") {
    const value = lookup(expression.path);
    if (value === undefined) throw new OutputResolutionError(output, source, expression.path);
    return value;
  }
  if (expression.kind === "condition") return evaluateBooleanExpression(output, source, expression.expression, lookup);
  const selected = evaluateBooleanExpression(output, source, expression.condition, lookup) ? expression.whenTrue : expression.whenFalse;
  return evaluateValueExpression(output, source, selected, lookup);
}

function evaluateBooleanExpression(output: string, source: string, expression: string, lookup: (path: string) => unknown): boolean {
  const evaluation = evaluateCondition(expression, lookup);
  if (evaluation.kind === "true") return true;
  if (evaluation.kind === "false") return false;
  if (evaluation.kind === "unknown") throw new OutputResolutionError(output, source, evaluation.path);
  if (evaluation.kind === "invalid") throw new Error(evaluation.error);
  throw new Error(`Invalid output condition: ${expression}`);
}

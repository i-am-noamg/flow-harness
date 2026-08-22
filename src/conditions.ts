export type ConditionEvaluation =
  | { kind: "true" | "false" }
  | { kind: "unknown"; path: string }
  | { kind: "invalid"; error: string };

export function validateCondition(expression: string): void {
  validateOr(expression.trim());
}

export function evaluateCondition(expression: string, lookup: (path: string) => unknown): ConditionEvaluation {
  try {
    validateCondition(expression);
    return evaluateOr(expression.trim(), lookup);
  } catch (error) {
    return { kind: "invalid", error: error instanceof Error ? error.message : String(error) };
  }
}

function validateOr(expression: string): void {
  for (const part of splitTopLevel(expression, "||")) validateAnd(part);
}

function validateAnd(expression: string): void {
  for (const part of splitTopLevel(expression, "&&")) validatePrimary(part);
}

function validatePrimary(expression: string): void {
  const trimmed = expression.trim();
  const unwrapped = unwrapParentheses(trimmed);
  if (unwrapped !== trimmed) return validateOr(unwrapped);
  if (!/^([\w.-]+)\s*(==|!=)\s*(.+)$/.test(unwrapped)) throw new Error(`Unsupported condition: ${unwrapped}`);
}

function evaluateOr(expression: string, lookup: (path: string) => unknown): ConditionEvaluation {
  let problem: ConditionEvaluation | undefined;
  for (const part of splitTopLevel(expression, "||")) {
    const value = evaluateAnd(part, lookup);
    if (value.kind === "true") return value;
    if (value.kind === "unknown" || value.kind === "invalid") problem ??= value;
  }
  return problem ?? { kind: "false" };
}

function evaluateAnd(expression: string, lookup: (path: string) => unknown): ConditionEvaluation {
  let problem: ConditionEvaluation | undefined;
  for (const part of splitTopLevel(expression, "&&")) {
    const value = evaluatePrimary(part, lookup);
    if (value.kind === "false") return value;
    if (value.kind === "unknown" || value.kind === "invalid") problem ??= value;
  }
  return problem ?? { kind: "true" };
}

function evaluatePrimary(expression: string, lookup: (path: string) => unknown): ConditionEvaluation {
  const unwrapped = unwrapParentheses(expression.trim());
  return unwrapped === expression.trim()
    ? evaluateComparison(unwrapped, lookup)
    : evaluateOr(unwrapped, lookup);
}

function splitTopLevel(expression: string, operator: "&&" | "||"): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < expression.length; index++) {
    const character = expression[index];
    if (character === "(") depth++;
    else if (character === ")") {
      depth--;
      if (depth < 0) throw new Error(`Unbalanced condition: ${expression}`);
    }
    if (depth === 0 && expression.startsWith(operator, index)) {
      parts.push(expression.slice(start, index).trim());
      start = index + operator.length;
      index += operator.length - 1;
    }
  }
  if (depth !== 0) throw new Error(`Unbalanced condition: ${expression}`);
  parts.push(expression.slice(start).trim());
  if (parts.some((part) => !part)) throw new Error(`Invalid condition: ${expression}`);
  return parts;
}

function unwrapParentheses(expression: string): string {
  if (!expression.startsWith("(") || !expression.endsWith(")")) return expression;
  let depth = 0;
  for (let index = 0; index < expression.length; index++) {
    if (expression[index] === "(") depth++;
    else if (expression[index] === ")") depth--;
    if (depth === 0 && index < expression.length - 1) return expression;
  }
  if (depth !== 0) throw new Error(`Unbalanced condition: ${expression}`);
  return expression.slice(1, -1).trim();
}

function evaluateComparison(expression: string, lookup: (path: string) => unknown): ConditionEvaluation {
  const match = expression.match(/^([\w.-]+)\s*(==|!=)\s*(.+)$/);
  if (!match) return { kind: "invalid", error: `Unsupported condition: ${expression}` };
  const actual = lookup(match[1]);
  if (actual === undefined) return { kind: "unknown", path: match[1] };
  let expected: unknown = match[3].trim().replace(/^['\"]|['\"]$/g, "");
  if (expected === "true") expected = true;
  else if (expected === "false") expected = false;
  else if (/^-?\d+(\.\d+)?$/.test(String(expected))) expected = Number(expected);
  return { kind: match[2] === "==" ? (actual === expected ? "true" : "false") : (actual !== expected ? "true" : "false") };
}

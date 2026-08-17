Generate a concise, valid Git branch name for the staged changes below.

Return only a valid JSON object with exactly this string field:
{
  "generated_branch": "..."
}

Use lowercase words separated by hyphens. Do not use Markdown fences, explanations, or any text outside the JSON object.

--- Git status ---
{{status.output}}

--- Staged diff ---
{{staged_diff.output}}

Generate a concise Git branch name for the staged changes below.

Return only this JSON object:
{
  "generated_branch": "..."
}

Use lowercase words separated by hyphens. Do not use Markdown, explanations, or any text outside the JSON object.

--- Git status ---
{{status.output}}

--- Staged diff ---
{{staged_diff.output}}

Generate a concise commit message for the staged changes below.

Return only a valid JSON object with exactly this string field:
{
  "generated_commit_message": "..."
}

The message may be multiline and should clearly summarize the changes. Do not use Markdown fences, explanations, or any text outside the JSON object.

--- Git status ---
{{status.output}}

--- Staged diff ---
{{staged_diff.output}}

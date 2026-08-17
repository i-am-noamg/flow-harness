Generate a concise commit message and a valid Git branch name for the staged changes.

Return only this JSON object, with exactly these string fields:
{
  "generated_commit_message": "...",
  "generated_branch": "..."
}

The commit message may be multiline and must summarize the changes. Use lowercase hyphen-separated words for the branch name. Do not use Markdown, code fences, explanations, or any text outside the JSON object.

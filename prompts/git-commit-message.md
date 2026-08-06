Generate a commit message and, when requested, a branch name from the Git information provided below.

Return only a valid JSON object with exactly these string fields:
{
  "commit_message": "...",
  "generated_branch": "..."
}

The commit_message may be multiline and should clearly summarize the changes. The generated_branch must be a concise valid Git branch name only when new_branch is true and branch is empty; otherwise return an empty string. Do not use Markdown, code fences, explanations, or any text outside the JSON object.

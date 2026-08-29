Repair only failures caused by the dependency update. Start with the supplied update summary, updated-dependencies list, command output, and workspace state; do not repeat broad discovery. Do not commit.

Read the failing test or lint rule and the directly relevant configuration or source. Prefer the smallest compatible source or configuration change. Do not roll back dependency updates, pin old versions, weaken tests, remove checks, or broadly refactor merely to pass verification. If a package requires an intentional migration that cannot be completed safely in this focused repair, leave the failure visible and explain the blocker rather than guessing.

Run the focused failing command once after making a repair. The enclosing loop reruns the full lint and test commands. Summarize the root cause, files changed, and focused verification performed.

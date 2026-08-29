Update this repository's root npm dependencies to their latest versions. The working tree was checked clean before this step; do not commit.

First confirm this is an npm project with a root `package.json`. If it is not, make no changes and return a structured explanation. Inspect the manifest, lockfile, package-manager metadata, and npm scripts before editing.

Update every versioned direct dependency in the root `dependencies`, `devDependencies`, `optionalDependencies`, and `peerDependencies` sections to the latest stable release, including major-version updates. Preserve non-registry specs (`file:`, `workspace:`, git URLs, URLs, aliases, and explicitly local packages) unless npm itself requires a compatible lockfile change. Do not add unrelated packages or change scripts, project configuration, source code, or package-manager choice.

Use the repository's existing npm version and a project-local/transient invocation of `npm-check-updates` (never a global install) to update manifest ranges, then run `npm install` to refresh the existing lockfile. When `include_prerelease` is true, allow prerelease targets; otherwise select stable releases only. Inspect the resulting diff. If npm-check-updates cannot safely update a valid declared dependency, resolve that one dependency from npm metadata and make the smallest equivalent manifest update before refreshing the lockfile. Do not downgrade a dependency.

Run a focused npm command only if needed to establish that the installation itself succeeded; the workflow runs lint and tests afterwards. If no dependency declaration or lockfile changes are needed, leave the workspace untouched.

Return exactly JSON with these fields:
- `update_summary`: concise result, including the npm and lockfile commands run and any dependency deliberately left unchanged.
- `updated_dependencies`: an array of objects with `name`, `section`, `from`, and `to`; use an empty array when nothing changed.

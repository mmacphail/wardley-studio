# Publishing the repository

The source tree is prepared for a new GitHub repository. No remote URL or GitHub owner is hard-coded. The existing license is MIT; Wardley Mapping attribution is in the README.

1. Run the checks in [CONTRIBUTING.md](../CONTRIBUTING.md).
2. Inspect `git status --short --untracked-files=all`. The personal `workspace/`, credentials, chat/runtime files, dependencies, build output and test artifacts must remain excluded. Publish `examples/` as the starter data.
3. Stage and review the initial source commit:

   ```sh
   git add .
   git diff --cached --stat
   git diff --cached --check
   git diff --cached
   git commit -m "Initial Wardley Studio release"
   ```

4. Create an empty repository on GitHub with your chosen name and visibility. Do not generate another README, license or ignore file there.
5. Copy its remote URL, then push:

   ```sh
   git remote add origin <repository-url>
   git push -u origin main
   ```

6. Check the first **CI** run. Consider protecting `main` with the frontend and Linux checks, and enable private vulnerability reporting in repository settings. The workflow has read-only repository permissions, pins actions to commit hashes, and needs no account secrets. Dependabot proposes dependency and action updates.

## Distributing an application build

Successful Linux CI runs upload Debian and RPM installers as Actions artifacts. Download the artifact from the run, test installation on a clean compatible Linux system, and create a GitHub Release manually when ready. CI does not create tags, publish releases, or upload personal maps. Linux installers are built on Ubuntu 24.04; do not claim compatibility with older distributions without testing.

Keep the version synchronized in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json` before tagging a release. Document changes and attach the tested installers to that tag. For a distribution without chat, use `npm run desktop:build:core` and test it with `python3 scripts/test-native-api.py --core`. Use distinct release asset names to distinguish the variants. The core build excludes the frontend chat module and native Codex integration. The builds are unsigned; macOS and Windows require separate platform validation and signing setup before distribution.

The workflow follows the official [Tauri GitHub build guidance](https://v2.tauri.app/distribute/pipelines/github/) and [Playwright CI instructions](https://playwright.dev/docs/ci).

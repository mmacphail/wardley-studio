# Contributing

Use Node 24 or later, a current stable Rust toolchain, Python 3.10+ for native integration tests, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). See [README.md](README.md) for setup and app behavior.

```sh
npm ci
npx playwright install chromium
npm run check
npm run test:e2e
npm run test:e2e:core
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

On Linux CI, use `npx playwright install --with-deps chromium` to install browser system libraries too. `CHROMIUM_PATH` can select an existing browser. Local Linux runs also detect `/usr/bin/chromium`; other environments use Playwright's installed browser.

The GitHub workflow runs frontend checks, browser tests, Rust tests, and a Linux native build with an isolated HTTP/disk integration test. It uploads Debian and RPM installers as Actions artifacts. It also verifies runtime-disabled chat and a core build without chat. It does not publish releases or use a ChatGPT account. Live subscription tests are opt-in, consume account usage, and must not run on untrusted pull requests.

Keep changes focused and describe behavior and validation in pull requests. Update [API.md](API.md) when routes or request/response fields change. Preserve existing workspace JSON compatibility, undo behavior, and save-conflict protection. Add meaningful regression coverage for behavior changes. Commit `package-lock.json` and `src-tauri/Cargo.lock` with dependency changes.

Use the synthetic maps in `examples/` for tests, screenshots, and bug reports. Your development `workspace/`, chat history, API discovery file, credentials, and generated builds are local data. Do not force-add them to Git. Review the file list before committing. Report security issues as described in [SECURITY.md](SECURITY.md).

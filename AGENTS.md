# Repository Guidelines

## Project Structure & Module Organization

Zanahoria is a Tauri 2 database client with a React/TypeScript frontend and Rust backend. `src/components/` groups UI by feature; `src/stores/` holds Zustand state, `src/ipc/` defines backend calls and shared types, and `src/lib/` contains utilities. Translations live in `src/i18n/`; global styling is in `src/styles.css`.

`src-tauri/src/commands/` exposes Tauri commands. Reusable Rust crates live in `src-tauri/crates/`: `db-core` handles database engines, `app-store` handles persistence and secrets, and `backup` handles backup operations. Database fixtures live in `docker/seed/`, screenshots in `docs/screenshots/`, and application icons in `src-tauri/icons/`.

## Build, Test, and Development Commands

Use Node.js 22+, pnpm 11, stable Rust, and the platform-specific Tauri prerequisites documented in `README.md`.

- `pnpm install --frozen-lockfile`: install frontend dependencies.
- `pnpm tauri dev`: run the desktop app with development reloads.
- `pnpm dev`: run the Vite frontend server.
- `pnpm build`: check TypeScript and build frontend assets.
- `pnpm tauri build`: create desktop installers.
- `pnpm test`: run Vitest unit tests.
- `cargo test --manifest-path src-tauri/Cargo.toml --workspace`: run Rust tests.
- `docker compose up -d --wait`: start integration-test databases.

## Coding Style & Naming Conventions

Match existing TypeScript style: two-space indentation, double quotes, semicolons, PascalCase component filenames, and camelCase functions and variables. Keep TypeScript strict and unused-code checks passing. Use snake_case Rust modules and functions, and standard rustfmt formatting. No frontend formatter or lint script is currently configured.

Before submitting Rust changes, run `cargo fmt --manifest-path src-tauri/Cargo.toml --all --check` and `cargo clippy --manifest-path src-tauri/Cargo.toml --workspace -- -D warnings`.

## Testing Guidelines

Place Vitest tests beside implementation files as `*.test.ts`. Rust uses unit tests and `src-tauri/crates/db-core/tests/integration.rs`. Database integration tests require the corresponding `ZANAHORIA_TEST_PG`, `ZANAHORIA_TEST_MYSQL`, `ZANAHORIA_TEST_MARIADB`, or `ZANAHORIA_TEST_REDIS` environment variable; copy values from `.github/workflows/`. Without these variables, database cases skip. Add regression coverage for changed behavior; no numeric coverage threshold is configured.

## Commit & Pull Request Guidelines

Recent commits use short descriptive subjects, often imperative, without a mandatory Conventional Commits prefix. Describe the behavior changed. Keep pull requests focused; include the problem, solution, validation commands and results, relevant issue links, and screenshots for UI changes.

## Agent Instructions

Read `/home/eitalouarruda/.codex/RTK.md` and prefix shell commands with `rtk` as instructed there. Keep `db-core` free of OpenSSL/native-tls dependencies, as CI enforces this for Android compatibility.

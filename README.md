<p align="center">
  <img src="icon-src.png" alt="Zanahoria logo" width="96" />
</p>

<h1 align="center">Zanahoria</h1>

<p align="center">
  A fast, keyboard-friendly desktop client for SQL databases and Redis.<br />
  Built with Rust and Tauri for Linux and Windows.
</p>

<p align="center">
  <img src="docs/screenshots/workspace.png" alt="Zanahoria with three databases open in the sidebar and a query result grid" width="900" />
</p>

---

Zanahoria lets you connect to your databases, write and run SQL with a smart
editor, browse and edit results in a grid, and keep several databases open
side by side. It was designed to make day-to-day work on production data safer
and faster: risky changes go through a review step, every edit runs in a
transaction, and almost everything can be done from the keyboard.

**Supported engines:** PostgreSQL · MySQL · MariaDB · SQLite · Redis

## Highlights

- **Several databases at the same time.** Every open database gets its own
  entry in the sidebar, labeled with its name. Press <kbd>Ctrl</kbd>+<kbd>K</kbd>
  to open another database of the same server without leaving the one you are
  working on.
- **Safe Mode per connection.** Mark production connections as *Safe Mode* and
  every change made from the grid is shown as SQL for review before it runs, is
  applied in a single transaction with affected-row verification, and
  `UPDATE`/`DELETE` statements without `WHERE` ask for confirmation.
- **Favorite queries.** Save queries you use often and reopen them from any
  connection, already pointed at the right database.
- **Split view.** Work on two queries of the same tab side by side, each with
  its own results grid. Switch panes tmux-style with
  <kbd>Ctrl</kbd>+<kbd>Space</kbd> then <kbd>←</kbd> / <kbd>→</kbd>.
- **Smart SQL editor.** Syntax highlighting, context-aware autocomplete
  (columns of the tables in the current statement, aliases, column types),
  current-statement highlighting, search and replace, and formatting.
- **Editable results grid.** Navigate with the arrow keys, edit cells in place,
  add or delete rows, load more rows on demand and export to CSV, JSON or SQL.
- **Customizable shortcuts, themes and languages.** Rebind any shortcut, choose
  a dark or light theme, and use the app in English, Português or Español.
- **Backup and restore.** Run `pg_dump`/`pg_restore`/`mysqldump` from the app,
  or take a consistent SQLite copy with no external tools.

## Screenshots

### Connections

Each connection shows whether Safe Mode is on. A green dot marks the
connections that are currently open.

<img src="docs/screenshots/connections.png" alt="Connection list with Safe Mode and No safe mode badges" width="900" />

### Safe Mode review

Changes made in the grid on a Safe Mode connection are previewed as SQL before
anything is written.

<img src="docs/screenshots/safe-mode.png" alt="Code review dialog listing the UPDATE statements that will run" width="900" />

### Split view

Two editors, two independent result grids. The highlighted pane is the one the
toolbar and shortcuts act on.

<img src="docs/screenshots/split.png" alt="Split view with two queries and two result grids" width="900" />

### Favorite queries

<img src="docs/screenshots/favorites.png" alt="List of saved favorite queries across connections" width="900" />

### Settings and shortcuts

<img src="docs/screenshots/settings.png" alt="Settings page with language, theme and keyboard shortcuts" width="900" />

### Light theme

<img src="docs/screenshots/light-theme.png" alt="Workspace in the light theme" width="900" />

## How to use

1. **Add a connection.** On the *Connections* screen click **+ New connection**,
   pick the engine and fill in host, port, user, password and database (or the
   file, for SQLite). Use **Test connection** to check it, and enable
   **Safe Mode** for any database you want to protect.
2. **Connect.** Click **Connect**. The database opens in the sidebar on the
   left, with its tables in the schema tree.
3. **Query.** Type SQL in the editor and press <kbd>Ctrl</kbd>+<kbd>Enter</kbd>
   to run the selection or the statement under the cursor, or
   <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd> to run everything.
   Double-click a table in the schema tree to browse its data.
4. **Edit data.** Double-click a cell (or select it and press
   <kbd>Enter</kbd>), change the value, then review and commit with
   <kbd>Ctrl</kbd>+<kbd>S</kbd>. Use **+ Row** to insert and **−** to delete.
5. **Open more databases.** Press <kbd>Ctrl</kbd>+<kbd>K</kbd>, type to filter
   and press <kbd>Enter</kbd>. Right-click an entry in the sidebar to close it.
6. **Save favorites.** Click **★ Favorite** to save the current query; find it
   later under the star in the sidebar.

On macOS use <kbd>⌘</kbd> instead of <kbd>Ctrl</kbd>.

## Keyboard shortcuts

All shortcuts can be changed in **Settings → Keyboard shortcuts** (the gear at
the bottom of the sidebar, or <kbd>Ctrl</kbd>+<kbd>,</kbd>). These are the
defaults:

| Action | Shortcut |
| --- | --- |
| Run selection or current statement | <kbd>Ctrl</kbd>+<kbd>Enter</kbd> |
| Run everything in the editor | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd> |
| Re-run last query | <kbd>Ctrl</kbd>+<kbd>R</kbd> / <kbd>F5</kbd> |
| Open another database | <kbd>Ctrl</kbd>+<kbd>K</kbd> |
| Next / previous open database | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>]</kbd> / <kbd>[</kbd> |
| Close and disconnect current database | <kbd>Ctrl</kbd>+<kbd>Esc</kbd> |
| New / close query tab | <kbd>Ctrl</kbd>+<kbd>T</kbd> / <kbd>Ctrl</kbd>+<kbd>W</kbd> |
| Next / previous query tab | <kbd>Ctrl</kbd>+<kbd>Tab</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Tab</kbd> |
| Split / unsplit editor | <kbd>Ctrl</kbd>+<kbd>\\</kbd> |
| Focus left / right pane | <kbd>Ctrl</kbd>+<kbd>Space</kbd> then <kbd>←</kbd> / <kbd>→</kbd> |
| Format SQL / compact into one line | <kbd>Ctrl</kbd>+<kbd>I</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd> |
| Toggle line / block comment | <kbd>Ctrl</kbd>+<kbd>/</kbd> / <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>/</kbd> |
| Preview / commit pending changes | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> / <kbd>Ctrl</kbd>+<kbd>S</kbd> |
| Editor font size | <kbd>Ctrl</kbd>+<kbd>+</kbd> / <kbd>Ctrl</kbd>+<kbd>-</kbd> / <kbd>Ctrl</kbd>+<kbd>0</kbd> |
| Go to connections / settings | <kbd>Ctrl</kbd>+<kbd>N</kbd> / <kbd>Ctrl</kbd>+<kbd>,</kbd> |
| Quit | <kbd>Ctrl</kbd>+<kbd>Q</kbd> |

In the results grid: arrow keys, <kbd>Tab</kbd>, <kbd>Home</kbd>/<kbd>End</kbd>
and <kbd>PgUp</kbd>/<kbd>PgDn</kbd> move between cells, <kbd>Enter</kbd> or
<kbd>F2</kbd> edits, and <kbd>Ctrl</kbd>+<kbd>C</kbd> copies the cell.

## Download

Get the latest installers from the [Releases page](../../releases):

- **Linux:** `Zanahoria_<version>_amd64.AppImage` — make it executable
  (`chmod +x`) and run it.
- **Windows:** `Zanahoria_<version>_x64-setup.exe` (or the `.msi`).

A new release is published automatically on every push to `main`.

## Building from source

Requirements:

- [Rust](https://rustup.rs) (stable)
- [Node.js](https://nodejs.org) 22 or newer and [pnpm](https://pnpm.io) 11
- The [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your
  platform (on Debian/Ubuntu: `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`,
  `librsvg2-dev`, `patchelf`)

```bash
pnpm install
pnpm tauri dev     # run in development mode
pnpm tauri build   # build installers into src-tauri/target/release/bundle
```

The helper script `./dev.sh` does the same, and `./dev.sh --db` also starts
local PostgreSQL, MySQL, MariaDB and Redis test databases with Docker Compose.

### Tests

```bash
pnpm test                                   # frontend unit tests
cargo test --manifest-path src-tauri/Cargo.toml --workspace
```

Integration tests run against the Docker Compose databases when the
`ZANAHORIA_TEST_PG`, `ZANAHORIA_TEST_MYSQL`, `ZANAHORIA_TEST_MARIADB` and
`ZANAHORIA_TEST_REDIS` environment variables are set (see
`.github/workflows/build.yml`).

## Project layout

```
src/                 React + TypeScript frontend (editor, grid, settings, i18n)
src-tauri/           Tauri application (commands exposed to the frontend)
src-tauri/crates/
  db-core/           Database engines, query execution, schema, mutations
  app-store/         Local storage: connections, history, favorites, settings
  backup/            Backup and restore jobs (pg_dump, mysqldump, …)
```

Passwords never go into the app's database: they are kept in the operating
system's credential store (Secret Service, Windows Credential Manager or macOS
Keychain), with an encrypted file as fallback when no credential store is
available.

# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Before you start

- **Security issues** go through private reporting, not issues — see [SECURITY.md](SECURITY.md).
- For larger changes, open an issue first so we can agree on the approach before you spend time on it.

## Setup

```bash
npm ci
WIKI_DATA_DIR=./data npm run dev
```

Open http://localhost:3000/setup — the setup token is printed in the terminal.

## Checks

Run these before opening a pull request; CI runs the same.

```bash
npm run check       # TypeScript, Prettier, unit tests
npm run build       # production build
npm run test:e2e    # end-to-end against the built server
```

## Conventions

- **Formatting:** Prettier (`npm run format`). The editor settings are in `.editorconfig`.
- **Interface texts:** written in English in the code and translated in `src/lib/i18n-de.ts`. Use `t("…")` in components and `msg("…")` for strings defined outside a component. A unit test fails if any text has no German translation; placeholders like `{name}` must match.
- **Server errors:** throw `HttpError(status, "English message", field?)`; the API layer translates it.
- **Database changes:** add a new `MIGRATION_n` in `src/lib/db.ts` and bump `user_version`. Never edit a migration that has shipped. Add an upgrade test in `tests/upgrade.test.ts`.
- **Security-relevant code** (auth, sessions, uploads, rendering, import, mail) needs tests for the abuse case, not only the happy path.
- **No new runtime dependencies** without a good reason; pin exact versions.

## Commits and pull requests

- Small, focused commits with a message that says what and why.
- Describe user-visible changes in the pull request and add them to [CHANGELOG.md](CHANGELOG.md) under _Unreleased_.
- Screenshots help for anything visual.

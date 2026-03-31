# wordfetti

App for the hat game.

## Development

Install dependencies:

```bash
pnpm install
```

Run the client and server in development mode:

```bash
pnpm dev
```

## Repeatable Commands

Type-check the full workspace:

```bash
pnpm typecheck
```

Run the server test suite:

```bash
pnpm test
```

Build shared, server, and client in order:

```bash
pnpm build
```

Run the full verification pass:

```bash
pnpm check
```

`pnpm check` runs `typecheck`, then `test`, then `build`.

## Team Names

Random team names are drawn from `server/assets/team-names.txt` — one name per line, blank lines ignored. Edit that file to change the pool. The server reads it once at startup, so a restart is required to pick up changes.

Names are validated at 1–20 characters. If the file is missing or unreadable the server falls back to "Team 1" / "Team 2".

In-game, the host can also rename teams from the lobby screen.

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

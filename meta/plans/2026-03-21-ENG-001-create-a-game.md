# ENG-001: Create a Game — Implementation Plan

## Overview

Set up the project scaffold (pnpm monorepo, React/Vite client, Express server, shared types, Docker) and deliver the first user-visible feature: a host visits the home page, clicks "Create Game", and is shown a short join code.

## Current State Analysis

Greenfield — no code exists. Only `CLAUDE.md`, `LLM-GUIDANCE.md`, and `README.md` are present.

## Desired End State

A running app (locally and in Docker) where:
- Visiting `/` shows a home page with a "Create Game" button
- Clicking it calls `POST /api/games`, receives a join code, and redirects to `/game/:joinCode`
- That page displays the join code prominently (large, easy to read aloud)

## What We're NOT Doing

- Player join form (name + team) — that is ENG-002
- Lobby screen — ENG-002
- Any persistence beyond in-memory — future epic
- Authentication or session management

---

## Project Structure

```
wordfetti/
├── client/                  # Vite + React + TypeScript + Tailwind
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   └── pages/
│   │       ├── HomePage.tsx
│   │       └── GameCodePage.tsx
│   ├── index.html
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   ├── postcss.config.js
│   ├── tsconfig.json
│   └── package.json
├── server/
│   ├── src/
│   │   ├── index.ts
│   │   ├── routes/
│   │   │   ├── games.ts
│   │   │   └── games.test.ts
│   │   └── store/
│   │       ├── GameStore.ts
│   │       └── InMemoryGameStore.ts
│   ├── tsconfig.json
│   └── package.json
├── shared/
│   ├── src/
│   │   ├── index.ts         # Re-exports from types.ts — package entry point
│   │   └── types.ts
│   ├── tsconfig.json
│   └── package.json
├── pnpm-workspace.yaml
├── package.json             # Root — workspace scripts only
├── .env.example
├── Dockerfile
└── docker-compose.yml
```

---

## Phase 1: Project Scaffold

### Overview

Initialise the monorepo, configure tooling for all three packages, and verify the dev environment and Docker build work end-to-end before any feature code is written.

### Changes Required

#### 1. Root workspace config

**File**: `pnpm-workspace.yaml`
```yaml
packages:
  - 'client'
  - 'server'
  - 'shared'
```

**File**: `package.json`
```json
{
  "name": "wordfetti",
  "private": true,
  "scripts": {
    "dev": "concurrently \"pnpm --filter server dev\" \"pnpm --filter client dev\"",
    "build": "pnpm --filter shared build && pnpm --filter server build && pnpm --filter client build",
    "test": "pnpm --filter server test"
  },
  "devDependencies": {
    "concurrently": "^9.0.0"
  }
}
```

#### 2. Shared package

**File**: `shared/package.json`
```json
{
  "name": "@wordfetti/shared",
  "version": "0.0.1",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}
```

**File**: `shared/src/types.ts` — initially empty, populated in Phase 2.

**File**: `shared/src/index.ts` — re-exports the package's public API:
```typescript
export * from './types'
```

#### 3. Server package

**File**: `server/package.json`
```json
{
  "name": "@wordfetti/server",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
  "type": "module",
  "dependencies": {
    "@wordfetti/shared": "workspace:*",
    "express": "^4.18.0",
    "cors": "^2.8.5",
    "express-rate-limit": "^7.0.0",
    "helmet": "^8.0.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.0",
    "@types/cors": "^2.8.0",
    "supertest": "^7.0.0",
    "@types/supertest": "^6.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.0.0",
    "vitest": "^2.0.0"
  }
}
```

**File**: `server/tsconfig.json` — targets Node with ESM output, strict mode on:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true
  }
}
```

#### 4. Client package

**File**: `client/package.json`
```json
{
  "name": "@wordfetti/client",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@wordfetti/shared": "workspace:*",
    "react": "^18.0.0",
    "react-dom": "^18.0.0",
    "react-router-dom": "^6.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.0.0",
    "@types/react-dom": "^18.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "autoprefixer": "^10.0.0",
    "postcss": "^8.0.0",
    "tailwindcss": "^3.0.0",
    "typescript": "^5.0.0",
    "vite": "^5.0.0"
  }
}
```

**File**: `client/vite.config.ts`
```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': process.env.VITE_API_URL ?? 'http://localhost:3000',
    },
  },
})
```

**File**: `client/tailwind.config.ts`
```typescript
import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
} satisfies Config
```

**File**: `client/postcss.config.js`
```js
export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
}
```

#### 5. Docker

**File**: `Dockerfile`
```dockerfile
FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

FROM base AS deps
WORKDIR /app
COPY pnpm-workspace.yaml package.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build
# Produce a self-contained server deploy directory with workspace deps inlined
RUN pnpm --filter @wordfetti/server deploy --prod /app/deploy

FROM node:20-slim AS runtime
WORKDIR /app
COPY --from=build /app/deploy ./server
COPY --from=build /app/client/dist ./public
ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>process.exit(r.statusCode===200?0:1))"
CMD ["node", "server/dist/index.js"]
```

**File**: `.env.example`
```
PORT=3000
NODE_ENV=development
CORS_ORIGIN=http://localhost:5173
```

**File**: `docker-compose.yml`
```yaml
services:
  app:
    build: .
    ports:
      - "3000:3000"
    env_file: .env
```

### Success Criteria

#### Automated Verification:
- [x] `pnpm install` completes without errors
- [x] `pnpm build` completes without errors
- [ ] `docker build -t wordfetti .` succeeds

#### Manual Verification:
- [ ] `pnpm dev` starts both client (port 5173) and server (port 3000) concurrently

---

## Phase 2: Game Store

### Overview

Define the `GameStore` interface and `InMemoryGameStore` implementation, along with join code generation. No API or UI yet — this phase is complete when the store unit tests pass.

### Changes Required

#### 1. Shared Game type

**File**: `shared/src/types.ts`
```typescript
export type Game = {
  id: string;
  joinCode: string;
  status: 'lobby' | 'in_progress' | 'finished';
};
```

#### 2. GameStore interface

**File**: `server/src/store/GameStore.ts`
```typescript
import type { Game } from '@wordfetti/shared'

export interface GameStore {
  createGame(): Promise<Game>;
  getGameByJoinCode(joinCode: string): Promise<Game | null>;
}
```

#### 3. Join code generation

**File**: `server/src/store/joinCode.ts`
```typescript
import { randomInt } from 'crypto'

// Excludes visually ambiguous characters: 0, O, 1, I, L
const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateJoinCode(): string {
  return Array.from(
    { length: 6 },
    () => CHARS[randomInt(CHARS.length)]
  ).join('');
}
```

#### 4. InMemoryGameStore

**File**: `server/src/store/InMemoryGameStore.ts`
```typescript
import { randomUUID } from 'crypto'
import type { Game } from '@wordfetti/shared'
import type { GameStore } from './GameStore'
import { generateJoinCode } from './joinCode'

const MAX_JOIN_CODE_ATTEMPTS = 10;

export class InMemoryGameStore implements GameStore {
  private readonly games = new Map<string, Game>();

  async createGame(): Promise<Game> {
    let joinCode: string;
    let attempts = 0;
    do {
      if (attempts >= MAX_JOIN_CODE_ATTEMPTS) {
        throw new Error('Failed to generate a unique join code');
      }
      joinCode = generateJoinCode();
      attempts++;
    } while (this.games.has(joinCode));

    const game: Game = {
      id: randomUUID(),
      joinCode,
      status: 'lobby',
    };
    this.games.set(joinCode, game);
    return game;
  }

  async getGameByJoinCode(joinCode: string): Promise<Game | null> {
    return this.games.get(joinCode) ?? null;
  }
}
```

#### 5. Unit tests

**File**: `server/src/store/InMemoryGameStore.test.ts`
```typescript
import { describe, it, expect } from 'vitest'
import { InMemoryGameStore } from './InMemoryGameStore'

describe('InMemoryGameStore', () => {
  it('creates a game with a 6-character join code using only valid characters', async () => {
    const store = new InMemoryGameStore()
    const game = await store.createGame()
    expect(game.joinCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/)
  })

  it('join code never contains ambiguous characters', async () => {
    const store = new InMemoryGameStore()
    for (let i = 0; i < 50; i++) {
      const game = await store.createGame()
      expect(game.joinCode).not.toMatch(/[01ILO]/)
    }
  })

  it('retrieves a game by join code', async () => {
    const store = new InMemoryGameStore()
    const created = await store.createGame()
    const found = await store.getGameByJoinCode(created.joinCode)
    expect(found).toEqual(created)
  })

  it('returns null for an unknown join code', async () => {
    const store = new InMemoryGameStore()
    const found = await store.getGameByJoinCode('XXXXXX')
    expect(found).toBeNull()
  })
})
```

### Success Criteria

#### Automated Verification:
- [x] `pnpm test` — all store tests pass

---

## Phase 3: Create Game API Endpoint

### Overview

Expose `POST /api/games` via Express. Wire up the `InMemoryGameStore` as a singleton and mount the route.

### Changes Required

#### 1. Games router

**File**: `server/src/routes/games.ts`
```typescript
import { Router } from 'express'
import type { GameStore } from '../store/GameStore'

export function createGamesRouter(store: GameStore): Router {
  const router = Router()

  router.post('/', async (_req, res, next) => {
    try {
      const game = await store.createGame()
      res.set('Location', `/api/games/${game.joinCode}`)
      res.status(201).json({ joinCode: game.joinCode })
    } catch (err) {
      next(err)
    }
  })

  return router
}
```

#### 2. Express app entry point

**File**: `server/src/index.ts`
```typescript
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { InMemoryGameStore } from './store/InMemoryGameStore.js'
import { createGamesRouter } from './routes/games.js'

const app = express()
const store = new InMemoryGameStore()

const corsOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:5173'
app.use(helmet())
app.use(cors({ origin: corsOrigin }))
app.use(express.json())

const apiLimiter = rateLimit({ windowMs: 60_000, max: 20 })
app.use('/api', apiLimiter)
app.use('/api/games', createGamesRouter(store))

app.get('/health', (_req, res) => res.sendStatus(200))

// Serve static client in production
if (process.env.NODE_ENV === 'production') {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../../public')
  app.use(express.static(dir))
  app.get('*', (_req, res) => res.sendFile(join(dir, 'index.html')))
}

const PORT = process.env.PORT ?? 3000
app.listen(PORT, () => console.log(`Server running on port ${PORT}`))
```

#### 3. Route tests

**File**: `server/src/routes/games.test.ts`
```typescript
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createGamesRouter } from './games.js'
import type { GameStore } from '../store/GameStore.js'
import type { Game } from '@wordfetti/shared'

const mockStore = (overrides?: Partial<GameStore>): GameStore => ({
  createGame: async () => ({ id: 'test-id', joinCode: 'ABC123', status: 'lobby' } as Game),
  getGameByJoinCode: async () => null,
  ...overrides,
})

function buildApp(store: GameStore) {
  const app = express()
  app.use(express.json())
  app.use('/', createGamesRouter(store))
  return app
}

describe('POST /api/games', () => {
  it('returns 201 with a joinCode', async () => {
    const res = await request(buildApp(mockStore())).post('/')
    expect(res.status).toBe(201)
    expect(res.body).toHaveProperty('joinCode', 'ABC123')
  })

  it('returns 500 when the store throws', async () => {
    const failStore = mockStore({
      createGame: async () => { throw new Error('store error') },
    })
    const app = buildApp(failStore)
    // attach a simple error handler so Express returns 500 rather than hanging
    app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: 'internal server error' })
    })
    const res = await request(app).post('/')
    expect(res.status).toBe(500)
  })
})
```

### Success Criteria

#### Automated Verification:
- [x] `pnpm test` — all route tests pass
- [ ] `curl -X POST http://localhost:3000/api/games` returns `{"joinCode":"XXXXXX"}` with status 201

---

## Phase 4: Frontend — Home Page & Code Display

### Overview

Two pages wired up with React Router:
- `/` — home page with a single "Create Game" button
- `/game/:joinCode` — displays the join code prominently

### Changes Required

#### 1. App entry with router

**File**: `client/src/main.tsx`
```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { HomePage } from './pages/HomePage'
import { GameCodePage } from './pages/GameCodePage'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/game/:joinCode" element={<GameCodePage />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
)
```

**File**: `client/src/index.css`
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

#### 2. Home page

**File**: `client/src/pages/HomePage.tsx`
```tsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

export function HomePage() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleCreateGame() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/games', { method: 'POST' })
      if (!res.ok) throw new Error(`Unexpected response: ${res.status}`)
      const body = await res.json()
      if (typeof body.joinCode !== 'string' || body.joinCode.length === 0) {
        throw new Error('Invalid join code in response')
      }
      navigate(`/game/${body.joinCode}`)
    } catch (err) {
      console.error('Failed to create game:', err)
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6">
      <h1 className="text-4xl font-bold">Wordfetti</h1>
      <button
        onClick={handleCreateGame}
        disabled={loading}
        className="rounded-xl bg-indigo-600 px-8 py-4 text-xl font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
      >
        {loading ? 'Creating...' : 'Create Game'}
      </button>
      {error && <p role="alert" className="text-red-600">{error}</p>}
    </main>
  )
}
```

#### 3. Game code display page

**File**: `client/src/pages/GameCodePage.tsx`
```tsx
import { useParams } from 'react-router-dom'

export function GameCodePage() {
  const { joinCode } = useParams<{ joinCode: string }>()

  if (!joinCode) {
    return <main className="flex min-h-screen items-center justify-center"><p>Invalid game link.</p></main>
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6">
      <h1 className="text-2xl font-semibold text-gray-600">Game created!</h1>
      <figure aria-label={`Join code: ${joinCode}`}>
        <figcaption className="text-lg text-gray-500 text-center">Share this code with your players:</figcaption>
        <div className="rounded-2xl bg-gray-100 px-12 py-8 mt-2">
          <span className="font-mono text-6xl font-bold tracking-widest">
            {joinCode}
          </span>
        </div>
      </figure>
    </main>
  )
}
```

### Success Criteria

#### Automated Verification:
- [x] `pnpm --filter client build` completes without TypeScript errors

#### Manual Verification:
- [ ] Visit `http://localhost:5173` → see home page with "Create Game" button
- [ ] Click "Create Game" → redirected to `/game/XXXXXX` with the join code displayed in large text
- [ ] The join code is 6 characters, uppercase, easy to read
- [ ] Visiting `http://localhost:3000` in production Docker build serves the same UI

---

## Testing Strategy

### Unit Tests:
- `InMemoryGameStore` — join code format (exact charset), ambiguous char exclusion, retrieval, unknown code (Phase 2)
- `POST /api/games` route — 201 with joinCode, 500 forwarded from store error (Phase 3)

### Manual Testing Steps:
1. `pnpm dev` → visit `http://localhost:5173`
2. Click "Create Game" → confirm redirect to `/game/:joinCode`
3. Confirm code is 6 chars, no ambiguous characters (0, O, 1, I, L)
4. Confirm error message appears (with `role="alert"`) when the API is unreachable
5. `docker build -t wordfetti . && docker run -p 3000:3000 --env-file .env wordfetti` → confirm same flow on port 3000
6. `curl http://localhost:3000/health` → returns 200

## References

- Ticket: `meta/tickets/ENG-001-create-a-game.md`
- Epic plan: `meta/plans/2026-03-21-hat-game-epics.md`

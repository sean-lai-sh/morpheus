# Morpheus — agent instructions

**Locked product vision:** [GitHub issue #41](https://github.com/sean-lai-sh/morpheus/issues/41).

Implement #41 and its live slices (#39 Mini host, #29 enqueue, #37 Mini POST, #42 Grok worker, #40 live index vfs, #36 ops webhooks, #30 official-bot reply). **Do not** implement from May 2026 `agent-v1` issues, frozen GitHub **#26 / #31 / #33** bodies, Nia, Pi, self-bot, fat-job, or Mini homedir mount.

- Nia runtime was **deleted** in squash-merged PR [#24](https://github.com/sean-lai-sh/morpheus/pull/24) (`074022f` on `main`). `src/nia/` is gone. Mini boots with zero `NIA_*`. Do not restore it; do not write “soak then delete Nia” again.
- Grok does **not** poll `/v1/jobs` over the internet. Mini **POSTs** a thin job to `GROK_BOT_WEBHOOK_URL` (`Authorization: Bearer GROK_BOT_WEBHOOK_SECRET`). After `{ reply }`, Mini `message.reply`s. Incoming webhooks are [#36](https://github.com/sean-lai-sh/morpheus/issues/36) ops feed only.
- Host is Sean’s **Mac Mini**, outbound-only + Tailscale. AWS / Fly / public inbound is stale. See `docs/hosting.md`.
- In-repo stale-issue marker: `docs/issues/PARKED.md`. Owner close paste (GitHub mutate often 403s for Cursor): `docs/issues/38-owner-close-stale.md`.

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

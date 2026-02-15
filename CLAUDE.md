---
description: Use pnpm + tsx. Baileys requires Node.js (Bun's ws polyfill is incompatible).
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

This project uses **pnpm** for package management and **tsx** for running TypeScript (Node.js runtime).

- Use `pnpm install` instead of `npm install` or `yarn install` or `bun install`
- Use `pnpm run <script>` instead of `npm run <script>`
- Use `pnpm start` / `pnpm run dev` to run the app (uses tsx under the hood)
- Use `tsx <file>` instead of `node <file>` or `ts-node <file>` or `bun <file>`

> **Why not Bun?** Baileys depends on the `ws` package's `upgrade` event, which Bun doesn't implement ([oven-sh/bun#5951](https://github.com/oven-sh/bun/issues/5951)).

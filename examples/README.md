# Examples

This directory contains consumer-style examples for `@kumofire/jobs`.

## basic

A minimal pnpm project that installs the published package from npm.

```bash
cd examples/basic
pnpm install
pnpm start
```

## cloudflare

A minimal Cloudflare Worker product example using Hono, D1, and Cloudflare Queues.

```bash
cd examples/cloudflare
pnpm install
pnpm dev
```

See [cloudflare/README.md](cloudflare/README.md) for binding setup and the D1 migration step.

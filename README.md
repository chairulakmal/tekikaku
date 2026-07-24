# Tekikaku: Japan Qualified Invoice Generator for Shopify

This README is the front door to Tekikaku, a Shopify embedded app that generates Japan invoice-system-compliant qualified invoices (適格請求書) from orders. The single most important point: the app demonstrates modern Shopify platform integration (managed installation, token exchange, session tokens, HMAC-verified webhooks, Admin GraphQL) on top of a deliberately designed PostgreSQL schema with performance-conscious SQL, with a domain-correct Japanese consumption-tax engine as the deep dive. Contents: what and why, project status, the two headline signals, the tax engine, architecture and data model pointers, local development, roadmap, and license.

> **Disclaimer**: Tekikaku produces documents in the format required by Japan's qualified invoice system (インボイス制度, 2023). It is format-compliance tooling, not tax advice. Consult a tax professional (税理士) for filing decisions.

## What and why

Since October 2023, Japanese businesses claiming input tax credit need qualified invoices carrying the seller's registration number, per-rate (8%/10%) taxable totals and tax amounts, and a reduced-rate marker (※). Shopify does not generate these natively. Tekikaku ingests orders via webhooks and produces compliant invoice PDFs, including void-and-reissue corrections and refund credit notes (返還インボイス).

The imagined merchant is a Tokyo coffee roaster: beans at the 8% reduced rate, brewing gear at 10%, so mixed-rate orders are the norm. See [Goals and positioning](SPEC.md#goals-and-positioning) in the spec.

## Status

Pre-build: the [spec](SPEC.md) is complete and platform-verified (2026-07-24); implementation follows the [build sequence](SPEC.md#build-sequence-and-cut-line). Screenshots and a demo GIF land here at the demo-complete milestone.

## Headline signal 1: Shopify integration, the modern way

- Managed installation + token exchange: there is no OAuth redirect code in this app, by design. First load exchanges an App Bridge session token for an offline access token.
- Session-token authentication (`await shopify.idToken()`) verified in middleware on every API route.
- Webhooks (`orders/create`, `refunds/create`, `app/uninstalled`) are HMAC-verified, idempotent, and declared declaratively in `shopify.app.toml`.
- Minimal scopes: `read_orders` only. The app never writes to Shopify.
- Cost-aware Admin GraphQL (pinned `2026-07`) for backfilling pre-install orders.

Details and verified platform facts: [Shopify API surface](SPEC.md#shopify-api-surface) and [Platform verification results](SPEC.md#platform-verification-results-2026-07-24).

## Headline signal 2: PostgreSQL design and performant SQL

- Normalized schema with money as integer yen, per-rate totals stored at issue time, and invoice immutability (void + reissue, never mutate).
- Gap-free invoice numbering via a counter-row `UPDATE ... RETURNING` claimed inside the issue transaction (Postgres sequences leak gaps on rollback).
- Keyset pagination on the order list backed by a composite index, not `OFFSET`.
- Composite unique indexes backing `INSERT ... ON CONFLICT DO NOTHING` idempotent ingestion.
- `EXPLAIN ANALYZE` notes for the hottest queries live in the repo once implemented.

Details: [Data model sketch](SPEC.md#data-model-sketch) and [Query performance](SPEC.md#query-performance-the-performant-sql-evidence).

## The tax engine

Per-rate aggregation with exactly one rounding operation per tax rate per invoice (the merchant chooses the rounding method), reduced-rate line marking, partial-refund proration, and a full reissue audit trail. The engine is unit-tested against hand-computed fixtures. See [Feature list](SPEC.md#feature-list).

## Architecture and data model

See [ARCHITECTURE.md](ARCHITECTURE.md) for the system diagram, request/webhook/backfill flows, and the entity-relationship diagram. Stack: Cloudflare Workers + Hono, React 19 SPA on Polaris web components, Neon Postgres via Drizzle, R2 for PDFs. Everything runs on free tiers.

## Local development

Requires Node 24+, pnpm 11, Docker, and a Shopify Partner account with a Japan-configured development store. Cloudflare and Neon accounts are only needed to deploy; local dev runs entirely on your machine.

```sh
pnpm install
docker compose up -d            # Postgres 18 on localhost:5432
cp .env.example .env            # fill in SHOPIFY_API_KEY / VITE_SHOPIFY_API_KEY
cp .dev.vars.example .dev.vars  # fill in SHOPIFY_API_SECRET
pnpm db:generate                # SQL migrations from src/db/schema.ts (first run only)
pnpm db:migrate
pnpm dev                        # Vite dev server, Worker running in workerd
```

`shopify app config link` connects the app to your Partner account and fills in `client_id` in `shopify.app.toml`. The four CI checks run locally as `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test`.

## Limitations and roadmap

v1 is JPY-only and dev-store distributed. The honest deferred list (email delivery, consolidated invoices, multi-currency, order-edit reconciliation) is in [Explicitly deferred](SPEC.md#explicitly-deferred-documented-in-readme-as-roadmap).

## License

MIT. The app is unlisted by construction: custom distribution means install links only.

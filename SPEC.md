# MVP Spec: Japan Qualified Invoice Generator for Shopify (working name: Tekikaku)

This document is the v1 product spec for a Shopify embedded app that generates Japan invoice-system-compliant qualified invoices (適格請求書) from orders. The single most important point: this is a portfolio piece whose headline is Shopify platform mastery (managed install, token exchange, session tokens, HMAC webhooks, GraphQL) paired with demonstrable PostgreSQL experience: deliberate database design and performant SQL (normalized schema, index-conscious queries, keyset pagination) that an interviewer can probe, with a domain-correct tax engine as the second act, scoped to roughly three weekends with an explicit two-weekend cut line. Contents: goals and positioning, feature list (v1 vs deferred), data model, Shopify API surface, demo script, README outline, top risks, build sequence, engineering conventions and CI (including commenting and component-architecture rules), platform verification results, and dependency pins.

## Table of contents

- [Goals and positioning](#goals-and-positioning)
- [Imagined merchant](#imagined-merchant)
- [Feature list](#feature-list)
- [Data model sketch](#data-model-sketch)
  - [Invoice numbering transactional boundary (decided 2026-07-25)](#invoice-numbering-transactional-boundary-decided-2026-07-25)
- [Shopify API surface](#shopify-api-surface)
- [Demo script (60 seconds)](#demo-script-60-seconds)
- [README outline](#readme-outline)
- [Top 5 risks and mitigations](#top-5-risks-and-mitigations)
- [Build sequence and cut line](#build-sequence-and-cut-line)
- [Engineering conventions and CI (verified 2026-07-24)](#engineering-conventions-and-ci-verified-2026-07-24)
- [Platform verification results (2026-07-24)](#platform-verification-results-2026-07-24)
- [Dependency pins (verified 2026-07-24)](#dependency-pins-verified-2026-07-24)

## Goals and positioning

- Primary: Tokyo job-hunt portfolio piece. Headline hiring signal is twofold: Shopify platform integration done the modern way (managed installation + token exchange, App Bridge session tokens, HMAC-verified webhooks, minimal scopes, Admin GraphQL), and PostgreSQL database design with performant SQL (the requirement Tokyo employers list by name): a normalized schema, deliberate indexes, and query patterns defended in the README. The tax engine (per-rate aggregation, invoice-system rounding, immutable numbering, reissue audit trail) is the deep-dive story an interviewer discovers.
- Secondary: genuinely useful to a real Japanese merchant. Positioned as compliant-format document generation, explicitly not tax advice; README carries a disclaimer and cites the NTA's required-items list for 適格請求書.
- Constraints: $0 budget (Workers free tier, Neon free tier, R2 free tier), custom app on a development store, no OAuth redirect dance, D1 escape hatch preserved (no Postgres-only features).

## Imagined merchant

A Tokyo coffee roaster selling online: beans and drip bags (8% reduced rate 軽減税率) plus brewing gear and mugs (10% standard rate), with café and office customers who need qualified invoices for input tax credit. Mixed-rate orders are the norm, so the per-rate breakdown is visible in every demo. B2B buyers justify proactive invoice generation on order creation.

## Feature list

### v1

1. **Auth and install**: managed installation, token exchange for the offline access token (`shopify.auth.tokenExchange` in `@shopify/shopify-api` v13 with the `cf-worker` adapter), App Bridge via the CDN script (session tokens from `await shopify.idToken()`, auto-attached to fetches) verified on every API call in Hono middleware. No OAuth redirect code anywhere; the README explains why. The app must be created via Shopify CLI with custom distribution (not as an admin-created custom app) so that TOML-managed webhooks and CLI tooling work.
2. **Settings page**: seller registration number (登録番号, validated as `T` + 13 digits), seller name and address, invoice number prefix, rounding mode (round-down default, round-half-up and round-up selectable; the invoice system mandates one rounding operation per tax rate per invoice, but the method is the merchant's choice).
3. **Order ingestion**: `orders/create` and `refunds/create` webhooks, HMAC-verified, idempotent (dedupe on webhook event ID), storing a normalized snapshot (order header + line items with per-line tax rate).
4. **Order list UI**: embedded React SPA using Polaris web components (verified 2026-07: Polaris React is deprecated; the web-components library loaded from Shopify's CDN with `@shopify/polaris-types` for TypeScript is the current standard), listing orders with invoice status (未発行 / 発行済 / 無効 / 返還発行済), hydrated from the DB, with per-order detail view.
5. **Invoice generation**: per-rate aggregation (8% lines marked ※ as 軽減税率対象, 10% lines), rounding applied exactly once per rate, sequential immutable invoice numbers per shop, all NTA-required items on the document. PDF rendered on Workers with an embedded subset Japanese font, stored in R2, served via a session-token-authenticated download route.
6. **宛名 edit + reissue**: edit the recipient name (and optional note), void the original invoice, issue a replacement under a new sequential number, keep the full chain (`supersedes` link) visible in the UI as an audit trail.
7. **Refund credit notes (返還インボイス)**: full and partial refunds. Triggered by `refunds/create`; partial refunds prorate per line using Shopify's refund line items, producing a credit note PDF with negative amounts per rate and a reference to the original invoice number.
8. **Bulk backfill**: merchant selects a date range; a job row drives cron-tick batch processing that pages through past orders via Admin GraphQL and generates invoices, with progress shown in the UI. (Verified 2026-07: Cloudflare Queues gained a free tier in Feb 2026, 10,000 ops/day, so a queue is now an option; cron ticks remain the v1 choice for simplicity, but the README should state this as a choice rather than a platform constraint.)
9. **Bilingual UI (ja/en)**: lightweight key-based dictionary (no heavy i18n framework), default locale from the Shopify admin `locale` param, manual toggle in the app. Invoice PDFs are always Japanese.
10. **Uninstall hygiene**: `app/uninstalled` webhook marks the shop uninstalled and invalidates the stored token.

### Explicitly deferred (documented in README as roadmap)

- Emailing PDFs to buyers (deliverability setup, templates).
- Customer-facing download link on the order status page.
- Multi-currency: v1 is JPY-only and rejects non-JPY shops gracefully at install.
- Consolidated monthly invoices (合計請求書) across orders.
- Custom invoice templates, logo upload.
- `orders/updated` reconciliation (post-issue order edits surface as a warning only).
- Tax-exempt and out-of-scope transactions (非課税・不課税) beyond a line-level warning.
- POS and draft orders.

## Data model sketch

Portable by design: no JSONB, no Postgres-only features; sequences implemented as a counter row with `UPDATE ... RETURNING` (works on both Postgres and D1/SQLite). Money stored as integer yen.

- `shops`: id, shop_domain (unique), access_token, locale, installed_at, uninstalled_at.
- `settings`: shop_id (FK, unique), registration_number, seller_name, seller_address, invoice_prefix, rounding_mode.
- `invoice_counters`: shop_id (FK, unique), next_number. Incremented atomically at issue time.
- `orders`: id, shop_id, shopify_order_id (unique per shop), order_name, buyer_name, currency, total_amount, taxes_included (bool), placed_at, ingested_via (webhook | backfill).
- `order_lines`: id, order_id (FK), shopify_line_item_id, title, quantity, unit_price, tax_rate (basis points), is_reduced_rate (bool).
- `invoices`: id, shop_id, order_id (FK), number, doc_type (invoice | credit_note), status (issued | voided), recipient_name, issue_date, taxable_8, tax_8, taxable_10, tax_10, total, rounding_mode_used, supersedes_invoice_id (nullable FK, reissue chain), original_invoice_id (nullable FK, credit note → invoice), refund_shopify_id (nullable), r2_key, created_at, voided_at, void_reason.
- `webhook_events`: id, shop_id, topic, shopify_webhook_id (unique), payload_digest, received_at, processed_at. Idempotency and a nice debugging story.
- `backfill_jobs`: id, shop_id, status (pending | running | done | failed), date_from, date_to, graphql_cursor, orders_seen, invoices_created, last_tick_at, error.

Interview-ready details baked in: invoice immutability (voiding, never mutating), per-rate columns instead of a JSON blob (portability + queryability), counter-row numbering (gap-free when claimed inside the issue transaction, see [the numbering boundary](#invoice-numbering-transactional-boundary-decided-2026-07-25); Postgres sequences leak gaps on rollback).

### Query performance (the "performant SQL" evidence)

These are the concrete artifacts that back the PostgreSQL hiring claim; each should be visible in the schema file and mentioned in the README:

- Composite unique indexes on the hot lookups: `orders (shop_id, shopify_order_id)`, `invoices (shop_id, number)`, `webhook_events (shopify_webhook_id)` for idempotent ingestion via `INSERT ... ON CONFLICT DO NOTHING`.
- Order list uses keyset pagination on `(shop_id, placed_at, id)` backed by a composite index, not `OFFSET` (and the README says why: OFFSET degrades linearly and skews under concurrent inserts).
- Invoice status shown in the list via a single join against the latest non-voided invoice per order, not an N+1 per row; per-rate totals are computed once at issue time and stored, so list and detail views never re-aggregate line items.
- Counter increment is a single-statement `UPDATE invoice_counters SET next_number = next_number + 1 WHERE shop_id = ? RETURNING next_number`: atomic, no read-modify-write race, portable to D1. It runs inside the issue transaction (boundary below), which is what makes the numbering gap-free rather than merely race-free.
- A short "query notes" section in the repo with `EXPLAIN ANALYZE` output for the two hottest queries (order list page, backfill dedupe probe), which is exactly the artifact that turns "knows SQL" from a claim into evidence in an interview.

All of the above is standard SQL and stays inside the D1 escape hatch (composite indexes, ON CONFLICT, RETURNING, and keyset pagination all work on SQLite), with one recorded exception: the interactive transaction around invoice numbering, whose D1 degradation is documented in the boundary subsection below.

### Invoice numbering transactional boundary (decided 2026-07-25)

Gap-free numbering is a transactional property, not a statement-level one: the counter claim and the invoice INSERT must commit atomically, and the number must be known before the PDF renders because it appears on the document. The boundary is therefore explicit:

- The issue flow runs inside one interactive Postgres transaction (Neon websocket driver; the single-shot HTTP mode cannot hold a transaction open): claim the number via the counter `UPDATE ... RETURNING`, render the PDF, upload it to R2 under a key derived from the claimed number, INSERT the invoice row complete with `r2_key` and per-rate totals, COMMIT. The row is born complete, so the immutability rule holds with no post-insert `r2_key` write.
- A crash anywhere before COMMIT rolls back the claim: no gap. The worst case is an orphaned R2 object under a never-committed key, which is harmless and can be garbage-collected by comparing R2 keys against committed `r2_key` values.
- The transaction stays open across PDF render and R2 upload. Acceptable at this volume: the only contention is per-shop on the counter row, and invoice issuance per shop is effectively serial anyway.
- **D1 caveat, the one known weakening of the escape hatch**: D1 has no interactive transactions, and `batch()` cannot feed one statement's RETURNING into the next. Under D1 the claim and insert run as separate statements, so a crash between them leaks a number: numbering degrades from gap-free to race-free with detectable gaps (compare `next_number` against `MAX(number)` per shop). Recorded here rather than papered over; the README claim stays scoped to Postgres.

## Shopify API surface

- **Scopes**: `read_orders` only. The app never writes to Shopify, which makes the minimal-scope story trivial to defend. No `read_customers`: buyer name comes from the order payload.
- **Webhooks**: `orders/create`, `refunds/create`, `app/uninstalled`. Declared declaratively via `[[webhooks.subscriptions]]` in `shopify.app.toml` (verified 2026-07: works for CLI-created apps with custom distribution; admin-created custom apps cannot use TOML webhooks, which is why the app is CLI-created). Compliance webhooks are not required for non-App-Store apps; if added later, they go in `compliance_topics` in the same TOML block.
- **Admin GraphQL** (pinned to `2026-07`, the latest stable, accessible until mid-July 2027):
  - `orders` query with `lineItems { taxLines { rate, priceSet } }` for backfill pagination (cursor-based, respects cost-based rate limits with backoff between cron ticks).
  - Single `order(id:)` query as a fallback when a webhook payload lacks needed tax detail.
  - No mutations.
- **Auth**: token exchange (session token → offline access token) on first load; session token verification middleware on every `/api/*` route.

## Demo script (60 seconds)

Setup before recording: dev store with Japan tax settings and tax-included pricing, one mixed-rate order already ingested and invoiced, one refunded order with its credit note already generated, app open in a second tab.

1. **0-10s**: Open the embedded app from the Shopify admin. Point at the settings: 登録番号, rounding mode, language toggle (flip ja → en → ja in one second).
2. **10-25s**: Order list. The mixed-rate order shows 発行済. Open it: line items show 8% lines marked ※ and 10% lines, per-rate subtotals.
3. **25-40s**: Open the PDF. Call out the five NTA-required items: registration number, date, per-rate taxable totals and tax, ※ reduced-rate marker, recipient. This is the money shot.
4. **40-50s**: Fix a wrong 宛名: edit, reissue. The old invoice flips to 無効, the new one gets the next sequential number, the chain is visible.
5. **50-60s**: Show the refunded order's 返還インボイス referencing the original invoice number, then point at the backfill button ("and it can generate for every order placed before install"). Verbally: "orders arrive via HMAC-verified webhooks; there is no OAuth redirect code in this app, it uses managed installation with token exchange."

## README outline

1. Title, one-line description, badge row, 3 screenshots or a GIF (order list, PDF, reissue chain).
2. What and why: two sentences on the 2023 invoice system (インボイス制度) and who needs this. Disclaimer: format compliance, not tax advice.
3. **Headline section, Shopify integration**: managed installation + token exchange (why no OAuth dance), session-token-authenticated API, HMAC webhook verification, declarative webhook config, minimal scopes (`read_orders` only), cost-aware GraphQL backfill.
4. The tax engine: per-rate aggregation, one-rounding-per-rate rule, gap-free numbering, void-and-reissue immutability, partial-refund proration.
5. Architecture diagram: Workers + Hono, React SPA on Polaris web components, Neon Postgres via Drizzle (with the D1 portability argument stated), R2 for PDFs, cron for backfill.
6. Data model diagram plus the Postgres story: schema design decisions, index choices, keyset pagination, and the `EXPLAIN ANALYZE` notes for the hottest queries.
7. Local development and install-on-dev-store instructions.
8. Limitations and roadmap (the deferred list, honestly).
9. License: MIT (decided 2026-07-24; commercial cloning accepted as low-probability, the not-tax-advice disclaimer stays regardless of license). Note that the app itself is unlisted by construction: custom distribution means install links only, no public listing.

## Top 5 risks and mitigations

1. **CJK PDF generation on Workers**: large font files vs the 3 MB compressed script limit, and CPU time for font embedding vs the free plan's 10 ms CPU per invocation (both verified 2026-07). 10 ms is tight for PDF assembly, so the spike must measure real CPU time; if it exceeds the limit, options are moving generation into a Queues consumer (also 10 ms on free, so likely no help), the HTML-print fallback, or accepting the paid plan later. Mitigation: this is the weekend-1 go/no-go spike; pre-subset Noto Sans JP at build time (kana + 常用漢字 + Latin), load the font from R2 or static assets at runtime rather than bundling, and embed it with `subset: false`: pdf-lib's runtime subsetting silently drops CJK glyphs (Hopding/pdf-lib#1232), so subsetting must happen at build time only; measure CPU; fallback is a print-optimized HTML invoice view (browser print-to-PDF), which preserves the whole demo except the R2 story.
2. **Legal accuracy**: a compliance tool that gets the rules wrong is worse than none. Mitigation: scope claims to "NTA-required items, correct per-rate math"; unit-test the rounding engine against hand-computed fixtures (mixed carts, each rounding mode, refund proration); disclaimer everywhere; cite the NTA checklist in the README.
3. **Protected customer data access**: orders carry PII, and buyer name is Level 2 "protected customer fields" (verified 2026-07). A dev-store-only app is exempt from the review process but must still declare protected-data access and data-use reasons in the app's API access settings; undeclared/unapproved fields come back as `null` with an entry in the errors hash, and community threads report dev-store rough edges (403s despite draft access). Mitigation: declare Level 2 access at project start; design so the invoice still generates with a redacted buyer name if a field is unavailable.
4. **Scope overrun**: three features were kept full-fat against a two-weekend budget; the honest estimate is three weekends. Mitigation: the build sequence below front-loads the demo-critical path; credit notes and bulk backfill are last and each degrades gracefully into its downscoped form (full-refund-only credit notes; lazy per-order generation instead of batch backfill).
5. **Shopify tax-data quirks**: Japan stores use tax-included pricing, dev stores may have unconfigured taxes yielding empty `taxLines`, and webhook payloads may differ from GraphQL shapes. Mitigation: configure the dev store's Japan tax settings first, validate real payloads before building the engine, treat "no tax lines" as a blocking per-order warning rather than silently emitting a wrong invoice.

## Build sequence and cut line

- **Weekend 1**: PDF spike (go/no-go), auth (token exchange + session middleware), settings page, `orders/create` ingestion, minimal order list. End state: one order becomes one correct PDF.
- **Weekend 2**: tax engine hardening + unit tests, numbering, reissue flow, order detail UI, bilingual dictionary, README + demo recording. **This is the cut line: the app is demo-complete here.**
- **Weekend 3**: credit notes (full then partial), backfill job + cron + progress UI, polish.

## Engineering conventions and CI (verified 2026-07-24)

Production conventions for the repo, chosen against current (July 2026) ecosystem state. The guiding constraint: full type-aware linting is a hard requirement, which drives both the TypeScript pin (6.0.x) and the ESLint-over-Biome choice.

### Lint, format, typecheck

- **ESLint 10** with flat config (`eslint.config.js`), the only supported format since v10 removed eslintrc entirely. Node >= 20.19 required; we pin Node 24 LTS.
- **typescript-eslint v8** using ESLint's `defineConfig` helper (the style current official docs use), `parserOptions.projectService: true` for typed linting, presets `strictTypeChecked` + `stylisticTypeChecked`. Known caveat, accepted: strict presets are not semver-stable, so minor upgrades can surface new violations; fine for a solo repo, and worth mentioning in an interview.
- **Prettier 3.9** run as its own step (`prettier --check` in CI, `--write` locally), with `eslint-config-prettier` last in the ESLint config to disable conflicting rules. No `eslint-plugin-prettier` (slower, mixes formatting noise into lint output).
- **Biome, noted but not chosen**: credible fast alternative (v2.3, partial type inference, used in production at large shops), but it does not match full typescript-eslint type-aware rules, which is the requirement here. Good interview talking point.

### tsconfig (TypeScript 6.0)

Write every flag explicitly rather than relying on 6.0's new defaults (the toolchain: esbuild/Vite, Vitest, and Workers types all read tsconfig too): `target: "es2022"`, `module: "preserve"`, `moduleResolution: "bundler"`, `noEmit: true`, `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`, `verbatimModuleSyntax: true`, `isolatedModules: true`, `moduleDetection: "force"`, `esModuleInterop: true`, `skipLibCheck: true`, `erasableSyntaxOnly: true` (greenfield choice: bans enums/namespaces/parameter properties so all TS syntax is erasable), `exactOptionalPropertyTypes: true` (decided 2026-07-25: enabled per the greenfield optional-strict convention; if third-party types such as `@shopify/polaris-types` fight it, dropping it gets recorded here with a date and reason). TS 6.0 defaults `types` to `[]`, so the Workers types (`wrangler types` output) and any test globals must be listed explicitly. No `baseUrl`, no `node10` resolution (both removed in TS 7; staying off them keeps the 7.1 bump trivial).

### Commenting rules

Motivated by direct interview feedback (July 2026): comments were too noisy and there was no stated rule. The rule, stated once and enforced in review:

- **A comment must answer a question the code cannot.** Legitimate: domain constraints (e.g. "consumption tax rounds once per rate per invoice, NTA qualified-invoice requirements", cited where the rounding happens), invariants ("invoice rows are never mutated after issue; corrections happen via void + reissue"), non-obvious tradeoffs ("cron tick processes max 20 orders to stay under the 10 ms CPU budget"), and links to the SPEC section that decided something.
- **Banned**: narration ("loop over line items"), restating the signature, section banners, commented-out code (delete it, git remembers), and changelog-style notes ("updated to fix bug"). If a comment paraphrases the code, delete the comment; if the code needs the paraphrase, rename or extract until it doesn't.
- **TSDoc only at exported module boundaries** where types alone don't carry the contract, primarily the tax engine's public functions (units, rounding mode semantics, JPY-integer expectations). No TSDoc on internals.
- **TODOs must reference an issue** (`// TODO(#12): ...`); ESLint's built-in `no-warning-comments` flags bare TODO/FIXME.
- The tax engine is the showcase: its comments cite the specific invoice-system rule each block implements, which turns the densest code into the best-documented code for exactly the reader (an interviewer) who matters.

### Component architecture

Also motivated by the same feedback (pages not decomposed well). Shopify publishes no code-structure conventions (verified: the design guidelines cover UX only, and the official app template is flat route files with no component layer), so these are our rules, aligned with Shopify's design guidance where it exists:

- **Routes are thin.** A route/page component does data fetching (via a hook) and composition only; if a route contains non-trivial markup or local state beyond page-level concerns, extract a component.
- **Feature folders own their pieces**: `features/orders/`, `features/invoices/`, `features/settings/`, each containing its components, hooks (`useOrders`, `useInvoiceActions`), and tests colocated. Shared primitives live in `components/` only when used by two or more features. No cross-feature deep imports (the spirit of `@shopify/eslint-plugin`'s `strict-component-boundaries` rule, enforced by review since that plugin is ESLint-9-only).
- **Extraction is driven by responsibility, never line count**: a block earns its own component when it has its own state, its own data requirement, or a second call site. Presentational components receive data via props and never fetch.
- **Polaris web components are used directly** (`s-page`, `s-section`, `s-table`, ...) with `@shopify/polaris-types` supplying JSX types; no wrapper layer around them (matches the official template's practice; React 19 handles custom elements natively). Complex JSX expressions get extracted to named variables or components (borrowing the spirit of Shopify's `jsx-no-complex-expressions`).
- **Page structure follows Shopify's App Design Guidelines** (shopify.dev/docs/apps/design): content lives in cards/sections inside an `s-page`, one primary-styled action per card, one information density per page, navigation via App Bridge nav menu. These are Built for Shopify criteria, and following them is itself a portfolio signal.

### Shopify house style: considered, not adopted

`@shopify/eslint-plugin` v50 (April 2026 registry activity, May 2025 last release) is flat-config-ready and bundles typescript-eslint v8, but declares ESLint `^9.27` (no published ESLint 10 support), runs Prettier as an ESLint rule (conflicts with our separate-Prettier setup), and risks duplicate `@typescript-eslint` plugin registration against our strict presets. Shopify's own current app template uses none of the web-configs packages. Decision: stay on typescript-eslint strict presets + standalone Prettier, and borrow the plugin's best conventions (early returns, component boundaries, no complex JSX expressions) as written rules. Revisit if the plugin ships ESLint 10 support.

### CI (GitHub Actions, free tier)

One workflow on push/PR: checkout, `pnpm/action-setup`, `actions/setup-node` (Node 24, `cache: "pnpm"` keyed on the lockfile; never cache `node_modules`), `pnpm install --frozen-lockfile`, then four checks: `pnpm typecheck` (`wrangler types` then `tsc --noEmit` per project: app, worker, node configs), `eslint .`, `prettier --check .`, `vitest run` (with `@cloudflare/vitest-pool-workers` for Worker code). Package manager: pnpm 11, the prevailing choice for new TS projects in 2026 (npm would also be fine solo; pnpm chosen for speed and signal). Version pinning (decided 2026-07-25): the `packageManager` field in package.json is the pin of record; pnpm self-manages to the pinned version and `pnpm/action-setup` reads the same field in CI. Corepack is deliberately not used (never left experimental, removed from Node 25+ distributions); getting-started docs say "install pnpm 11" and nothing more. Commit-message conformance enforced in CI with a commitlint action using `@commitlint/config-conventional` rather than local husky hooks: fewer moving parts for a solo repo, and non-conforming commits fail visibly in the PR.

### Local development (decided 2026-07-25)

Postgres 18 runs locally in Docker (`compose.yaml`); Neon is production-only, so no cloud dependency is needed for local work. Migrations run via drizzle-kit against `DATABASE_URL`. The invoice-issue path needs an interactive transaction, which production gets from the Neon websocket driver ([numbering boundary](#invoice-numbering-transactional-boundary-decided-2026-07-25)); how the local worker reaches Docker Postgres (plain TCP `pg` driver under `nodejs_compat` vs Neon's local proxy image) is a weekend-1 decision, recorded here when made. Production secrets (`DATABASE_URL`, `SHOPIFY_API_SECRET`) exist only in `wrangler secret put` and the provider dashboards, never in files on disk. Deploys go through the config redirect written by `@cloudflare/vite-plugin` (verified 2026-07-25): `pnpm build` emits `dist/tekikaku/wrangler.json` plus `.wrangler/deploy/config.json`, and plain `wrangler deploy` follows the redirect, shipping the built Worker and SPA assets; root `wrangler.jsonc` stays the source config.

### Versioning and releases

- **Conventional Commits 1.0.0** for all commit messages (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`; `feat!:`/`BREAKING CHANGE:` for majors).
- **SemVer via release-please** (Google's GitHub Action `googleapis/release-please-action@v5`, which wraps the release-please 17.x CLI; action major verified 2026-07-25 after CI rejected the earlier `v17` claim, which conflated the two version lines): it parses conventional commits, maintains a running release PR, and merging that PR creates the git tag, GitHub Release, and CHANGELOG entry. Chosen over semantic-release (heavier config, publishes immediately with no checkpoint) and changesets (built for multi-package repos and teams) as the lowest-maintenance fit for a solo single-repo app on the Actions free tier.
- Semantics for an app (nothing is published to npm): the version tags mark deployable milestones; `feat` bumps minor, `fix` bumps patch, breaking data-model or API changes bump major.

### Documentation structure (SPEC.md is the source of truth)

One source of truth per fact; the other docs point, they don't restate:

- **SPEC.md** (this file): product scope, decisions with dates, verified platform facts, dependency pins. When reality diverges from the spec, the spec is updated in the same PR; a stale spec is treated as a bug.
- **README.md**: portfolio-facing. What/why, screenshots, the two headline signals (Shopify platform integration, PostgreSQL design), setup instructions, and links into SPEC.md for scope and decision history rather than repeating them.
- **ARCHITECTURE.md**: the system diagram, request/webhook/backfill flows, and data-model diagram, each section linking back to the spec section that decided it.
- All three follow the same doc contract: first paragraph states what the doc is, its most important point, and its contents; long docs carry a TOC kept in sync; prose is never hard-wrapped.

## Platform verification results (2026-07-24)

Every former "verify against shopify.dev" item was researched on 2026-07-24 against shopify.dev, developers.cloudflare.com, and official TypeScript announcements. Spec sections above already incorporate these facts.

- **Managed installation + token exchange**: still the recommended auth model for embedded apps. For a Workers backend, use `@shopify/shopify-api` v13 directly (the `shopify-app-js` framework packages are Remix/Express only) with the `cf-worker` runtime adapter and `shopify.auth.tokenExchange`.
- **Expiring offline access tokens**: required for new public apps since 2026-04-01 and for all public apps from 2027-01-01; custom-distribution apps are exempt. No action needed for v1, but token exchange is exactly the migration path Shopify prescribes, so this architecture is already compatible (good interview talking point).
- **App Bridge**: the CDN script (`cdn.shopify.com/shopifycloud/app-bridge.js`, evergreen) exposing the global `shopify` object is the recommended integration; session tokens via `await shopify.idToken()`, auto-attached to same-frame fetches. `@shopify/app-bridge-react` v4 is an optional React convenience layer. The old npm `@shopify/app-bridge` v3 is legacy; do not use.
- **Polaris**: Polaris React (`@shopify/polaris`, final major 13) is deprecated. Current standard is Polaris web components loaded from Shopify's CDN (`polaris.js`, evergreen) with TypeScript types from `@shopify/polaris-types`. This spec's UI is a React 19 SPA driving those web components (React 19 has first-class custom-element support).
- **TOML webhooks**: `[webhooks] api_version` plus `[[webhooks.subscriptions]]` with `topics` and `uri`; auto-synced during `shopify app dev`, applied by `shopify app deploy`. Works only for CLI-created apps (custom distribution included); admin-created custom apps cannot use it. Hence: this app is created via Shopify CLI.
- **Protected customer data**: dev-store-only apps skip the review but must still declare access and data-use reasons; buyer name/address is Level 2 "protected customer fields". Unapproved fields return `null` with an errors-hash entry. Known dev-store rough edges in community reports; the redacted-name fallback in the risks section covers this.
- **Admin API version**: pin `2026-07` (released 2026-07-01, accessible until 2027-07-16). Quarterly cadence and 12-month support unchanged.
- **Compliance webhooks**: mandatory only for App Store-distributed apps, so optional here. If added, declare via `compliance_topics` in `[[webhooks.subscriptions]]` (TOML-only; the GraphQL mutation cannot register them).
- **Cloudflare free plan**: 10 ms CPU per invocation (HTTP and cron), 100k requests/day, 3 MB compressed Worker size, 50 subrequests/request, 5 cron triggers per account. Queues gained a free tier in Feb 2026 (10k ops/day, 24 h retention), so cron-based backfill is a simplicity choice, not a constraint. R2 free: 10 GB storage, 1M Class A + 10M Class B ops/month, free egress. SPA serving via Workers static assets: `assets.directory`, `not_found_handling: "single-page-application"`, `run_worker_first: ["/api/*", "/webhooks/*"]` (webhooks must bypass the SPA fallback or HMAC deliveries would be swallowed).

### Still open (empirical or unconfirmed)

- PDF generation CPU time vs the 10 ms free-plan limit: only the weekend-1 spike answers this. Queues consumers get the same 10 ms on free, so the fallback remains the HTML print view (or a paid plan later).
- TypeScript 7 ecosystem gaps made the project pin TS 6.0.x instead. TS 7.0 went GA 2026-07-08 but ships no compiler API; typescript-eslint closed TS 7.0 support as "not planned" until the 7.1 API lands (~Oct 2026). Microsoft's `@typescript/typescript6` compat package (a `tsc6` binary re-exporting the 6.0 API) allows running TS 7's `tsc` alongside 6.0-API tooling, but the dual toolchain adds complexity for no portfolio gain; the single 6.0.x pin stands. Re-evaluate when TS 7.1 ships and typescript-eslint support follows.

## Dependency pins (verified 2026-07-24)

Latest majors as published on npm, with the reasoning where "latest" needed judgment:

| Package                                            | Pin                                                  | Note                                                                                                                                                                                                                      |
| -------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@shopify/shopify-api`                             | ^13.1.0                                              | `cf-worker` adapter, token exchange                                                                                                                                                                                       |
| App Bridge                                         | CDN script                                           | Evergreen, unversioned; optionally `@shopify/app-bridge-react` ^4.2                                                                                                                                                       |
| Polaris                                            | CDN web components + `@shopify/polaris-types` ^1.0.7 | Do not use deprecated `@shopify/polaris` v13 (types version verified 2026-07-25)                                                                                                                                          |
| `hono`                                             | ^4.12                                                |                                                                                                                                                                                                                           |
| `drizzle-orm` / `drizzle-kit`                      | 0.45.x / 0.31.x                                      | Pre-1.0; pin minor and review changelogs on bumps                                                                                                                                                                         |
| `@neondatabase/serverless`                         | ^1.1                                                 |                                                                                                                                                                                                                           |
| `react` / `react-dom`                              | ^19.2                                                | With `@types/react` 19.2.x                                                                                                                                                                                                |
| `pdf-lib` + `@pdf-lib/fontkit`                     | ^1.17 / ^1.1                                         | Dormant but stable; the spike validates or replaces it                                                                                                                                                                    |
| `wrangler`                                         | ^4.114                                               | No v5 exists; `@cloudflare/vite-plugin` declares a ^4.114 peer (2026-07-25)                                                                                                                                               |
| `vite`                                             | ^8                                                   |                                                                                                                                                                                                                           |
| `@cloudflare/vite-plugin` + `@vitejs/plugin-react` | ^1.47 / ^6.0                                         | Workers runtime in Vite dev/build/preview; one config drives SPA and Worker (verified 2026-07-25)                                                                                                                         |
| `vitest` + `@cloudflare/vitest-pool-workers`       | ^4.1 / 0.18.x                                        | Vitest 4 integration is the `cloudflareTest()` Vite plugin from the package root; the old `/config` `defineWorkersConfig` helper is removed (verified 2026-07-25). Tests transpile via esbuild, independent of the TS pin |
| `typescript`                                       | 6.0.x (6.0.3)                                        | See below                                                                                                                                                                                                                 |
| `eslint`                                           | ^10                                                  | Flat config only; Node >= 20.19                                                                                                                                                                                           |
| `typescript-eslint`                                | ^8.65                                                | Supports TS `<6.1.0` and ESLint 10                                                                                                                                                                                        |
| `prettier` + `eslint-config-prettier`              | ^3.9 / ^10                                           | Prettier runs as its own step                                                                                                                                                                                             |
| `@commitlint/config-conventional`                  | via CI action                                        | Bundled by `wagoid/commitlint-github-action@v6`; deliberately not an in-repo dependency (no local hooks), so no version pin exists here                                                                                   |
| release-please                                     | action v5                                            | Release PR, tags, CHANGELOG; action v5 wraps the release-please 17.x CLI (verified 2026-07-25)                                                                                                                            |

**TypeScript decision** (settled 2026-07-24): pin `typescript@6.0.x`, not 7. The deciding factor is type-aware linting in CI: typescript-eslint supports `>=4.8.4 <6.1.0` and cannot run against the Go-based TS 7 until the new compiler API ships in TS 7.1 (~Oct 2026). TS 6.0 is the final JS-based release and the official bridge to 7: identical language semantics, intact compiler API (so typescript-eslint, Vitest, and editor tooling all work today), and it enforces 7's deprecations, so the eventual bump to 7.1 is a version change, not a migration. Write the tsconfig to the bridge contract from day 1: `strict: true`, `moduleResolution: "bundler"`, ES2022+ target, no `baseUrl`, no `node10` resolution. Revisit the pin when TS 7.1 lands and typescript-eslint follows.

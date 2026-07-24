# Tekikaku (Shopify qualified invoice app)

- **[SPEC.md](SPEC.md) is the single source of truth**: scope, decisions with dates, verified platform facts, dependency pins. When reality diverges from the spec, fix the spec in the same PR; a stale spec is a bug. Never restate spec facts in other docs or comments, link to the section instead.
- [README.md](README.md) is portfolio-facing, [ARCHITECTURE.md](ARCHITECTURE.md) holds diagrams and flows; both point into SPEC.md.
- Engineering conventions (tsconfig, lint, commenting rules, component architecture, CI, commits) follow the `web-conventions` skill, mirrored in [SPEC.md](SPEC.md#engineering-conventions-and-ci-verified-2026-07-24) for public readers.
- Core invariants (integer-yen money, invoice immutability, the D1 escape hatch, the numbering transaction boundary) are defined in the [data model](SPEC.md#data-model-sketch); read that section before touching schema, money, or invoice-issue code.

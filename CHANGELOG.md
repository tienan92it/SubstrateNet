# Changelog

All notable changes to Substrate Net. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Pipeline refactor (RFC `docs/workflow-refactor.md`)

- **Pre-triage window dedupe** — embed-dedupe before triage LLM; mechanical drops audited.
- **Window briefs** — deterministic verbatim quotes + compressed narrative for triage/extract.
- **Project core pack** — shared evidence context for extract (README, decisions, entities).
- **Anchor gate** — drop isolated facts; cap **8 facts/window** by default.
- **Early fact dedupe** — collapse near-duplicates before cluster.
- **File analyze tiers** — `standard` profile analyzes entrypoints + high fan-in only; `deep`/`--full` analyzes all.
- **Config** — `ingest` and `analyze` sections in `~/.substrate-net/config.json`.
- Cluster thresholds tuned (`AUTO_ATTACH` 0.88) for fewer LLM cluster calls.
- **Setup planner (M6)** — `setup --plan-only` shows per-phase calls, tokens
  (in/out), OpenRouter cost, and wall time; session-filter-aware window counts;
  file-tier analyze estimates; embed dedupe excluded from LLM call totals.
- **Fused enrich (M5)** — standard profile runs two flash-first agents
  (`domainFuser`, `industryFuser`) instead of eight frontier enrich calls;
  `--full` / deep profile retains the legacy agent stack.
- **Batch clusterer (M7)** — ambiguous facts are decided in batched
  `clustererBatch` calls (`config.ingest.clusterBatch`, default on); planner
  divides cluster estimates by `batchSize`.
- **Profile matrix** — `deep` runner profile (incremental deep quality);
  `setup --profile lean|standard|deep`; `update --deep`; `SUBNET_PROFILE` env
  for ingest scripts; doctor shows `pipeline_audit` counters.

## [0.2.0] - Unreleased

### Workflow revamp

- **Unified commands** — `subnet update` is the new day-to-day command
  (incremental `sync` + `ingest` + global `link` + dashboards). `subnet doctor`
  reports health and repairs common gaps. `subnet watch` keeps the graph fresh
  from transcript/code changes. `subnet global link|dashboard|profile|skills`
  groups cross-project operations.
- **Speed profiles** — `--fast` (transcript-only, skips analyze + enrich),
  default (incremental), and `--full` (reprocess all windows).
- **Tiered flash-first config** — bulk agents (triage, extractors, clusterer,
  summarizer, fileAnalyzer) default to OpenRouter Gemini Flash; heavy reasoning
  (domain/architecture/industry modelers, linker, profileWriter) routes to the
  Cursor frontier backend with a flash fallback.
- **Faster clustering** — mechanical embedding auto-attach skips the LLM for
  high-confidence matches; cluster decisions run in parallel waves; stable
  concepts skip re-summarization.
- **Unified window extractor** — one agent call per window replaces up to five
  per-kind extractor calls; batched triage + source classification.
- **Incremental enrich** — the domain enrichment stack is skipped when its
  inputs are unchanged since the last run.
- **Multi-project setup fix** — setup now links every project into the global
  brain and builds the global dashboard (previously only the first project).
- **Automation** — `subnet watch` daemon plus Cursor hook + launchd/cron
  templates under `templates/`. See `docs/automation.html`.
- **Interactive menu** — running `subnet` with no arguments in a terminal opens
  a menu-driven flow (update, add projects, health, dashboards, insights, watch
  status) built on `@clack/prompts`; non-TTY invocations print help. The CLI help
  surface is now six essentials (`setup`, `update`, `doctor`, `global`, `watch`,
  `serve`); per-stage/maintenance commands still work but are hidden. Shared
  service layer under `src/app/` backs both the CLI and the menu.

### Deprecated — removal scheduled for 0.3.0

These commands still work but print a stderr warning pointing to the replacement:

- `subnet ingest`, `subnet sync` (+ manual chain) → `subnet update`
- `subnet enrich`, `subnet analyze` → folded into `subnet update`
- `subnet link` → `subnet global link`
- `subnet dashboard --global` → `subnet global dashboard`
- `subnet profile` → `subnet global profile`
- `subnet skills` → `subnet global skills`

## [Unreleased]

### Added — Hybrid code graph + interactive dashboard

Inspired by Understand-Anything's tree-sitter + LLM hybrid. The parser already
resolved imports/defs/calls; now LLM agents read that structure to add a
semantic overlay, a portfolio synthesis, and a shareable dashboard.

- **Code analysis (L0.5)** — `subnet analyze [--full]` runs the FileAnalyzer
  agent per file (batched, incremental via `content_hash`) over its
  tree-sitter defs/imports/call-sites + a source slice, producing a summary,
  architectural layer (`api|service|data|ui|utility|other`), tags, and language
  concepts. Stored in `code.db.file_analysis`. Also runs inside `ingest`
  (`--no-analyze` to skip). MCP: `subnet_analyze`.
- **ArchitectureAnalyzer** — reconciles per-file layers into a coherent
  per-directory architecture; backfills files left as `other`.
- **DomainAnalyzer** — fuses technical skills + architectural layers +
  classified industry + salient facts into evidence-cited `domain_highlight`
  statements ("event-driven Go backend for a financial trading platform"),
  not bare "knows Go". New `KNodeKind: domain_highlight`; exported to
  `global.db.highlights`.
- **ProfileWriter** — `subnet profile --prose [--out path]` (and
  `subnet_profile {prose}`) generates portfolio/background markdown from the
  global skill graph + highlights, respecting each input's grounding tier
  (demonstrated vs. hedged). Global agents cache in a new `global.db.agent_runs`.
- **Interactive dashboard** — `subnet dashboard [--open]` exports a bounded
  file-level graph (nodes colored by layer), domains, concepts, and a search
  index from SQLite, and emits a single self-contained `index.html` (graph
  inlined, opens offline) plus a shareable `graph.json`. SPA is a Vite + React +
  react-force-graph build under `dashboard/` (`npm run build:dashboard`).

### Fixed

- **API key resolution** — backends now accept an inline `apiKey` field in
  addition to `apiKeyEnv` (env-var name), and guard against a raw key pasted
  into `apiKeyEnv`. Previously a misplaced key silently failed every
  OpenAI-compatible agent with "requires apiKey".
- **Nested manifests** — the manifest parser now walks the project
  (depth-limited, skipping `node_modules` / `build` / `.dart_tool` / …) instead
  of reading the root only. Monorepos (e.g. a Flutter app + a web frontend in
  one repo) now contribute all of their dependencies and tooling.
- **Industry classification ungated** — the IndustryClassifier now reads the
  full available picture (package metadata, dependencies, code symbols, README,
  entities, rules) and no longer early-returns "unclassified" when there's no
  SQL schema or business rules. Frontend / library / data projects classify
  from their stack and naming.

### Added — Second brain (L2.5 + L5)

Turns Substrate Net from a fact store into a business-domain graph and a cross-project
skill graph. Knowledge is tagged on two axes — `scope` (`technical` | `industry`
| `meta`) and `grounding` (`structural` | `stated` | `corroborated` | `external`
| `model`) — and every enriched node carries an evidence citation; nothing is
fabricated.

- **Skill graph (L5)** — `subnet skills` / `subnet profile` / `subnet learn`
  aggregate per-project technical and industry evidence into weighted skills in
  `~/.substrate-net/global.db`, with cross-project counts. `subnet link` synthesizes
  it. MCP: `subnet_skills`, `subnet_profile`, `subnet_learn`.
- **Technical profile** (`agents/technical-profiler.ts`) — synthesizes higher-
  level skills from languages + declared dependencies (manifests).
- **Manifest / infra parser** (`pipeline/manifests.ts`) — deterministic
  `dependency` and `tool` facts across npm, pip, poetry, Go, Cargo, pubspec,
  composer, Gemfile, Maven, Gradle, csproj, plus Docker / CI / k8s detection.
- **Entity reconciliation** (`pipeline/reconcile.ts`) — matches stated entities
  to structural code entities by normalized name, links them `same_as`, and
  upgrades grounding to `corroborated`.
- **Industry classification + enrichment** — IndustryClassifier names the
  business domain; IndustryEnricher proposes industry-standard concepts as
  `model` / `external` learning targets (never confused with project truth).
- **Scope × grounding** — `scope` and `grounding` columns on `k_nodes` and
  `concepts` (additive migrations); `subnet status` breaks counts down by both.
- **Incremental control** — `subnet ingest --reprocess` re-runs the pipeline
  over all existing windows; `--no-enrich` skips the L2.5 pass.
- **Cleanup** — `subnet clean` removes project data locally and/or globally
  (`--local-only` / `--global-only` / `--all`) and re-aggregates the skill graph.

### Added — Domain enrichment (L2.5)

Every enriched node and edge carries a `grounding` tier (`stated` |
`structural` | `corroborated`) and an evidence citation.

- **Grounding model** — new `grounding` column on `k_nodes` (additive migration
  for existing DBs); makes "based on facts, never assume" queryable.
- **Structural extraction** (`pipeline/domain-from-code.ts`) — deterministic,
  zero-assumption: SQL tables → `entity` facts, foreign keys → `relates_to`
  edges. Entities are identified by table name, collapsing schema-qualified
  definitions with unqualified FK stubs into one node.
- **DomainModeler agent** (`agents/domain-modeler.ts`) — proposes relationships
  between existing entities and names knowledge gaps; every claim must quote
  verbatim evidence or it is dropped in postprocess. Cannot invent entities.
- **Gap detector** (`pipeline/gap-detector.ts`) — deterministic, evidence-cited
  `knowledge_gap` nodes: external FK targets and ungoverned central entities.
  Names the gap, never the answer.
- **Pipeline** — `runEnrichment` runs as ingest step 8 and standalone via
  `subnet enrich [--no-agent]`.
- **MCP** — `subnet_domain_model`, `subnet_gaps`, `subnet_enrich`.
- **Status** — `subnet status` now reports L2.5 entities / relationships / gaps.
- New node kinds: `actor`, `process`, `metric`, `glossary_term`, `knowledge_gap`.
  New edge kinds: `relates_to`, `has_state`, `transitions_to`, `governed_by`,
  `owned_by`, `part_of`, `gap_in`.

## [0.1.0] — 2026-05-28

Initial cut. Layered local knowledge graph end-to-end: L0 code → L1
conversations → L1.5 triage → L2 facts → L3 concepts → L4 cross-project
links. All storage local SQLite, all semantic decisions agent-driven via
a single `AgentRuntime` with cached, schema-validated outputs.

### Added

- **L0 code indexer** (tree-sitter / regex)
  - tree-sitter: TypeScript, JavaScript, TSX, JSX, Python, Dart, Go, Rust, Java, C#
  - regex DDL parser: SQL (`.sql`, `.ddl`) — tables, columns, foreign keys, views,
    indexes, functions, sequences, schemas
  - cross-symbol resolver: unresolved call sites collapse into `calls` edges
    when a unique name match exists
- **L1 conversation adapters**
  - Cursor (`~/.cursor/projects/<slug>/agent-transcripts/`)
  - Claude Code (`~/.claude/projects/<slug>/*.jsonl`)
  - Codex CLI (`~/.codex/sessions/`, filtered by `cwd` metadata)
  - Copilot Chat (VS Code workspace storage, best-effort)
  - incremental ingest via per-session byte offset
- **L1.5 Triage Agent** — labels each turn-window on four axes (relevance,
  domain, quality, linkage); drops noise with confidence-gated rules
- **Dedupe Agent** — embedding-based near-duplicate detection on windows
  and on facts; runs via Ollama embeddings or any OpenAI-compatible backend
- **L2 Extractor Agents** — Decision, BusinessLogic, Intent, ProblemSolution.
  Routed by triage domain; each emits typed facts (`decision`, `business_rule`,
  `intent`, `problem`, `solution`, `constraint`, `pattern`, `entity`) with
  provenance back to turns and bridges to L0 nodes via `k_to_code`
- **L3 Clusterer + Summarizer Agents** — incremental cluster assignment
  (attach / create / merge) with centroid embeddings; concept names and
  short structured summaries assigned by the Summarizer
- **L4 cross-project** — global registry in `~/.substrate-net/global.db`;
  mechanical pass (exact-name + domain agreement) plus Linker Agent for
  semantic similarity across projects
- **Verifier Agent** — pairwise contradiction / supersession detection
  within clusters; low-confidence orphan pruning; stale-triage cache
  invalidation
- **MCP server** (`subnet serve --mcp`) — 14 tools spanning code (search,
  context, node, status) and knowledge (recall, decisions, business_logic,
  concepts, explain, link, triage_audit, verify, ingest, sync)
- **Cursor Canvases** — `triage-audit`, `project-map`, `decision-timeline`,
  `business-logic`, `cross-project-bridge`; each generated as a
  self-contained `.canvas.tsx` with an inlined data snapshot
- **CLI** — `init`, `sync`, `ingest`, `status`, `serve`, `agents (list|eval|run)`,
  `canvas`, `link`, `triage audit`, `verify`
- **Tests** — 59 unit + golden-fixture tests, all passing

### Design rules

- Syntax is deterministic. Meaning is agent-driven. No
  `if (text.includes("decided"))` anywhere — every semantic decision flows
  through a named agent with a versioned prompt + JSON schema, cached and
  audited via `agent_runs`.
- Code DB stays schema-compatible with [codegraph](https://github.com/colbymchenry/codegraph).
- Local-first. Default LLM backend is Ollama; OpenAI-compatible and Anthropic
  backends are pluggable per agent.

[Unreleased]: https://github.com/tienan92it/SubstrateNet/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/tienan92it/SubstrateNet/releases/tag/v0.1.0

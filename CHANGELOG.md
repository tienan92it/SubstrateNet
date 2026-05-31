# Changelog

All notable changes to CodeGps. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

Turns CodeGps from a fact store into a business-domain graph and a cross-project
skill graph. Knowledge is tagged on two axes — `scope` (`technical` | `industry`
| `meta`) and `grounding` (`structural` | `stated` | `corroborated` | `external`
| `model`) — and every enriched node carries an evidence citation; nothing is
fabricated.

- **Skill graph (L5)** — `codegps skills` / `codegps profile` / `codegps learn`
  aggregate per-project technical and industry evidence into weighted skills in
  `~/.codegps/global.db`, with cross-project counts. `codegps link` synthesizes
  it. MCP: `codegps_skills`, `codegps_profile`, `codegps_learn`.
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
  `concepts` (additive migrations); `codegps status` breaks counts down by both.
- **Incremental control** — `codegps ingest --reprocess` re-runs the pipeline
  over all existing windows; `--no-enrich` skips the L2.5 pass.
- **Cleanup** — `codegps clean` removes project data locally and/or globally
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
  `codegps enrich [--no-agent]`.
- **MCP** — `codegps_domain_model`, `codegps_gaps`, `codegps_enrich`.
- **Status** — `codegps status` now reports L2.5 entities / relationships / gaps.
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
- **L4 cross-project** — global registry in `~/.codegps/global.db`;
  mechanical pass (exact-name + domain agreement) plus Linker Agent for
  semantic similarity across projects
- **Verifier Agent** — pairwise contradiction / supersession detection
  within clusters; low-confidence orphan pruning; stale-triage cache
  invalidation
- **MCP server** (`codegps serve --mcp`) — 14 tools spanning code (search,
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

[Unreleased]: https://github.com/tienan92it/CodeGps/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/tienan92it/CodeGps/releases/tag/v0.1.0

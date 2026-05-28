# Changelog

All notable changes to CodeGps. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

<div align="center">

# Substrate Net

**Cross-project skills. One local view.**

[![CI](https://github.com/tienan92it/SubstrateNet/actions/workflows/ci.yml/badge.svg)](https://github.com/tienan92it/SubstrateNet/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-0.2.0-blue.svg)](./CHANGELOG.md)

**[Documentation →](https://tienan92it.github.io/SubstrateNet/)**

</div>

Substrate Net turns your code and AI agent conversations into a **cross-project
skill graph** you can query locally — skills, domain context, portfolio
highlights, and an interactive dashboard in one view.

An agent pipeline triages noise, extracts decisions and business rules,
clusters them into concepts, models the business domain, and aggregates what you
know across every registered project.

It follows a tree-sitter + LLM hybrid: the parser resolves the exact imports,
definitions, and call graph; the LLMs read that structure to produce summaries,
architectural layers, and business-domain knowledge — fewer tokens, fewer
hallucinations. An interactive local dashboard renders the whole graph from
SQLite.

The result is a queryable picture of your work along two axes: **technical**
(what the architecture objectively says) and **industry** (the business domain
your projects serve). Every node is tagged with its **grounding** — how it's
known — so project truth and inferred knowledge never blur together.

Everything is local. SQLite for storage. Ollama is the default LLM backend; any
OpenAI-compatible endpoint (OpenRouter, OpenAI, Together, Groq) works too.

## The dashboard

A self-contained, offline view built for humans. The global dashboard
(`subnet global dashboard`) opens on a **Profile** — your cross-project skills,
industries, and portfolio highlights — and a **Map** of
`industry → business domain → tech domain → project` you can drill into. Each
project also renders its own **knowledge graph** (domains → concepts/entities →
rules/skills); the file dependency graph stays in `graph.json` for agents.

<table>
  <tr>
    <td width="50%"><img src="docs/assets/dashboard-profile.png" alt="Profile view — cross-project skills, industries, and portfolio highlights"></td>
    <td width="50%"><img src="docs/assets/dashboard-map.png" alt="Map view — industry to domain to project knowledge graph"></td>
  </tr>
  <tr>
    <td align="center"><em>Profile — the second brain</em></td>
    <td align="center"><em>Map — cross-project knowledge graph</em></td>
  </tr>
</table>

---

## Quickstart

```bash
# 1. Install (Node 20+)
git clone https://github.com/tienan92it/SubstrateNet && cd SubstrateNet
npm install && npm run build:all && npm link   # exposes `subnet` on $PATH

# 2. Pick a backend. Flash-first by default (set OPENROUTER_API_KEY), or stay
#    fully local with Ollama (every agent falls back to local automatically):
ollama pull qwen3:4b-instruct
ollama pull qwen2.5:14b
ollama pull qwen3-embedding:0.6b

# 3. First run: discover workspaces → estimate → full pipeline
subnet setup

# 4. From then on: one command keeps everything fresh
subnet update            # all registered projects, incremental
```

Or just run `subnet` with no arguments for an **interactive menu** (update,
add projects, health, dashboards, insights) — the menu drives the same pipeline
the commands do.

Two commands cover almost everything when scripting:

- **`subnet setup`** — first-run wizard. Scans Cursor, Claude Code, Codex, and
  VS Code/Cursor workspace storage, lets you pick projects, shows a pre-flight
  cost/time estimate, then runs the full pipeline and builds the global dashboard.
- **`subnet update [path]`** — the day-to-day command. Incrementally re-syncs
  code, ingests new transcripts, re-links, and rebuilds dashboards.
  - `--fast` — **lean**: transcript-only (skips file analyze + enrich)
  - default — **standard**: tier-1 file analyze + fused enrich (2 LLM calls)
  - `--deep` — all pending files + legacy 8-agent enrich (incremental windows)
  - `--full` — **deep + reprocess** every window (after a model change)
  - `--global` — also rebuild the cross-project dashboard
- **`subnet setup --plan-only`** — per-phase cost table (calls, tokens in/out,
  est. $, wall time) before a first run

Health and cross-project views:

```bash
subnet doctor                 # health + pipeline audit counters; --fix repairs
subnet global dashboard --open  # cross-project hierarchy
subnet global profile           # industries + top skills
```

Keep it fresh automatically with a watch daemon, a Cursor hook, or a nightly
cron/launchd job — see the [automation guide](https://tienan92it.github.io/SubstrateNet/automation.html).

To make Substrate Net callable from your AI agents, see [MCP integration](#mcp-integration).

### Migrating from 0.1.x

The pipeline commands were unified in 0.2.0. The old commands still work but
print a deprecation warning and are scheduled for removal in **0.3.0**:

| 0.1.x | 0.2.0 |
|---|---|
| `subnet ingest` / `sync` + manual chain | `subnet update` |
| `subnet enrich`, `subnet analyze` | folded into `subnet update` |
| `subnet link` | `subnet global link` |
| `subnet dashboard --global` | `subnet global dashboard` |
| `subnet profile`, `subnet skills` | `subnet global profile` / `subnet global skills` |

---

## The model

Substrate Net splits "knowledge" into layers along the DIKW pyramid. Each layer is its
own SQLite table family; edges cross layers explicitly. **Syntax is
deterministic. Meaning is agent-driven.**

| Layer | Content | How it's produced |
|---|---|---|
| **L0** Code structure | symbols, calls, imports, fields, SQL tables | deterministic (tree-sitter / regex DDL) |
| **L0.5** Code analysis | per-file summaries, architectural layer, tags | tree-sitter structure → **agent** (FileAnalyzer · ArchitectureAnalyzer) |
| **L1** Conversations + docs + diagrams | sessions, turns, tool calls; in-repo docs (README / BRD / ADRs) and diagrams (mermaid / drawio / excalidraw / plantuml) | deterministic (file parsers + Docs/Diagrams adapters) |
| **L1.5** Triage | relevance / domain / quality / linkage / **activity** per window; **doc-kind** for source artifacts | **agents** (Triage · SourceClassifier) |
| **L2** Facts | decisions, business rules, intents, problems / solutions; BRD actors / processes / metrics; **incidents → root cause → resolution** | **agents** (Decision · BusinessLogic · Requirements · Intent · ProblemSolution · Incident) + syntax pass |
| **L2.5** Domain enrichment | dependencies, skills, entities, relationships, industry, components + lifecycles, gaps; cross-source **dedup + corroboration** | manifests + SQL (structural) · reconciler · fact-dedupe · **standard:** fused enrich (`domainFuser` + `industryFuser`) · **deep:** legacy 8-agent stack |
| **L2.6** Knowledge zones | business domains + tech domains, grouping facts by bounded context / capability | **agents** (BusinessDomainModeler · TechDomainModeler) |
| **L3** Concepts | clustered facts with names + structured summaries, scope-tagged | **agents** (Clusterer · Summarizer) |
| **L4** Cross-project | shared concepts, **workspace umbrellas**, emergent project links | mechanical (exact + SimHash + shared-signal clustering) + **agent** (Linker) |
| **L5** Global skill graph + hierarchy | technical + industry skills, and the workspace → industry → business → tech → project zone tree | mechanical aggregation over L2.5/L2.6 evidence |

The ingest pipeline **cleans and packages evidence before any LLM call**: session
filter → turn normalize → window briefs → pre-triage dedupe → triage/extract on
briefs → anchor gate → early fact dedupe → batch clusterer. See
[`docs/workflow-refactor.md`](docs/workflow-refactor.md) for the full RFC.

Agents run **tiered**: bulk work (triage, extractors, fused enrich, clusterer
batch) defaults to Gemini Flash via OpenRouter; heavy reasoning (linking,
portfolio prose, optional deep enrich) routes to a **Cursor SDK backend**
(`frontier`, set `CURSOR_API_KEY`). Every agent falls back to local Ollama
automatically when a backend is unavailable.

### Scope × grounding

Two tags keep objective fact separate from inference:

- **scope** — `technical` (architecture) · `industry` (business domain) · `meta`
- **grounding** — how the claim is known:

| Grounding | Meaning | Source |
|---|---|---|
| `structural` | objective, parsed from artifacts | code symbols, SQL schema, manifests |
| `stated` | asserted in a conversation | extracted facts |
| `corroborated` | stated **and** matched to a code entity | the Reconciler |
| `external` | cited from outside the project | research backend (opt-in) |
| `model` | the agent's own inference | enrichment agents |

Project-truth queries default to `structural` / `stated` / `corroborated`.
`external` and `model` are opt-in and always filterable — so "fill the gap"
knowledge never gets mistaken for "what your project actually does."

---

## CLI

Run `subnet` with no arguments in a terminal for the **interactive menu** (update,
add projects, health, dashboards, insights). In scripts or non-TTY environments,
use the essentials below. Per-stage commands still work but are hidden from
`--help` (see [migration](#migrating-from-01x)).

```
subnet setup [--projects ...] [--profile lean|standard|deep] [--plan-only] [--yes]
subnet update [path] [--fast|--deep|--full]   # day-to-day incremental refresh
subnet doctor [--fix]                   # health report + optional repair
subnet global link|dashboard|profile|skills
subnet watch [--foreground]             # background daemon (see automation guide)
subnet serve [path] --mcp               # MCP server over stdio
```

Hidden but still runnable for scripting: `init`, `sync`, `ingest`, `enrich`,
`analyze`, `link`, `dashboard`, `profile`, `skills`, `status`, `clean`, `canvas`,
`triage audit`, `agents`, `verify`, `learn`. Several print a deprecation warning
and are scheduled for removal in **0.3.0**.

`subnet global dashboard --open` opens the cross-project Profile + Map from
`~/.substrate-net/global.db`. Per-project dashboards are rebuilt by `subnet update`
(or the menu). Build the viewer bundle once: `npm run build:dashboard`
(or `npm run build:all`).

Full reference: [CLI docs](https://tienan92it.github.io/SubstrateNet/cli.html).

---

## MCP integration

A single MCP server exposes 25 tools — code (L0/L0.5), knowledge (L1.5–L3), domain
(L2.5), the global skill view (L4–L5), and a research surface
(`subnet_requirements`, `subnet_incidents`, `subnet_workspace`, `subnet_ask`) — over stdio:

```jsonc
// ~/.cursor/mcp.json  (or equivalent for Claude Code)
{
  "mcpServers": {
    "subnet": {
      "command": "subnet",
      "args": ["serve", ".", "--mcp"]
    }
  }
}
```

Primary tools: `subnet_context` (facts + code for a topic), `subnet_recall`
(semantic + FTS over conversations), `subnet_domain_model`, `subnet_gaps`,
`subnet_skills`, `subnet_profile`, `subnet_learn`, plus the research surface —
`subnet_ask` (grounded Q&A), `subnet_requirements`, `subnet_incidents` (RCA),
and `subnet_workspace` (umbrella + related projects). Full catalogue in the
[MCP docs](https://tienan92it.github.io/SubstrateNet/mcp.html).

---

## Configuration

Per-agent model selection lives in `~/.substrate-net/config.json` (auto-created on
first `setup` or `init`). Per-project overrides go in `<project>/.substrate-net/config.json` and
deep-merge over global.

```jsonc
{
  "concurrency": 8,
  "agentBackends": {
    "local":      { "kind": "ollama", "endpoint": "http://localhost:11434" },
    "openrouter": {
      "kind": "openai-compatible",
      "endpoint": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY"   // name of the env var holding the key
    }
  },
  "agents": {
    "triage":            { "model": "openrouter:google/gemini-2.5-flash" },
    "dedupe":            { "model": "local:nomic-embed-text" },
    "businessLogic":     { "model": "openrouter:anthropic/claude-sonnet-4", "fallback": "local:qwen2.5:14b" },
    "technicalProfiler": { "model": "openrouter:anthropic/claude-sonnet-4" },
    "industryClassifier":{ "model": "openrouter:anthropic/claude-sonnet-4" },
    "domainFuser":       { "model": "openrouter:google/gemini-3.5-flash" },
    "industryFuser":     { "model": "openrouter:google/gemini-3.5-flash" }
    // ... decision, clusterer, summarizer, linker, verifier, skillSynthesizer
  },
  "ingest": {
    "maxSessions": 200,
    "sinceDays": 365,
    "maxFactsPerWindow": 8,
    "preTriageDedupe": true,
    "clusterBatch": true
  },
  "analyze": {
    "tier": "standard",
    "maxFilesPerRun": 500
  }
}
```

See [`frontier.config.example.json`](./frontier.config.example.json) for a
full local-plus-frontier split.

> **API keys.** `apiKeyEnv` is the *name of an environment variable*, not the
> key itself — the backend reads `process.env[apiKeyEnv]`. To paste a key
> directly, use the `apiKey` field instead. Prefer `apiKeyEnv` to keep secrets
> out of the config file.

Bumping a model invalidates that agent's cache on the next run; old runs stay in
`agent_runs` for audit.

---

## Storage layout

```
<project>/.substrate-net/
├── code.db          # L0 — codegraph-compatible schema
├── knowledge.db     # L1–L3 + window_briefs + agent_runs cache
├── canvas/          # generated .canvas.tsx files
└── config.json      # per-project agent overrides

~/.substrate-net/
├── global.db        # L4 links + L5 skills / industries + project registry
└── config.json      # global defaults
```

All files are local SQLite. Conversation transcripts are read in-place from each
agent's home directory — never copied.

---

## Contributing

```bash
npm install
npm run build       # tsc + copy schemas / canvas templates
npm test            # unit + golden tests
npm run dev         # tsc --watch
```

Adding a language: add the extension to [`src/code/languages.ts`](src/code/languages.ts),
register handlers in [`src/code/extractor.ts`](src/code/extractor.ts), add a test
in [`__tests__/unit/code-extractor.test.ts`](__tests__/unit/code-extractor.test.ts).
~50 lines per language is typical.

Adding an agent: implement the `Agent<I, O>` interface in `src/agents/<name>.ts`,
register it via `src/agents/index.ts`, add a golden fixture under
`__tests__/agents/<name>/`, route it from the relevant pipeline file in
`src/pipeline/`. The runtime handles caching, schema validation, and persistence.

---

## License

MIT — see [LICENSE](./LICENSE).

## Acknowledgements

Inspired by [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph)
(the L0 schema is intentionally compatible), the
[Model Context Protocol](https://modelcontextprotocol.io/) for the agent ↔ tool
interface, and tree-sitter for cross-language code parsing.

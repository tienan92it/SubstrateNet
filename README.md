<div align="center">

# Substrate Net

**Cross-project knowledge, distilled to wisdom — fully local.**

[![CI](https://github.com/tienan92it/SubstrateNet/actions/workflows/ci.yml/badge.svg)](https://github.com/tienan92it/SubstrateNet/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-0.2.0-blue.svg)](./CHANGELOG.md)

**[Documentation →](https://tienan92it.github.io/SubstrateNet/)**

</div>

Substrate Net reads your code and AI-agent conversations and builds a grounded,
queryable picture of what you know across every project — organized as a **DIKW
pyramid** that ends in **Wisdom**: the competencies you've mastered, the insights
your work reveals, and the gaps worth closing next.

Everything runs locally on SQLite. A **tree-sitter + LLM hybrid** keeps it cheap
and honest: the parser resolves exact structure (imports, definitions, call
graph); the LLMs read that structure to produce meaning. Every claim carries a
**grounding** tag, so project truth and inference never blur.

## The idea: climb the DIKW pyramid

Read bottom-up. Each tier is built from the one below it.

| Tier | What it is | Built from |
|---|---|---|
| **Wisdom** | leveled competencies (novice → expert), cross-project insights, gaps to close | synthesis over everything below |
| **Knowledge** | concepts, business + tech domains, the cross-project skill graph | clustered and modeled facts |
| **Information** | decisions, rules, requirements, incidents — triaged and grounded | facts extracted from conversations + code |
| **Data** | your code, AI-agent transcripts, in-repo docs and diagrams | parsed in place, locally |

The payoff is a queryable view along two axes — **technical** (what the
architecture objectively says) and **industry** (the business domain your
projects serve) — surfaced through a local dashboard and an MCP server your
agents can call.

## The dashboard

A self-contained, offline view that organizes the knowledge base by **PARA**
(actionability) crossed with **DIKW** (distillation). `subnet global dashboard`
opens on a compact synthesized **wisdom hero** (headline + insights + gaps) over
four PARA sections, plus a **Map**:

- **Projects** — active work, classified from real session recency.
- **Areas** — ongoing competencies, graded by proficiency level (novice → expert).
- **Resources** — your knowledge library: subjects → topics → concepts/skills/domains, a calm hierarchical explorer (no graph hairball).
- **Archive** — inactive projects, kept for reference.
- **Map** — drill `industry → business domain → tech domain → project`, then into each project's own nested knowledge explorer (domains → concepts/entities → facts).

The PARA structure and Wisdom layer are produced by two reasoning agents
(`knowledgeOrganizer` then `wisdomSynthesizer`), each with a data-driven offline
fallback, and are grounded `model` — kept visibly separate from the
`structural`/`stated`/`corroborated` truth of your projects.

<table>
  <tr>
    <td width="50%"><img src="docs/assets/dashboard-profile.png" alt="Profile view — synthesized wisdom, competency map, insights, and gaps"></td>
    <td width="50%"><img src="docs/assets/dashboard-map.png" alt="Map view — industry to domain to project knowledge graph"></td>
  </tr>
  <tr>
    <td align="center"><em>Profile — PARA sections under a wisdom hero</em></td>
    <td align="center"><em>Map — cross-project knowledge hierarchy</em></td>
  </tr>
</table>

---

## Quickstart

```bash
# 1. Install (Node 20+)
git clone https://github.com/tienan92it/SubstrateNet && cd SubstrateNet
npm install && npm run build:all && npm link   # exposes `subnet` on $PATH

# 2. Pick a backend (optional). Flash-first when OPENROUTER_API_KEY is set;
#    otherwise fully local via Ollama — every agent falls back automatically.
ollama pull qwen2.5:14b
ollama pull nomic-embed-text

# 3. First run: discover workspaces → cost estimate → full pipeline → dashboard
subnet setup

# 4. From then on, one command keeps everything fresh
subnet update
```

Run `subnet` with no arguments for an **interactive menu** (update, add
projects, health, dashboards) — it drives the same pipeline the commands do.

## Commands

Two commands cover almost everything:

```bash
subnet setup            # first-run wizard: scan agents, pick projects, plan cost, run
subnet update [path]    # day-to-day incremental refresh (code + transcripts + dashboards)
```

`subnet update` selects how much work to do per run:

| Flag | Profile | Does |
|---|---|---|
| `--fast` | lean | transcript-only (skips file analyze + enrich) |
| _(none)_ | standard | tier-1 file analyze + fused enrich (2 LLM calls) |
| `--deep` | deep | all pending files + legacy 8-agent enrich |
| `--full` | deep + reprocess | re-runs every window (after a model change) |
| `--global` | — | also rebuild the cross-project dashboard + wisdom |

Health, cost, and cross-project views:

```bash
subnet setup --plan-only         # per-phase cost table (calls, tokens, $, time)
subnet doctor [--fix]            # health + pipeline audit counters; optional repair
subnet global dashboard --open   # DIKW profile (wisdom) + knowledge map
subnet global wisdom             # leveled competencies, insights, gaps (text)
subnet global profile | skills   # industries + top skills
```

Keep it fresh automatically with a watch daemon, a Cursor hook, or a nightly
cron/launchd job — see the [automation guide](https://tienan92it.github.io/SubstrateNet/automation.html).
Full command reference: [CLI docs](https://tienan92it.github.io/SubstrateNet/cli.html).

---

## The model

Each DIKW tier maps to a layer (or family) of SQLite tables; edges cross layers
explicitly. **Syntax is deterministic. Meaning is agent-driven.**

| Layer | Content | How it's produced |
|---|---|---|
| **L0** Code structure | symbols, calls, imports, fields, SQL tables | deterministic (tree-sitter / regex DDL) |
| **L0.5** Code analysis | per-file summaries, architectural layer, tags | structure → **agent** (FileAnalyzer · ArchitectureAnalyzer) |
| **L1** Conversations + docs + diagrams | sessions, turns, tool calls; in-repo docs (README / BRD / ADRs) and diagrams (mermaid / drawio / excalidraw / plantuml) | deterministic (file parsers + adapters) |
| **L1.5** Triage | relevance / domain / quality / linkage / activity per window; doc-kind for sources | **agents** (Triage · SourceClassifier) |
| **L2** Facts | decisions, business rules, intents, problems/solutions; BRD actors/processes/metrics; incidents → root cause → resolution | **agents** (Decision · BusinessLogic · Requirements · Intent · ProblemSolution · Incident) + syntax pass |
| **L2.5** Domain enrichment | dependencies, skills, entities, relationships, industry, components, gaps; cross-source dedup + corroboration | manifests + SQL · reconciler · **standard:** fused enrich · **deep:** 8-agent stack |
| **L2.6** Knowledge zones | business + tech domains, grouping facts by bounded context / capability | **agents** (BusinessDomainModeler · TechDomainModeler) |
| **L3** Concepts | clustered facts with names + structured summaries, scope-tagged | **agents** (Clusterer · Summarizer) |
| **L4** Cross-project | shared concepts, workspace umbrellas, emergent project links | mechanical (exact + SimHash) + **agent** (Linker) |
| **L5** Skill graph + hierarchy | technical + industry skills; the workspace → industry → business → tech → project tree | mechanical aggregation over L2.5/L2.6 |
| **L6** Wisdom | leveled competency areas (Dreyfus novice → expert), cross-project insights / principles, named gaps + recommendations | **agent** (WisdomSynthesizer) + deterministic fallback; grounded `model` |

The ingest pipeline **cleans and packages evidence before any LLM call**: session
filter → turn normalize → window briefs → pre-triage dedupe → triage/extract on
briefs → anchor gate → early fact dedupe → batch clusterer. This is what keeps a
first run cheap. See [`docs/workflow-refactor.md`](docs/workflow-refactor.md) for
the full RFC.

Agents run **tiered**: bulk work (triage, extractors, fused enrich, clusterer)
defaults to a cheap flash model via OpenRouter; heavy reasoning (linking, domain
modeling, wisdom synthesis) routes to a **Cursor SDK backend** (`frontier`, set
`CURSOR_API_KEY`). Every agent falls back to local Ollama automatically when a
backend is unavailable — so a zero-key, fully offline run always works.

### Grounding: keeping fact separate from inference

Two tags travel with every node. **scope** is `technical` · `industry` · `meta`.
**grounding** records *how* the claim is known:

| Grounding | Meaning | Source |
|---|---|---|
| `structural` | objective, parsed from artifacts | code symbols, SQL schema, manifests |
| `stated` | asserted in a conversation | extracted facts |
| `corroborated` | stated **and** matched to a code entity | the Reconciler |
| `external` | cited from outside the project | research backend (opt-in) |
| `model` | the agent's own inference | enrichment + wisdom agents |

Project-truth queries default to `structural` / `stated` / `corroborated`.
`external` and `model` are opt-in and always filterable — so inferred or
"fill-the-gap" knowledge never gets mistaken for what your project actually does.

---

## MCP integration

A single MCP server exposes 25 tools over stdio — code (L0/L0.5), knowledge
(L1.5–L3), domain (L2.5), the global skill view (L4–L5), and a research surface:

```jsonc
// ~/.cursor/mcp.json  (or equivalent for Claude Code)
{
  "mcpServers": {
    "subnet": { "command": "subnet", "args": ["serve", ".", "--mcp"] }
  }
}
```

Primary tools: `subnet_context` (facts + code for a topic), `subnet_recall`
(semantic + FTS over conversations), `subnet_domain_model`, `subnet_gaps`,
`subnet_skills`, `subnet_profile`, `subnet_learn`, plus `subnet_ask` (grounded
Q&A), `subnet_requirements`, `subnet_incidents` (RCA), and `subnet_workspace`.
Full catalogue in the [MCP docs](https://tienan92it.github.io/SubstrateNet/mcp.html).

---

## Configuration

Per-agent model selection lives in `~/.substrate-net/config.json` (auto-created
on first `setup`). Per-project overrides go in
`<project>/.substrate-net/config.json` and deep-merge over global.

```jsonc
{
  "agentBackends": {
    "local":      { "kind": "ollama", "endpoint": "http://localhost:11434" },
    "openrouter": { "kind": "openai-compatible", "endpoint": "https://openrouter.ai/api/v1",
                    "apiKeyEnv": "OPENROUTER_API_KEY" },
    "frontier":   { "kind": "cursor-agent", "apiKeyEnv": "CURSOR_API_KEY" }
  },
  "agents": {
    // bulk → cheap flash; reasoning → frontier; embeddings → local
    "triage":            { "model": "openrouter:google/gemini-2.5-flash", "fallback": "local:qwen2.5:14b" },
    "wisdomSynthesizer": { "model": "frontier:composer-2.5", "fallback": ["openrouter:google/gemini-3.5-flash", "local:qwen2.5:14b"] },
    "dedupe":            { "model": "local:nomic-embed-text" }
    // ... see frontier.config.example.json for the full split
  },
  "ingest": { "maxFactsPerWindow": 8, "preTriageDedupe": true, "clusterBatch": true },
  "analyze": { "tier": "standard" }
}
```

> **API keys.** `apiKeyEnv` is the *name of an environment variable*, not the key
> itself. Prefer it over the inline `apiKey` field to keep secrets out of the
> file. See [`frontier.config.example.json`](./frontier.config.example.json) for
> a full local-plus-frontier split.

Bumping a model invalidates that agent's cache on the next run; old runs stay in
`agent_runs` for audit.

## Storage layout

```
<project>/.substrate-net/
├── code.db          # L0 — codegraph-compatible schema
├── knowledge.db     # L1–L3 + window_briefs + agent_runs cache
└── config.json      # per-project agent overrides

~/.substrate-net/
├── global.db        # L4 links + L5 skills/hierarchy + L6 wisdom + registry
└── config.json      # global defaults
```

All files are local SQLite. Conversation transcripts are read in place from each
agent's home directory — never copied.

---

## Contributing

```bash
npm install
npm run build:all   # dashboard bundle + tsc + schemas
npm test            # unit + golden tests
```

- **Add a language:** register the extension in [`src/code/languages.ts`](src/code/languages.ts)
  and handlers in [`src/code/extractor.ts`](src/code/extractor.ts), with a test in
  [`__tests__/unit/code-extractor.test.ts`](__tests__/unit/code-extractor.test.ts). ~50 lines is typical.
- **Add an agent:** implement `Agent<I, O>` in `src/agents/<name>.ts`, register it
  in `src/agents/index.ts`, add a golden fixture under `__tests__/agents/<name>/`,
  and route it from the relevant `src/pipeline/` file. The runtime handles caching,
  schema validation, and persistence.

Migrating from 0.1.x: the per-stage commands (`ingest`, `enrich`, `analyze`,
`link`, …) still run but print a deprecation warning and are folded into
`subnet update` / `subnet global *`. They are scheduled for removal in **0.3.0**.

## License

MIT — see [LICENSE](./LICENSE).

## Acknowledgements

Inspired by [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph)
(the L0 schema is intentionally compatible), the
[Model Context Protocol](https://modelcontextprotocol.io/) for the agent ↔ tool
interface, and tree-sitter for cross-language code parsing.

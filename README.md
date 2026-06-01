<div align="center">

# Substrate Net

**A local second brain: a layered knowledge graph across your code and your AI agent conversations.**

[![CI](https://github.com/tienan92it/SubstrateNet/actions/workflows/ci.yml/badge.svg)](https://github.com/tienan92it/SubstrateNet/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](./CHANGELOG.md)

**[Documentation →](https://tienan92it.github.io/SubstrateNet/)**

</div>

Substrate Net indexes your code structure *and* the conversations you have with AI
coding agents (Cursor, Claude Code, Codex, Copilot) into one local knowledge
graph. An agent pipeline triages noise, extracts decisions and business rules,
clusters them into concepts, models the business domain, and aggregates what you
know into a cross-project skill graph.

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

---

## Quickstart

```bash
# 1. Install (Node 20+)
git clone https://github.com/tienan92it/SubstrateNet && cd SubstrateNet
npm install && npm run build && npm link        # exposes `subnet` on $PATH

# 2. Bring up a local LLM
ollama pull qwen3:4b-instruct                    # triage / classifier
ollama pull qwen2.5:14b                          # extractors / summarizer
ollama pull qwen3-embedding:0.6b                 # dedupe / clustering

# 3. Index a project
cd /path/to/your/project
subnet init                                     # creates .substrate-net/
subnet sync                                     # L0 — code structure
subnet ingest                                   # L1 → L3 + enrichment (L2.5)
subnet status                                   # see what landed in each layer

# 4. Aggregate the second brain across projects
subnet link                                     # L4 links + L5 skill graph
subnet profile                                  # industries + top skills
```

To make Substrate Net callable from your AI agents, see [MCP integration](#mcp-integration).

---

## The model

Substrate Net splits "knowledge" into layers along the DIKW pyramid. Each layer is its
own SQLite table family; edges cross layers explicitly. **Syntax is
deterministic. Meaning is agent-driven.**

| Layer | Content | How it's produced |
|---|---|---|
| **L0** Code structure | symbols, calls, imports, fields, SQL tables | deterministic (tree-sitter / regex DDL) |
| **L0.5** Code analysis | per-file summaries, architectural layer, tags | tree-sitter structure → **agent** (FileAnalyzer · ArchitectureAnalyzer) |
| **L1** Conversations | sessions, turns, tool calls | deterministic (file parsers) |
| **L1.5** Triage | relevance / domain / quality / linkage per window | **agent** (Triage) |
| **L2** Facts | decisions, business rules, intents, problems / solutions | **agents** (Decision · BusinessLogic · Intent · ProblemSolution) + syntax pass |
| **L2.5** Domain enrichment | dependencies, skills, entities, relationships, industry, gaps | manifests + SQL (structural) · reconciler · **agents** (TechnicalProfiler · DomainModeler · IndustryClassifier · IndustryEnricher) |
| **L3** Concepts | clustered facts with names + structured summaries, scope-tagged | **agents** (Clusterer · Summarizer) |
| **L4** Cross-project | shared concepts between repos | mechanical (exact + SimHash) + **agent** (Linker) |
| **L5** Global skill graph | technical + industry skills aggregated across all projects | mechanical aggregation over L2.5 evidence |

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

```
subnet init [path]                  # writes .substrate-net/{code.db,knowledge.db,config.json}
subnet sync [path] [--full]         # re-index code (L0)
subnet analyze [path] [--full]      # code-grounded LLM pass: file summaries + layers + tags
subnet ingest [path]                # conversations + agent pipeline + analyze + enrichment
  [--agent X] [--no-triage] [--no-extract] [--no-analyze] [--no-enrich] [--reprocess]
subnet enrich [path] [--no-agent]   # run the L2.5 enrichment pass on its own
subnet link [path] [--rebuild]      # rebuild cross-project links (L4) + skill graph (L5)
subnet skills [--scope X] [--cross] # global skill graph, weighted by evidence
subnet profile [--prose] [--out p]  # industries + top skills; --prose writes a portfolio
subnet learn [path]                 # industry-standard knowledge not yet in your work
subnet dashboard [path] [--open]    # build a self-contained interactive graph dashboard
subnet serve [path] --mcp           # MCP server over stdio
subnet status [path]                # counts per layer, with scope + grounding breakdown
subnet triage audit [path]          # show triaged windows with labels and rationale
subnet verify [path]                # contradiction detection + low-confidence pruning
subnet canvas <kind> [path]         # generate .canvas.tsx (triage-audit / project-map / ...)
subnet clean [path]                 # remove project data (--local-only / --global-only / --all)
subnet agents list | eval | run     # inspect / test / debug agents
```

The `dashboard` command needs the viewer bundle built once: `npm run build:dashboard`
(or `npm run build:all`). It then emits a single self-contained `index.html` (graph
inlined) plus a shareable `graph.json` to `<project>/.substrate-net/dashboard/`.

`ingest` is incremental: it only processes newly pulled windows. Use
`--reprocess` to re-run the pipeline over **all** existing windows after a model
swap or an interrupted run.

---

## MCP integration

A single MCP server exposes 20 tools — code (L0), knowledge (L1.5–L3), domain
(L2.5), and the global second-brain (L4–L5) — over stdio:

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
`subnet_skills`, `subnet_profile`, `subnet_learn`. Full catalogue in the
[MCP docs](https://tienan92it.github.io/SubstrateNet/mcp.html).

---

## Configuration

Per-agent model selection lives in `~/.substrate-net/config.json` (auto-created on
first `init`). Per-project overrides go in `<project>/.substrate-net/config.json` and
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
    "industryClassifier":{ "model": "openrouter:anthropic/claude-sonnet-4" }
    // ... decision, problemSolution, domainModeler, industryEnricher,
    //     clusterer, summarizer, linker, verifier, skillSynthesizer
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
├── knowledge.db     # L1, L1.5, L2, L2.5, L3 + agent_runs cache
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

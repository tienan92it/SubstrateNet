# CodeGps

Local, layered knowledge graph across projects and AI agent conversations.

CodeGps extends the idea of a pre-indexed code graph (cf. [codegraph](https://github.com/colbymchenry/codegraph)) with three things it doesn't have:

1. **Conversation ingestion** across agents (Cursor / Claude Code / Codex / Copilot) — pulled in-place from each agent's transcript files.
2. **Agent-driven Triage + extraction pipeline** that filters noise and classifies signal before anything reaches the knowledge graph.
3. **Cross-project semantic linking** — concepts and patterns shared between repos surfaced as first-class edges.

Everything is local. SQLite for storage. Ollama is the default LLM backend.

## Layers

| Layer | Content | How it's produced |
|---|---|---|
| **L0** Code Structure | symbols, calls, imports | deterministic (tree-sitter) |
| **L1** Conversations | sessions, turns, tool calls | deterministic (file parsers) |
| **L1.5** Triage | Relevance / Domain / Quality / Linkage labels per window | **agent** (Triage) |
| **L2** Facts | decisions, business rules, intents, problems/solutions | **agents** (Decision / BusinessLogic / Intent / ProblemSolution) + deterministic syntax pass |
| **L3** Concepts | clustered facts with names + summaries | **agents** (Clusterer / Summarizer) |
| **L4** Cross-project | shared concepts between repos | mechanical (SimHash, exact) + **agent** (Linker) |

## Hard rule

Syntax is deterministic. Meaning is agent-driven. There is no `if (text.includes("decided"))` anywhere in the codebase.

## Status

v0.1.0 — every layer L0 through L4 is wired end-to-end. See
[CHANGELOG.md](./CHANGELOG.md) for what's shipped and the layer-by-layer
breakdown. The plan and remaining ideas live in
[`.cursor/plans/codegps_plan_82f6e65a.plan.md`](.cursor/plans/codegps_plan_82f6e65a.plan.md).

[![CI](https://github.com/tienan92it/CodeGps/actions/workflows/ci.yml/badge.svg)](https://github.com/tienan92it/CodeGps/actions/workflows/ci.yml)

## Install (dev)

```bash
npm install
npm run build
node dist/cli/index.js --help
```

## CLI

```
codegps init                 # init .codegps/ in current project
codegps sync                 # re-index code (L0)
codegps ingest               # pull new conversation data (L1) + agent pipeline
codegps serve --mcp          # run MCP server (code + knowledge tools)
codegps agents run <name>    # run a single agent over pending input (debug)
codegps agents eval          # run golden tests for all agents
codegps canvas <kind>        # generate a .canvas.tsx
codegps link                 # rebuild cross-project links
codegps status               # counts per layer
```

## Backend config

Default `~/.codegps/config.json`:

```jsonc
{
  "agentBackends": {
    "default": { "kind": "ollama", "endpoint": "http://localhost:11434" }
  },
  "agents": {
    "triage":   { "model": "default:llama3.1:8b" },
    "decision": { "model": "default:llama3.1:8b" }
  }
}
```

License: MIT

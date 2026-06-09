# RFC: Pipeline refactor — clean, dedupe, package, then reason

| Field | Value |
|---|---|
| **Status** | Complete — M0–M7 landed in 0.2.x |
| **Target** | 0.3.0 (implementation phased across 0.2.x patches where safe) |
| **Authors** | Substrate Net maintainers |
| **Last updated** | 2026-06-08 |

## Summary

Substrate Net’s ingest pipeline sends **raw conversation windows and unfiltered files** to LLMs early and often. Cleaning, deduplication, and context packaging happen **too late** (or not at all). On real projects this produces:

- **Volume blowups** — small repos with large Cursor histories (e.g. 321 windows, ~1,500 facts on mindb).
- **Cost blowups** — output-priced flash models (~$9/M out) × hundreds of extract + cluster calls.
- **Time blowups** — one LLM call per unanalyzed file on first run (e.g. 3,675 files on k_one).

This RFC proposes reordering the workflow into four deterministic phases before any classification or modeling:

1. **Extract & clean** raw artifacts (no LLM).
2. **Scope & filter** files, folders, sessions, and windows.
3. **Dedupe & drop isolates** — remove redundant and non–business-core material.
4. **Package verbatim evidence** into bounded briefs, then call LLMs to classify, extract, cluster, and model.

Quality is preserved by **never discarding verbatim evidence** — compression applies to narrative filler, not to quoted decisions, rules, or citations.

---

## Motivation

### Observed failures (2026-06)

| Project | Repo size | Windows | Dominant cost | Planner estimate | Actual |
|---|---|---|---|---|---|
| **mindb** | 139 files, “small” | 321 | `windowExtractor` + `clusterer` (before file analyze) | ~$0.04, ~170 calls | **>$6** OpenRouter, 1,000+ calls |
| **k_one** | 3,675 files | 164 (transcripts modest) | `fileAnalyzer` (92% of planned calls) | ~$4.80 | Not yet run to completion |

Root causes:

1. **First-run ingests full transcript history** — planner underestimates windows when byte heuristics disagree with reality.
2. **LLM-before-dedupe** — triage and extract run on near-duplicate windows; fact dedupe runs only after enrich.
3. **Raw text in, JSON out** — up to 8k chars/window into triage and 7k into extractors; output tokens dominate spend.
4. **Per-fact cluster loop** — ambiguous embedding band (0.55–0.85) triggers one `clusterer` call per fact; mindb saw ~38% LLM cluster rate vs ~20% planned.
5. **Per-file analyze** — every pending file gets `fileAnalyzer` on first `default` setup.
6. **Eight separate enrich agents** — each builds ad-hoc payloads from raw `k_nodes`; no shared packaged core.
7. **Cost estimator blind spots** — blended $0.30/M pricing; no in/out split; embed calls counted as LLM.

### Design principle (new)

> **Syntax and hygiene are deterministic. Meaning is agent-driven — but only on packaged evidence.**

LLMs should receive **briefs**, not transcripts. Verbatim quotes live inside briefs and in `evidence_text`; narrative noise is stripped mechanically first.

---

## Goals

| # | Goal |
|---|---|
| G1 | **Extract and clean** all inputs deterministically before any LLM call |
| G2 | **Remove unnecessary files, folders, and sessions** via configurable scope |
| G3 | **Deduplicate** windows and facts early; drop **isolated** details that do not anchor to core business |
| G4 | **Package** conversation and project context — **verbatim evidence preserved** — into bounded payloads for classify / extract / model |
| G5 | Cut **median first-run cost** by ≥60% on transcript-heavy projects at **standard** quality profile (**validation pending** — see Appendix B.2) |
| G6 | Cut **median first-run cost** by ≥85% on file-heavy monorepos at **lean** profile without losing L2/L3 from chat |
| G7 | Per-phase **token and call budgets** visible in `setup --plan-only` |

## Non-goals

- Replacing the DIKW layer model or grounding taxonomy.
- Removing agent-driven meaning (no regex “understanding”).
- Cloud sync or non-local storage.
- Changing MCP tool contracts in 0.3.0 (may add optional fields later).

---

## Current pipeline (as-is)

```
init → sync (L0)
     → ingest:
         discover sessions → read turns → segment windows (≤8k chars)
         → syntax pass (all new windows)
         → triage [LLM] → window embed dedupe
         → source classify [LLM, frontier]
         → window extract [LLM, 1/window, ≤25 facts]
         → incident extract [LLM, frontier]
         → cluster [LLM ambiguous band] → summarize [LLM/concept]
         → file analyze [LLM × pending files]
         → enrich [8× LLM, frontier] → fact dedupe [mechanical, late]
     → verify (optional)
→ global link [LLM] → dashboards
```

### Stage inventory

| Stage | Module | LLM | Typical fan-out |
|---|---|---|---|
| Segment | `pipeline/segmenter.ts` | No | 1 window per user turn, ≤8k chars |
| Syntax | `pipeline/syntax.ts` | No | Leaf `k_nodes` per path/code/url |
| Triage | `pipeline/triage.ts` | Yes | `ceil(windows / batchSize)` |
| Window dedupe | `pipeline/triage.ts` | Embed | After triage |
| Extract | `pipeline/extract.ts` | Yes | 1 per kept window |
| Cluster | `pipeline/cluster.ts` | Yes | ~20–40% of facts |
| Summarize | `pipeline/cluster.ts` | Yes | ~30% of facts → concepts |
| Analyze | `pipeline/analyze-code.ts` | Yes | 1 per pending file |
| Enrich | `pipeline/enrich.ts` | Yes | 8 fixed agents |
| Fact dedupe | `pipeline/fact-dedupe.ts` | No | End of enrich only |

### Context injection today

| Consumer | Context source | Max size |
|---|---|---|
| Triage / extract | `buildProjectContext()` | 1,500 chars (titles only) |
| Extract | Raw window text | 7,000 chars |
| Enrich agents | Per-agent SQL slices | 40–120 items, mixed shapes |
| File analyzer | defs + imports + 3k source slice | ~3–6k tokens/file |

**Gap:** no shared **verbatim evidence pack**; project context is empty on early windows; modeling reads raw fact dumps.

---

## Proposed architecture

### Phase map

```
┌─────────────────────────────────────────────────────────────────┐
│ Phase 0 — INGEST RAW (no LLM)                                   │
│   read sessions → normalize turns → segment → hash windows      │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 1 — CLEAN & SCOPE (no LLM)                                │
│   session filter → mechanical window dedupe → syntax (scoped)   │
│   file tiering (sync) → optional path globs                       │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 2 — PACKAGE (no LLM)                                      │
│   window briefs (verbatim quotes + compressed narrative)        │
│   project core pack (cached per run)                            │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 3 — CLASSIFY & EXTRACT (LLM, flash-first)                 │
│   triage on briefs → extract with anchor gate → early fact dedupe│
│   cluster (tuned mechanical band) → summarize concepts           │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 4 — MODEL (LLM, tiered)                                   │
│   file analyze (tiered) → fused enrich on concept digests      │
│   late fact dedupe + corroboration → link / global               │
└─────────────────────────────────────────────────────────────────┘
```

### Quality profiles

| Profile | Phase 0–3 | Phase 4 | Use case |
|---|---|---|---|
| **lean** | Full | Skip file analyze + enrich | Day-one chat knowledge; `--fast` equivalent |
| **standard** | Full | Tier-1 analyze + fused enrich | Default after refactor |
| **deep** | Full | All files + 8-agent enrich (current) | Model swap, portfolio rebuild |

CLI mapping:

- `subnet update --fast` → **lean**
- `subnet update` → **standard** (new default)
- `subnet update --full` → **deep** (+ reprocess all windows)

---

## Component specifications

### P0-A — Turn normalizer (`pipeline/normalize-turns.ts`)

**Input:** raw `Turn[]` from adapters  
**Output:** cleaned turns (same schema)

Mechanical rules (ordered):

1. Strip model “housekeeping” blocks (fenced `thinking`, empty assistant placeholders).
2. Collapse consecutive identical assistant segments (tool retry loops).
3. Remove lines matching diff-only churn (`+/-` only hunks with no prose).
4. Cap single turn at `maxTurnChars` (default 12,000) with head/tail preserve.

**Does not:** summarize or paraphrase user intent.

### P0-B — Session filter (`pipeline/session-filter.ts`)

Config (`~/.substrate-net/config.json`):

```jsonc
{
  "ingest": {
    "maxSessions": 200,
    "sinceDays": 180,
    "minSessionBytes": 256,
    "skipAgents": []          // e.g. ["codex"] for slow global walk
  }
}
```

Applied at discover/read time. Sessions ordered by `mtime` desc; excess dropped with audit log in `pipeline_state`.

### P0-C — Pre-triage window dedupe (`pipeline/window-dedupe.ts`)

**Move before triage** (today: after triage in `triage.ts`).

1. Embed all candidate windows (batched local `dedupe` model).
2. Drop windows with cosine ≥ `windowDupThreshold` (default **0.92**) against any prior window.
3. Mark dropped windows `triage_labels.kept = false`, rationale `mechanical_dup`.

**Savings:** skip triage + extract on near-identical Cursor replays.

### P0-D — Window brief (`pipeline/window-brief.ts`)

**Input:** `turn_window` + syntax artifacts  
**Output:** `WindowBrief` (stored in new table `window_briefs` or JSON column on `turn_windows`)

```ts
interface WindowBrief {
  windowId: string;
  sessionId: string;
  sourceAgent: string;       // cursor | docs | …
  /** ≤1200 chars — mechanical compression of narrative */
  narrative: string;
  /** Verbatim passages — never LLM-summarized before extract */
  quotes: Array<{
    text: string;            // ≤400 chars each, max 8 quotes
    kind: 'user' | 'assistant' | 'doc';
    offset?: string;         // turn id or heading
  }>;
  symbols: string[];         // from syntax + path mentions
  tickets: string[];
  paths: string[];
  charBudget: number;        // actual serialized size
}
```

**Brief builder (deterministic):**

1. Pull direct user questions and assistant conclusions (first/last substantive paragraphs).
2. Promote syntax hits (tickets, paths, errors) into `quotes`.
3. Build `narrative` via template concatenation, not LLM.
4. Enforce `maxBriefChars` (default **2,000**).

**LLM contract change:** `triageBatch` and `windowExtractor` accept `WindowBrief` instead of raw `text`. Prompts cite `quotes[]` as authoritative evidence.

### P0-E — Project core pack (`pipeline/project-core-pack.ts`)

Replaces thin `buildProjectContext()` for LLM stages.

Built once per ingest run (invalidate on new facts / industry):

```ts
interface ProjectCorePack {
  projectName?: string;
  industry?: string[];
  /** Verbatim lines with source refs */
  evidence: Array<{ ref: string; verbatim: string }>;
  /** Compressed indexes — titles only */
  entities: string[];
  decisions: string[];
  glossary: string[];
  ticketPrefixes: string[];
  charBudget: number;
}
```

Sources (deterministic pull):

- `package.json` name/description
- README lede (first 800 chars, verbatim)
- Top-N entities/decisions by confidence + recency
- Prior industry node if present

Max **3,000 chars** serialized. Injected into triage, extract, and fused enrich.

### P0-F — Anchor gate (`pipeline/fact-filter.ts`)

Post-extract, pre-cluster filter. Drop fact unless **at least one** anchor:

| Anchor type | Rule |
|---|---|
| `entity` / `business_rule` / `decision` | Always keep |
| `intent` / `problem` / `solution` | Keep if ticket, path, or symbol anchor present |
| `pattern` / `constraint` | Keep if references named entity or prior decision title |
| `metric` / `actor` / `process` | Keep if linked to entity in same window brief |

Configurable `ingest.minExtractConfidence` (default 0.45).

Rejected facts logged to `pipeline_state` counter — not silently dropped.

### P0-G — Early fact dedupe (`pipeline/fact-dedupe-early.ts`)

Run **after anchor gate, before cluster**:

- Same algorithm as `fact-dedupe.ts` (≥0.92 cosine, same kind).
- Redirect provenance; delete duplicate nodes.
- Ensures cluster/summarize see canonical facts only.

**Late dedupe** remains for cross-source corroboration after enrich.

### P0-H — File tiers (`code/file-tiers.ts`)

| Tier | Criteria | Analyze in standard profile |
|---|---|---|
| **0 — skip** | `**/*.test.*`, `**/__tests__/**`, `fixtures/`, `mocks/`, `*.generated.*`, config globs | Never |
| **1 — core** | Entrypoints (`main`, `index`, app bootstrap) + top 10% fan-in from L0 call graph | First pass |
| **2 — rest** | Everything else indexed in L0 | Only in **deep** or `analyze --full` |

`sync` still indexes all tier-0/1/2 for L0 (cheap). `fileAnalyzer` respects tier in standard profile.

Config extension:

```jsonc
{
  "analyze": {
    "tier": "standard",           // lean | standard | deep
    "skipGlobs": ["**/vendor/**"],
    "maxFilesPerRun": 500
  }
}
```

### P0-I — Cluster tuning

| Parameter | Current | Proposed (standard) |
|---|---|---|
| `AUTO_ATTACH_SCORE` | 0.85 | **0.88** |
| `REFRESH_ATTACH_SCORE` | 0.82 | **0.85** |
| `CANDIDATE_MIN_SCORE` | 0.55 | **0.60** |
| Ambiguous band width | 0.30 | **0.28** (fewer LLM calls) |

**Batch clusterer** — N ambiguous facts decided per `clustererBatch` call
(`config.ingest.clusterBatch`, default on; batch size follows `config.batchSize`).

### P1 — Fused enrich (`pipeline/enrich-fused.ts`)

Replace eight sequential frontier calls with **two** flash-first calls in standard profile:

| Agent | Input | Replaces |
|---|---|---|
| `domainFuser` | Project core pack + concept digests (top 40) + structural entity list | `domainModeler`, `domainAnalyzer`, `businessDomainModeler`, `techDomainModeler` |
| `industryFuser` | Project core pack + README excerpt + dependency histogram | `industryClassifier`, `industryEnricher`, `technicalProfiler`, `architectureModeler` |

**Deep profile** retains individual agents for maximum fidelity.

`industryEnricher` external research stays opt-in (`research.kind`).

### P2 — Planner overhaul (`setup/plan.ts`, `setup/plan-cost.ts`)

Per-phase table in `setup --plan-only`. The planner mirrors **runtime agent names**
and **cluster eligibility** — not a separate cost model.

#### Phase formulas (standard profile)

| Phase | Calls | Token basis |
|---|---|---|
| `pre-llm` | 0 | mechanical wall only |
| `triage` | `ceil(keptWindows / batchSize)` | **`triageBatch`** (runtime default) |
| `extract` | `keptAfterTriage` if `windowExtractor` configured, else legacy fan-out | `windowExtractor` |
| `cluster` | `ceil(ambiguousClusterable / batchSize)` | **`clustererBatch`** when `ingest.clusterBatch` |
| `summarize` | `ceil(clusterableFacts × 0.30)` | `summarizer` |
| `source-classify` | `ceil(keptAfterTriage / 20)` | **`sourceClassifierBatch`** |
| `incident` | bugfix windows (`activity=bugfix`) or `keptAfterTriage × 2%` | `incident` |
| `analyze` | tier-1 pending files (`analyze.tier=standard`) | `fileAnalyzer` |
| `analyze-arch` | 1 when analyze runs | `architectureAnalyzer` |
| `enrich-fused` | 2 | `domainFuser` + `industryFuser` |
| `global` | 2 | `linker` + `skillSynthesizer` |

Where:

- `keptWindows = rawWindows × (1 − preTriageDedupeRatio)` (default 12% drop).
- `keptAfterTriage = keptWindows × 0.75` (triage noise drop).
- **`clusterableFacts`** = count of `k_nodes` whose `kind` is **not** in
  `CLUSTER_EVIDENCE_KINDS` (same exclusion list as `pipeline/cluster.ts`), or
  `keptAfterTriage × 0.7` on a greenfield tree.
- `ambiguousClusterable = clusterableFacts × (1 − mechanicalAttachRatio)` (default 15% ambiguous band).

#### Pricing rules

- **Cloud agents** — priced from `MODEL_PRICING` using the configured OpenRouter model.
- **Batch agents** (`triageBatch`, `clustererBatch`, `sourceClassifierBatch`) — inherit
  the parent agent's config when not declared (`triage` → `clusterer` → `sourceClassifier`).
- **Frontier agents** — OpenRouter line item uses the **first cloud fallback** model
  (typical bill when Cursor SDK is unavailable). Subscription-only agents show
  `frontier (subscription)` with $0 on that line.
- **Cache** — applied only on **incremental** plans (`untriaged windows = 0`), capped at 40%.
  First-run plans always use **0% cache**.

#### Example (small project — illustrative)

```
Phase          Calls   Tokens(in)  Tokens(out)  Est.$    Wall
─────────────────────────────────────────────────────────────
pre-llm           0          0           0     0.00    2m
triage           21     54,600      52,500     0.55    1m
extract          80    112,000     152,000     1.54    4m
cluster          15     42,000      27,000     0.31    2m
summarize        25     13,750      27,500     0.27    1m
analyze (t1)     45    126,000      33,750     0.49    3m
enrich-fused      2      8,300       4,000     0.05    1m
```

Run `subnet setup --plan-only --projects <path>` for project-specific numbers.

---

## Data model changes

### New tables

```sql
-- window_briefs: deterministic package for LLM stages
CREATE TABLE window_briefs (
  window_id   TEXT PRIMARY KEY REFERENCES turn_windows(id),
  narrative   TEXT NOT NULL,
  quotes_json TEXT NOT NULL,   -- JSON array of {text, kind, offset}
  symbols_json TEXT,
  tickets_json TEXT,
  paths_json  TEXT,
  char_budget INTEGER NOT NULL,
  built_at    INTEGER NOT NULL
);

-- pipeline_audit: counters for dropped windows/facts
CREATE TABLE pipeline_audit (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
```

### `turn_windows` additions (optional)

- `normalized_hash` — hash after turn normalizer
- `mechanical_drop_reason` — enum: `dup`, `session_cap`, `too_short`, null

### `k_nodes` additions (optional)

- `anchors_json` — `["ticket:KAFI-12", "entity:Borrower", "path:src/api.ts"]`
- Populated by extractor schema extension; used by anchor gate.

### Config schema (`config.ts`)

```ts
interface IngestConfig {
  maxSessions?: number;
  sinceDays?: number;
  minSessionBytes?: number;
  skipAgents?: AgentId[];
  maxBriefChars?: number;
  maxFactsPerWindow?: number;      // default 8 (was 25)
  windowDupThreshold?: number;
  minExtractConfidence?: number;
}

interface AnalyzeConfig {
  tier?: 'lean' | 'standard' | 'deep';
  skipGlobs?: string[];
  maxFilesPerRun?: number;
}
```

---

## Orchestrator changes

`ingest/orchestrator.ts` becomes a phase coordinator:

```ts
async function ingestProject(root, opts) {
  // Phase 0
  const windows = await ingestRaw(root, opts);

  // Phase 1
  const scoped = await cleanAndScope(windows, cfg.ingest);

  // Phase 2
  const briefs = buildAllBriefs(scoped);
  const corePack = buildProjectCorePack(knowDb, codeDb, root);

  // Phase 3 — first LLM touch
  const kept = await triageBriefs(briefs, corePack, cfg);
  const facts = await extractBriefs(kept, corePack, cfg);
  const filtered = applyAnchorGate(facts);
  const deduped = runEarlyFactDedupe(knowDb);
  await clusterFacts(deduped, cfg);
  await summarizeDirtyConcepts(cfg);

  // Phase 4 — profile-gated
  if (profile !== 'lean') {
    await analyzeTiered(codeDb, cfg.analyze);
    await enrichFused(knowDb, codeDb, corePack, cfg, { deep: profile === 'deep' });
    runFactDedupe(knowDb);  // corroboration pass
  }
}
```

`run-project.ts` passes `profile` through; `setup` defaults to **standard** (changed from implicit deep).

---

## API / CLI surface

| Command | Change |
|---|---|
| `subnet setup` | `--profile lean\|standard\|deep`; plan shows per-phase table |
| `subnet update` | `--fast` = lean; default = standard; `--full` = deep |
| `subnet doctor` | Report `% mechanical drops`, anchor rejects, tier-0 file count |
| `subnet ingest` (hidden) | Honors `SUBNET_PROFILE` env for scripts |

No breaking removal until 0.3.0; deprecated commands unchanged.

---

## Quality guarantees

| Guarantee | Mechanism |
|---|---|
| Verbatim evidence preserved | `quotes[]` in briefs + `evidence_text` on facts |
| No silent drops | `pipeline_audit` counters + doctor visibility |
| Project truth grounding | Structural/corroborated facts never anchor-gated out |
| Conservative triage option | `ingest.triageMode: conservative\|balanced\|aggressive` |
| Reproducibility | Cache keys include `briefHash` + `corePackHash` |

### Regression fixtures

- Golden briefs: 10 representative windows → expected `WindowBrief` JSON
- Golden anchor gate: facts in / facts out pairs
- Cost ceiling test: mindb fixture must plan `<$1.50` at standard profile

---

## Success metrics

| Metric | Baseline (mindb) | Target (standard) |
|---|---|---|
| First-run OpenRouter spend | >$6 | **≤$1.50** |
| LLM calls (transcript path) | ~1,000 | **≤250** |
| `clusterer` calls / fact | 0.38 | **≤0.15** |
| Time to lean-complete | ~45 min | **≤10 min** |
| Facts with anchors | unmeasured | **≥85%** of stored L2 |
| Planner estimate error | >10× | **≤1.5×** actual |

---

## Implementation plan

| Milestone | Scope | Risk | Ship |
|---|---|---|---|
| **M0** | RFC review + config types + `pipeline_audit` | Low | 0.2.1 |
| **M1** | Pre-triage dedupe, early fact dedupe, anchor gate, maxFacts=8 | Low | 0.2.1 |
| **M2** | Window brief builder; triage/extract on briefs | Medium | 0.2.2 |
| **M3** | Session filter + turn normalizer | Medium | 0.2.2 |
| **M4** | File tiers + analyze gating | Medium | 0.2.3 |
| **M5** | Fused enrich + standard as default profile | High | **Done** (0.2.x) |
| **M6** | Planner in/out pricing + per-phase table | Low | **Done** (0.2.2) |
| **M7** | Batch clusterer (optional) | Medium | **Done** (0.2.x) |

Each milestone ships behind `config.ingest.experimentalPhase ≥ N` until stable.

---

## Migration

### Existing projects

- No schema migration required for M1 (uses existing tables).
- `window_briefs` table added on next `init` or lazy migration in `openKnowledgeDb`.
- Re-run `subnet update --full` once to rebuild briefs + re-extract under new gates.

### Config migration

Auto-merge in `loadConfig()`:

```jsonc
{
  "ingest": { "maxFactsPerWindow": 8, "sinceDays": 365 },
  "analyze": { "tier": "standard" }
}
```

Users wanting old behavior:

```jsonc
{ "analyze": { "tier": "deep" }, "ingest": { "triageMode": "conservative" } }
```

### Documentation

- Update `architecture.html` pipeline section
- Link RFC from `CHANGELOG.md` under 0.3.0
- Add `configuration.html#ingest` and `#analyze` sections

---

## Open questions

1. **Brief builder without LLM** — is template-based narrative sufficient, or do we need a optional `briefCompressor` flash call (1/window max)?
2. **Session ownership** — should Cursor sessions be filtered by *time spent in repo* vs *mtime*?
3. **Anchor strictness** — standard profile strict; should lean profile allow orphan `intent` facts?
4. **Fused enrich quality** — run A/B on k_one/mindb fixtures before making standard default?
5. **Tier-1 detection** — fan-in only, or include `git log --name-only` hot files?
6. **Cross-project windows** — `linkage: cross_project` windows: extract yes/no in lean?

---

## Appendix A — mindb post-mortem (pre-refactor, 2026-05)

| Stage | Actual | Notes |
|---|---|---|
| Windows ingested | 321 | Greenfield planner assumed 9 (bytes heuristic) |
| `windowExtractor` | 319 calls | ~1 per window |
| `clusterer` | 590 calls | Per-fact LLM; wide ambiguous band |
| `fileAnalyzer` | 0 | Not reached before credit exhaustion |
| Token split | ~46% output | Gemini 3.5 flash: $9/M out dominates |
| Root fix | Pre-dedupe + briefs + anchor gate + batch cluster | Est. 65% call reduction |

**Post-refactor ingest (2026-06, same project):** 321 windows, batch triage/extract/cluster;
recorded OpenRouter ~$3.7 on cluster + extract (see `agent_runs`).

## Appendix B — k_one post-mortem

### B.1 Pre-refactor planner (0.1.x — analyze-dominated)

| Stage | Planned calls | Share |
|---|---|---|
| `fileAnalyzer` | 3,676 | 92% |
| Transcript path | ~315 | 8% |
| Root fix | File tiers (`analyze.tier=standard`, ~50–500 tier-1 files) | Est. 95% analyze reduction |

### B.2 Post-refactor first run (2026-06-08, standard profile)

Project: `/Users/antran/Workspace/kafi/k_one` — 3,675 files, 104 sessions, 1,374 windows.

| Phase | Planner (before fix) | Actual `agent_runs` | Recorded OpenRouter $ |
|---|---|---|---|
| `triageBatch` | 152 calls · $0.57 | 80 calls | $2.14 |
| `windowExtractor` | 908 · $5.16 | 615 | $5.82 |
| `clustererBatch` | **26 · $0.00** | **121** | **$2.49** |
| `summarizer` | 409 · $1.82 | 339 | $2.52 |
| `fileAnalyzer` | 500 tier-1 (not all run) | 63 | $0.41 |
| `sourceClassifierBatch` | 46 · $0 (frontier) | 62 (0 tokens logged) | fallback billed |
| `incident` | not planned | 18 | fallback billed |
| **Total recorded** | **~$8–10 plan** | **1,351 runs** | **~$13.5** |

**Root causes of plan underrun (fixed in planner v2):**

1. Cluster counted **all extracted facts**, not **clusterable** kinds — syntax leaf nodes
   (`path_mention`, `url`, …) are excluded at cluster time but inflated the old cap formula.
2. `clustererBatch` / `triageBatch` missing from user config → planner priced **$0** or used
   single-window token heuristics while runtime always batches.
3. **Cache 40%** applied on re-plan after partial run; first-run actual was 0% cache.
4. **Frontier agents** (`sourceClassifier`, `incident`) billed via OpenRouter fallback but
   shown as $0 in the plan table.

**Corrected planner target (same project, post-fix):** ~$12–14 OpenRouter for full first-run
ingest + tier-1 analyze; incremental `subnet update` should be << $1 with cache warm.

### B.3 G5 / G6 status on k_one

| Goal | Status | Evidence |
|---|---|---|
| G5 (≥60% first-run cost cut, standard) | **Not validated vs 0.1.x baseline** | Transcript path ~$13 vs old analyze-heavy $plan; need apples-to-apples replay |
| G6 (≥85% cut, lean) | **Met in design** | `subnet update --fast` skips analyze + enrich |
| G7 (per-phase budgets visible) | **Implemented** | `setup --plan-only`; accuracy improved in planner v2 |

## Appendix C — Related files (current)

| Area | Path |
|---|---|
| Orchestrator | `src/ingest/orchestrator.ts` |
| Segmenter | `src/pipeline/segmenter.ts` |
| Triage | `src/pipeline/triage.ts` |
| Extract | `src/pipeline/extract.ts` |
| Cluster | `src/pipeline/cluster.ts` |
| Enrich | `src/pipeline/enrich.ts` |
| Fact dedupe | `src/pipeline/fact-dedupe.ts` |
| Project context | `src/knowledge/project-context.ts` |
| Planner | `src/setup/plan.ts` |
| Runner | `src/pipeline/run-project.ts` |

---

## Review checklist

- [x] Goals G1–G4, G7 — implemented and testable
- [ ] **G5** — ≥60% first-run cost reduction at standard quality: **not empirically signed off**
  (k_one transcript path ~$13.5; baseline replay pending)
- [x] **G6** — lean profile skips analyze + enrich (`subnet update --fast`)
- [x] Verbatim evidence path explicit in brief + fact schema (`window_briefs`, `evidence_text`, core pack)
- [x] Profile matrix (lean / standard / deep) — `subnet update --fast|--deep|--full`, `setup --profile`
- [x] Config shape approved (`ingest`, `analyze`, `clusterBatch` in defaults)
- [x] Migration path acceptable — lazy `window_briefs` + column migrations in `openKnowledgeDb`
- [x] Planner v2 aligns with runtime agents + `CLUSTER_EVIDENCE_KINDS` (see P2, Appendix B.2)
- [ ] Open questions (Appendix tuning) — brief compressor, anchor strictness on lean

**E2E phase order (verified in code):** discover → normalize → segment → brief → pre-dedupe → triage → extract → anchor gate → early dedupe → batch cluster → tiered analyze → fused/deep enrich → late dedupe.

**Comment on this RFC:** open a discussion on [PR #1](https://github.com/tienan92it/SubstrateNet/pull/1) or edit `docs/workflow-refactor.md` directly on the feature branch.

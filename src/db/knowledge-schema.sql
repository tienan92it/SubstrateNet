-- Substrate Net L1, L1.5, L2, L3 schema: conversations, triage, facts, concepts

CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL,
    description TEXT
);
INSERT OR IGNORE INTO schema_versions (version, applied_at, description)
VALUES (1, strftime('%s', 'now') * 1000, 'Initial knowledge schema');

-- L1: raw conversation log
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_path TEXT NOT NULL,
    started_at INTEGER,
    ended_at INTEGER,
    title TEXT,
    ingested_at INTEGER NOT NULL,
    ingest_offset INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent);
CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source_path);

CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    role TEXT NOT NULL,
    text TEXT,
    ts INTEGER,
    raw TEXT
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, idx);

CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    args TEXT,
    result_excerpt TEXT,
    target_paths TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_turn ON tool_calls(turn_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(name);

CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
    text,
    content='turns',
    content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS turns_fts_ai AFTER INSERT ON turns BEGIN
    INSERT INTO turns_fts(rowid, text) VALUES (NEW.rowid, NEW.text);
END;
CREATE TRIGGER IF NOT EXISTS turns_fts_ad AFTER DELETE ON turns BEGIN
    INSERT INTO turns_fts(turns_fts, rowid, text) VALUES ('delete', OLD.rowid, OLD.text);
END;
CREATE TRIGGER IF NOT EXISTS turns_fts_au AFTER UPDATE ON turns BEGIN
    INSERT INTO turns_fts(turns_fts, rowid, text) VALUES ('delete', OLD.rowid, OLD.text);
    INSERT INTO turns_fts(rowid, text) VALUES (NEW.rowid, NEW.text);
END;

-- L1.5: triage windows + labels
CREATE TABLE IF NOT EXISTS turn_windows (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    start_turn TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    end_turn TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    text_hash TEXT NOT NULL,
    embedding BLOB
);
CREATE INDEX IF NOT EXISTS idx_window_session ON turn_windows(session_id);
CREATE INDEX IF NOT EXISTS idx_window_hash ON turn_windows(text_hash);

CREATE TABLE IF NOT EXISTS triage_labels (
    window_id TEXT PRIMARY KEY REFERENCES turn_windows(id) ON DELETE CASCADE,
    relevance TEXT NOT NULL,
    domain TEXT NOT NULL,
    quality TEXT NOT NULL,
    linkage TEXT NOT NULL,
    confidence REAL NOT NULL,
    rationale TEXT,
    model TEXT NOT NULL,
    produced_at INTEGER NOT NULL,
    kept INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_triage_kept ON triage_labels(kept);
CREATE INDEX IF NOT EXISTS idx_triage_domain ON triage_labels(domain);

-- L2: extracted facts
CREATE TABLE IF NOT EXISTS k_nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    evidence_text TEXT,
    confidence REAL NOT NULL,
    source TEXT NOT NULL,
    agent_model TEXT,
    grounding TEXT,             -- 'structural'|'stated'|'corroborated'|'external'|'model' (NULL => 'stated')
    scope TEXT,                 -- 'technical' | 'industry' | 'meta'
    source_url TEXT,            -- citation when grounding='external'
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    cluster_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_knodes_kind ON k_nodes(kind);
CREATE INDEX IF NOT EXISTS idx_knodes_source ON k_nodes(source);
CREATE INDEX IF NOT EXISTS idx_knodes_cluster ON k_nodes(cluster_id);
-- NOTE: indexes on grounding/scope are created in migrateKnowledgeDb()
-- (connection.ts), AFTER ensureColumn adds those columns. They must not live
-- here: on a legacy DB this CREATE TABLE is a no-op, the columns may be
-- absent, and an index referencing them would fail before the migration runs.

CREATE VIRTUAL TABLE IF NOT EXISTS k_nodes_fts USING fts5(
    id, title, summary, evidence_text,
    content='k_nodes', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS k_nodes_fts_ai AFTER INSERT ON k_nodes BEGIN
    INSERT INTO k_nodes_fts(rowid, id, title, summary, evidence_text)
    VALUES (NEW.rowid, NEW.id, NEW.title, NEW.summary, NEW.evidence_text);
END;
CREATE TRIGGER IF NOT EXISTS k_nodes_fts_ad AFTER DELETE ON k_nodes BEGIN
    INSERT INTO k_nodes_fts(k_nodes_fts, rowid, id, title, summary, evidence_text)
    VALUES ('delete', OLD.rowid, OLD.id, OLD.title, OLD.summary, OLD.evidence_text);
END;
CREATE TRIGGER IF NOT EXISTS k_nodes_fts_au AFTER UPDATE ON k_nodes BEGIN
    INSERT INTO k_nodes_fts(k_nodes_fts, rowid, id, title, summary, evidence_text)
    VALUES ('delete', OLD.rowid, OLD.id, OLD.title, OLD.summary, OLD.evidence_text);
    INSERT INTO k_nodes_fts(rowid, id, title, summary, evidence_text)
    VALUES (NEW.rowid, NEW.id, NEW.title, NEW.summary, NEW.evidence_text);
END;

CREATE TABLE IF NOT EXISTS k_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL REFERENCES k_nodes(id) ON DELETE CASCADE,
    target TEXT NOT NULL REFERENCES k_nodes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    weight REAL DEFAULT 1.0,
    metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_kedges_source ON k_edges(source, kind);
CREATE INDEX IF NOT EXISTS idx_kedges_target ON k_edges(target, kind);

CREATE TABLE IF NOT EXISTS k_provenance (
    k_node_id TEXT NOT NULL REFERENCES k_nodes(id) ON DELETE CASCADE,
    window_id TEXT NOT NULL REFERENCES turn_windows(id) ON DELETE CASCADE,
    span_start INTEGER,
    span_end INTEGER
);
CREATE INDEX IF NOT EXISTS idx_prov_knode ON k_provenance(k_node_id);
CREATE INDEX IF NOT EXISTS idx_prov_window ON k_provenance(window_id);

CREATE TABLE IF NOT EXISTS k_to_code (
    k_node_id TEXT NOT NULL,
    code_node_id TEXT NOT NULL,
    code_file TEXT,
    weight REAL DEFAULT 1.0
);
CREATE INDEX IF NOT EXISTS idx_ktc_knode ON k_to_code(k_node_id);
CREATE INDEX IF NOT EXISTS idx_ktc_code ON k_to_code(code_node_id);
CREATE INDEX IF NOT EXISTS idx_ktc_file ON k_to_code(code_file);

-- L3: concepts
CREATE TABLE IF NOT EXISTS concepts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    summary TEXT,
    domain TEXT,
    scope TEXT,                 -- 'technical' | 'industry' | 'meta'
    grounding TEXT,             -- dominant grounding tier across members
    member_count INTEGER NOT NULL,
    embedding BLOB
);

-- Cache for opt-in external research (keeps default runs offline / idempotent).
CREATE TABLE IF NOT EXISTS research_cache (
    query_hash TEXT PRIMARY KEY,
    query TEXT NOT NULL,
    result_json TEXT NOT NULL,
    source_url TEXT,
    fetched_at INTEGER NOT NULL
);

-- Side-table for k_nodes embeddings (kept separate to leave k_nodes lean and
-- to allow embedding model swaps without touching the main fact table).
CREATE TABLE IF NOT EXISTS k_node_embeddings (
    k_node_id TEXT PRIMARY KEY REFERENCES k_nodes(id) ON DELETE CASCADE,
    embedding BLOB NOT NULL,
    model TEXT
);
CREATE INDEX IF NOT EXISTS idx_concepts_domain ON concepts(domain);

-- Agent run audit / cache
CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    agent_name TEXT NOT NULL,
    model TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    output_json TEXT NOT NULL,
    tokens_in INTEGER,
    tokens_out INTEGER,
    ms INTEGER,
    ok INTEGER NOT NULL,
    error TEXT,
    produced_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_cache
    ON agent_runs(agent_name, model, input_hash);

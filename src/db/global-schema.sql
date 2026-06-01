-- CodeGps L4 global schema: cross-project registry + concept links

CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL,
    description TEXT
);
INSERT OR IGNORE INTO schema_versions (version, applied_at, description)
VALUES (1, strftime('%s', 'now') * 1000, 'Initial global schema');

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    registered_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path);

CREATE TABLE IF NOT EXISTS concepts_global (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    local_concept_id TEXT NOT NULL,
    name TEXT NOT NULL,
    summary TEXT,
    domain TEXT,
    scope TEXT,
    embedding BLOB,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cg_project ON concepts_global(project_id);
CREATE INDEX IF NOT EXISTS idx_cg_domain ON concepts_global(domain);
CREATE INDEX IF NOT EXISTS idx_cg_name ON concepts_global(lower(name));

CREATE TABLE IF NOT EXISTS concept_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    a TEXT NOT NULL REFERENCES concepts_global(id) ON DELETE CASCADE,
    b TEXT NOT NULL REFERENCES concepts_global(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,    -- 'same_as' | 'variant_of' | 'supersedes' | 'contradicts'
    score REAL NOT NULL,
    source TEXT NOT NULL,  -- 'mechanical' | 'agent:linker'
    metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_link_a ON concept_links(a, kind);
CREATE INDEX IF NOT EXISTS idx_link_b ON concept_links(b, kind);
CREATE UNIQUE INDEX IF NOT EXISTS idx_link_unique ON concept_links(a, b, kind, source);

-- L5: global skill graph (the "second brain" aggregation across projects)
CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    scope TEXT NOT NULL,           -- 'technical' | 'industry'
    kind TEXT,                     -- 'language' | 'framework' | 'library' | 'infra' | 'domain' | ...
    evidence_weight REAL NOT NULL DEFAULT 0,
    grounding TEXT,                -- strongest tier supporting it
    project_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skills_scope ON skills(scope);
CREATE INDEX IF NOT EXISTS idx_skills_weight ON skills(evidence_weight);

CREATE TABLE IF NOT EXISTS skill_evidence (
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source_name TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 1,
    grounding TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_ev_unique ON skill_evidence(skill_id, project_id, source_name);
CREATE INDEX IF NOT EXISTS idx_skill_ev_project ON skill_evidence(project_id);

CREATE TABLE IF NOT EXISTS industries (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    confidence REAL,
    grounding TEXT,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_industries_project ON industries(project_id);

-- Composite portfolio highlights (technical x industry), per project.
CREATE TABLE IF NOT EXISTS highlights (
    id TEXT PRIMARY KEY,
    statement TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    evidence TEXT,
    grounding TEXT,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_highlights_project ON highlights(project_id);

-- Agent run cache + audit for GLOBAL agents (ProfileWriter, etc.), mirroring
-- knowledge.db's agent_runs so AgentRuntime can cache against global.db.
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_global_agent_cache
    ON agent_runs(agent_name, model, input_hash);

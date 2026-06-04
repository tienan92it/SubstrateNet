-- Substrate Net L4 global schema: cross-project registry + concept links

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

-- Knowledge zones (the global hierarchy: industry > business domain > tech domain).
-- `id` is a name-hash so the SAME domain across projects collapses to one node
-- (mechanical cross-project merge); `project_id` records membership.
CREATE TABLE IF NOT EXISTS business_domains (
    id TEXT NOT NULL,              -- hash('business_domain'|lower(name))
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    summary TEXT,
    grounding TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_bizdom_project ON business_domains(project_id);

CREATE TABLE IF NOT EXISTS tech_domains (
    id TEXT NOT NULL,              -- hash('tech_domain'|lower(name))
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    summary TEXT,
    grounding TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_techdom_project ON tech_domains(project_id);

-- Parent/child edges in the global hierarchy, per project (deduped at read).
-- Node ids are prefixed: 'ind:'<hash> | 'bd:'<hash> | 'td:'<hash> | 'proj:'<id>.
CREATE TABLE IF NOT EXISTS taxonomy_edges (
    parent_id TEXT NOT NULL,
    child_id TEXT NOT NULL,
    kind TEXT NOT NULL,           -- 'industry_has_business' | 'business_has_tech' | 'tech_has_project'
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    PRIMARY KEY (parent_id, child_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_taxedge_parent ON taxonomy_edges(parent_id);
CREATE INDEX IF NOT EXISTS idx_taxedge_project ON taxonomy_edges(project_id);

-- Workspace umbrellas: a multi-repo product/org grouping (e.g. "Kafi" over
-- GBI, bond, sales, data-platform, ...). `id` is a name-hash so the same
-- umbrella collapses across projects.
CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source TEXT,                  -- 'config' | 'git-org' | 'path'
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_workspace (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    source TEXT,
    confidence REAL
);
CREATE INDEX IF NOT EXISTS idx_pw_workspace ON project_workspace(workspace_id);

-- Emergent project links + suggested groupings (no explicit umbrella).
CREATE TABLE IF NOT EXISTS project_links (
    a TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    b TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    weight REAL NOT NULL,
    signals TEXT,                 -- JSON: which signals contributed
    PRIMARY KEY (a, b)
);
CREATE INDEX IF NOT EXISTS idx_plinks_a ON project_links(a);

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

import { useMemo, useState } from 'react';
import type {
  GlobalDashboardSnapshot, WisdomSnapshot, WisdomInsight, WisdomGap,
  ParaArea, ParaProject, ParaSubject, ParaTopic, DashboardSnapshot, KnowledgeNode, KnowledgeEdge,
} from './types';
import {
  LEVEL_ORDER, LEVEL_LABELS_PROF, LEVEL_COLOR, KNOWLEDGE_LABELS, KNOWLEDGE_COLORS,
} from './types';

type View = 'projects' | 'areas' | 'resources' | 'archive';

export function GlobalApp({ snapshot }: { snapshot: GlobalDashboardSnapshot }) {
  const [view, setView] = useState<View>('resources');
  const [drillProjectId, setDrillProjectId] = useState<string | null>(null);

  const para = snapshot.para;
  const wisdom = snapshot.wisdom;
  const c = snapshot.meta.counts;

  const drillProject = drillProjectId ? snapshot.drillDown[drillProjectId] : undefined;
  const drillLabel = useMemo(() => {
    if (!drillProjectId) return '';
    const all = [...(para?.projects ?? []), ...(para?.archives ?? [])];
    return all.find((p) => p.id === drillProjectId)?.name ?? drillProjectId;
  }, [drillProjectId, para]);

  const counts = {
    projects: para?.projects.length ?? 0,
    areas: para?.areas.length ?? 0,
    subjects: para?.subjects.length ?? 0,
    archive: para?.archives.length ?? 0,
  };

  const empty = !para || (counts.projects + counts.areas + counts.subjects + counts.archive === 0);

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">subnet<span className="brand-dot">/</span><span className="brand-mode">global</span></span>
        <div className="tabs">
          <button className={`tab ${view === 'projects' ? 'active' : ''}`} onClick={() => { setView('projects'); setDrillProjectId(null); }}>projects<span className="tab-n">{counts.projects}</span></button>
          <button className={`tab ${view === 'areas' ? 'active' : ''}`} onClick={() => { setView('areas'); setDrillProjectId(null); }}>areas<span className="tab-n">{counts.areas}</span></button>
          <button className={`tab ${view === 'resources' ? 'active' : ''}`} onClick={() => { setView('resources'); setDrillProjectId(null); }}>resources<span className="tab-n">{counts.subjects}</span></button>
          <button className={`tab ${view === 'archive' ? 'active' : ''}`} onClick={() => { setView('archive'); setDrillProjectId(null); }}>archive<span className="tab-n">{counts.archive}</span></button>
        </div>
        {drillProjectId && (
          <div className="crumbs">
            <button className="crumb" onClick={() => setDrillProjectId(null)}>{view}</button>
            <span className="sep">/</span><span className="crumb active">{drillLabel}</span>
          </div>
        )}
        <span className="counts">
          <b>{c.projects}</b> projects · <b>{c.businessDomains}</b> biz · <b>{c.techDomains}</b> tech
        </span>
      </div>

      <div className="body">
        <div className="main">
          <div className="para">
            {!drillProject && <WisdomHero wisdom={wisdom} counts={c} para={para} />}

            {empty && (
              <p className="sub empty-hint">No organized knowledge yet. Run <code>subnet update --global</code> across your projects, then <code>subnet global wisdom</code>.</p>
            )}

            {drillProject ? (
              <ProjectDetail snapshot={drillProject} />
            ) : (
              <>
                {view === 'projects' && <ProjectsView projects={para?.projects ?? []} onOpen={setDrillProjectId} hasGraph={(id) => !!snapshot.drillDown[id]} />}
                {view === 'areas' && <AreasView areas={para?.areas ?? []} />}
                {view === 'resources' && <ResourcesView subjects={para?.subjects ?? []} />}
                {view === 'archive' && <ArchiveView projects={para?.archives ?? []} onOpen={setDrillProjectId} hasGraph={(id) => !!snapshot.drillDown[id]} />}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Wisdom hero (compact synthesis strip)
// ============================================================================

function WisdomHero({ wisdom, counts, para }: {
  wisdom?: WisdomSnapshot; counts: GlobalDashboardSnapshot['meta']['counts']; para?: GlobalDashboardSnapshot['para'];
}) {
  const [open, setOpen] = useState(false);
  const headline = wisdom?.headline || 'The second brain';
  const narrative = wisdom?.narrative
    || 'What you know across your projects — organized by actionability (PARA) and distilled to wisdom (DIKW).';
  const insights = wisdom?.insights ?? [];
  const gaps = wisdom?.gaps ?? [];

  const tiers = [
    { key: 'W', label: 'Wisdom', n: insights.length },
    { key: 'K', label: 'Knowledge', n: (para?.areas.length ?? 0) + (para?.subjects.length ?? 0) },
    { key: 'I', label: 'Information', n: counts.businessDomains + counts.techDomains },
    { key: 'D', label: 'Data', n: counts.projects },
  ];

  return (
    <div className="profile-hero wisdom-hero">
      <div className="hero-main">
        <div className="hero-label">// synthesized wisdom {wisdom?.grounding ? `· ${wisdom.grounding}` : ''}</div>
        <h1 className="hero-title">{headline}</h1>
        <p className="hero-sub">{narrative}</p>
        {(insights.length > 0 || gaps.length > 0) && (
          <button className="synth-toggle" onClick={() => setOpen(!open)}>
            {open ? 'hide' : 'show'} {insights.length} insight(s) · {gaps.length} gap(s)
          </button>
        )}
        {open && (
          <div className="synth-strip">
            {insights.length > 0 && (
              <div className="synth-col">
                <h4>Insights &amp; principles</h4>
                {insights.map((i: WisdomInsight) => (
                  <div key={i.id} className="synth-item">
                    <span className={`kind-badge ${i.kind === 'principle' ? 'principle' : 'insight'}`}>{i.kind}</span>
                    <span className="synth-title">{i.title}</span>
                    {i.body && <p className="sub">{i.body}</p>}
                  </div>
                ))}
              </div>
            )}
            {gaps.length > 0 && (
              <div className="synth-col">
                <h4>Gaps to close</h4>
                {gaps.map((g: WisdomGap) => (
                  <div key={g.id} className="synth-item">
                    {g.severity && <span className="sev-badge" style={sevStyle(g.severity)}>{g.severity}</span>}
                    <span className="synth-title">{g.title}</span>
                    {g.recommendation && <div className="gap-rec">→ {g.recommendation}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="dikw" aria-label="DIKW pyramid">
        {tiers.map((t, i) => (
          <div key={t.key} className="dikw-tier" style={{ width: `${55 + i * 15}%` }}>
            <span className="dikw-k">{t.key}</span>
            <span className="dikw-n">{t.n}</span>
            <span className="dikw-l">{t.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const SEVERITY_COLOR: Record<string, string> = { high: '#e0563c', medium: '#caa23c', low: '#4caf78' };
function sevStyle(sev: string) {
  const c = SEVERITY_COLOR[sev.toLowerCase()] ?? '#8a8f98';
  return { color: c, borderColor: c };
}

// ============================================================================
// Projects (active) + Archive
// ============================================================================

function relTime(ts?: number): string {
  if (!ts) return '';
  const days = Math.round((Date.now() - ts) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

function ProjectsView({ projects, onOpen, hasGraph }: {
  projects: ParaProject[]; onOpen: (id: string) => void; hasGraph: (id: string) => boolean;
}) {
  if (projects.length === 0) return <section className="profile-section"><p className="sub">No active projects. Recent work shows up here.</p></section>;
  return (
    <section className="profile-section">
      <h2 className="sect-title">Projects <span className="sect-hint">active work, by recency</span></h2>
      <div className="comp-grid">
        {projects.map((p) => <ProjectCard key={p.id} p={p} onOpen={onOpen} canOpen={hasGraph(p.id)} />)}
      </div>
    </section>
  );
}

function ArchiveView({ projects, onOpen, hasGraph }: {
  projects: ParaProject[]; onOpen: (id: string) => void; hasGraph: (id: string) => boolean;
}) {
  if (projects.length === 0) return <section className="profile-section"><p className="sub">Nothing archived. Inactive projects move here.</p></section>;
  return (
    <section className="profile-section">
      <h2 className="sect-title">Archive <span className="sect-hint">inactive, kept for reference</span></h2>
      <div className="comp-grid">
        {projects.map((p) => <ProjectCard key={p.id} p={p} onOpen={onOpen} canOpen={hasGraph(p.id)} muted />)}
      </div>
    </section>
  );
}

function ProjectCard({ p, onOpen, canOpen, muted }: {
  p: ParaProject; onOpen: (id: string) => void; canOpen: boolean; muted?: boolean;
}) {
  return (
    <div className={`comp-card ${muted ? 'muted' : ''}`}>
      <div className="comp-head">
        <span className="comp-name">{p.name}</span>
        {p.lastActiveAt && <span className="rel-time">{relTime(p.lastActiveAt)}</span>}
      </div>
      {p.focus && <p className="comp-sum">{p.focus}</p>}
      {p.topics.length > 0 && (
        <div className="comp-skills">
          {p.topics.slice(0, 8).map((t) => <span key={t} className="skill-pill">{t}</span>)}
        </div>
      )}
      {canOpen && <button className="drill-btn sm" onClick={() => onOpen(p.id)}>Open knowledge graph →</button>}
    </div>
  );
}

// ============================================================================
// Areas (ongoing competencies, Dreyfus-leveled)
// ============================================================================

function AreasView({ areas }: { areas: ParaArea[] }) {
  if (areas.length === 0) return <section className="profile-section"><p className="sub">No competency areas yet.</p></section>;
  return (
    <section className="profile-section">
      <h2 className="sect-title">Areas <span className="sect-hint">competencies you maintain · leveled by evidence</span></h2>
      <div className="comp-grid">
        {areas.map((a) => <AreaCard key={a.id} a={a} />)}
      </div>
    </section>
  );
}

function AreaCard({ a }: { a: ParaArea }) {
  const [expanded, setExpanded] = useState(false);
  const level = (a.level || 'competent').toLowerCase();
  const color = LEVEL_COLOR[level] ?? '#8a8f98';
  const shown = expanded ? a.skills : a.skills.slice(0, 10);
  const rest = a.skills.length - shown.length;
  return (
    <div className="comp-card">
      <div className="comp-head">
        <span className="comp-name">{a.name}</span>
        <span className="lvl-badge" style={{ color, borderColor: color }}>{LEVEL_LABELS_PROF[level] ?? level}</span>
      </div>
      <div className="comp-meta">
        {a.skills.length} skill(s){a.projectCount > 1 ? ` · ×${a.projectCount} repos` : ''}{a.grounding ? ` · ${a.grounding}` : ''}
      </div>
      <LevelMeter level={level} />
      {a.summary && <p className="comp-sum">{a.summary}</p>}
      <div className="comp-skills">
        {shown.map((s) => (
          <span key={s.name} className="skill-pill" title={`${LEVEL_LABELS_PROF[(s.level ?? '').toLowerCase()] ?? ''} w=${s.weight.toFixed(1)}`}>
            <i className="skill-dot" style={{ background: LEVEL_COLOR[(s.level ?? '').toLowerCase()] ?? '#8a8f98' }} />
            {s.name}
          </span>
        ))}
        {rest > 0 && <button className="more-pill" onClick={() => setExpanded(true)}>+{rest} more</button>}
        {expanded && a.skills.length > 10 && <button className="more-pill" onClick={() => setExpanded(false)}>show less</button>}
      </div>
      {(a.projects.length > 0 || a.domains.length > 0) && (
        <div className="area-refs">
          {[...a.domains, ...a.projects].slice(0, 6).map((r) => <span key={r} className="ref-chip">{r}</span>)}
        </div>
      )}
    </div>
  );
}

function LevelMeter({ level }: { level: string }) {
  const idx = LEVEL_ORDER.indexOf(level as never);
  const color = LEVEL_COLOR[level] ?? '#8a8f98';
  return (
    <span className="lvl-meter" title={LEVEL_LABELS_PROF[level] ?? level}>
      {LEVEL_ORDER.map((_, i) => (
        <i key={i} className={`lvl-dot ${i <= idx ? 'on' : ''}`} style={i <= idx ? { background: color } : undefined} />
      ))}
    </span>
  );
}

// ============================================================================
// Resources — the hierarchical subject → topic → item explorer (no graph)
// ============================================================================

function ResourcesView({ subjects }: { subjects: ParaSubject[] }) {
  const [activeSubject, setActiveSubject] = useState<string | null>(null);
  const maxWeight = useMemo(() => Math.max(1, ...subjects.map((s) => s.weight)), [subjects]);

  if (subjects.length === 0) {
    return <section className="profile-section"><p className="sub">No subjects yet. The library of what you know is built from your skills, concepts, and domains.</p></section>;
  }

  const current = subjects.find((s) => s.id === activeSubject) ?? null;

  return (
    <section className="profile-section">
      <h2 className="sect-title">Resources <span className="sect-hint">your knowledge library · subjects → topics</span></h2>
      <div className="subject-grid">
        {subjects.map((s) => {
          const span = Math.max(1, Math.round((s.weight / maxWeight) * 3));
          const active = s.id === activeSubject;
          return (
            <button
              key={s.id}
              className={`subject-tile ${active ? 'active' : ''}`}
              style={{ gridColumn: `span ${span}` }}
              onClick={() => setActiveSubject(active ? null : s.id)}
            >
              <span className="subject-name">{s.name}</span>
              <span className="subject-meta">{s.topics.length} topic(s)</span>
              {s.summary && <span className="subject-sum">{s.summary}</span>}
            </button>
          );
        })}
      </div>

      {current && (
        <div className="topic-panel">
          <div className="topic-panel-head">
            <h3>{current.name}</h3>
            <button className="crumb" onClick={() => setActiveSubject(null)}>close</button>
          </div>
          <div className="topic-list">
            {current.topics.map((t) => <TopicRow key={t.id} topic={t} />)}
          </div>
        </div>
      )}
    </section>
  );
}

const ITEM_COLOR: Record<string, string> = {
  skill: '#e8743c', concept: '#b45ad6', domain: '#3c8ce0', entity: '#4caf78',
};

function TopicRow({ topic }: { topic: ParaTopic }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="topic-row">
      <button className="topic-head" onClick={() => setOpen(!open)}>
        <span className="topic-caret">{open ? '▾' : '▸'}</span>
        <span className="topic-name">{topic.name}</span>
        <span className="topic-n">{topic.items.length}</span>
      </button>
      {topic.summary && !open && <p className="topic-sum">{topic.summary}</p>}
      {open && (
        <div className="topic-items">
          {topic.summary && <p className="topic-sum">{topic.summary}</p>}
          {topic.items.map((it) => (
            <span key={`${it.kind}:${it.name}`} className="item-pill">
              <i className="item-dot" style={{ background: ITEM_COLOR[it.kind] ?? '#8a8f98' }} />
              {it.name}
              <span className="item-kind">{it.kind}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Per-project detail — nested knowledge explorer (replaces force graph)
// ============================================================================

interface TreeNode { node: KnowledgeNode; children: TreeNode[] }

function ProjectDetail({ snapshot }: { snapshot: DashboardSnapshot }) {
  const tree = useMemo(() => buildKnowledgeTree(snapshot.knowledge.nodes, snapshot.knowledge.edges), [snapshot]);
  if (tree.length === 0) {
    return <section className="profile-section"><p className="sub">No knowledge graph for this project yet.</p></section>;
  }
  return (
    <section className="profile-section">
      <h2 className="sect-title">Knowledge <span className="sect-hint">domains → concepts/entities → facts</span></h2>
      <div className="topic-list">
        {tree.map((t) => <KnowledgeRow key={t.node.id} tn={t} depth={0} />)}
      </div>
    </section>
  );
}

function KnowledgeRow({ tn, depth }: { tn: TreeNode; depth: number }) {
  const [open, setOpen] = useState(depth === 0);
  const hasChildren = tn.children.length > 0;
  const color = KNOWLEDGE_COLORS[tn.node.level] ?? '#8a8f98';
  return (
    <div className="topic-row" style={{ marginLeft: depth ? 14 : 0 }}>
      <button className="topic-head" onClick={() => hasChildren && setOpen(!open)}>
        <span className="topic-caret">{hasChildren ? (open ? '▾' : '▸') : '·'}</span>
        <i className="skill-dot" style={{ background: color }} />
        <span className="topic-name">{tn.node.label}</span>
        <span className="k-kind">{KNOWLEDGE_LABELS[tn.node.level] ?? tn.node.kind}</span>
        {hasChildren && <span className="topic-n">{tn.children.length}</span>}
      </button>
      {open && tn.node.summary && <p className="topic-sum" style={{ marginLeft: 14 }}>{tn.node.summary}</p>}
      {open && hasChildren && (
        <div className="topic-items-nested">
          {tn.children.map((c) => <KnowledgeRow key={c.node.id} tn={c} depth={depth + 1} />)}
        </div>
      )}
    </div>
  );
}

/** Build a containment tree: domains at the root, everything else nested under part_of/in_concept. */
function buildKnowledgeTree(nodes: KnowledgeNode[], edges: KnowledgeEdge[]): TreeNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parentOf = new Map<string, string>();
  const CONTAIN = new Set(['part_of', 'in_concept', 'owned_by', 'governed_by']);
  for (const e of edges) {
    if (CONTAIN.has(e.kind) && byId.has(e.source) && byId.has(e.target) && !parentOf.has(e.source)) {
      parentOf.set(e.source, e.target);
    }
  }
  const tnById = new Map<string, TreeNode>(nodes.map((n) => [n.id, { node: n, children: [] }]));
  const roots: TreeNode[] = [];
  const rank: Record<string, number> = { business_domain: 0, tech_domain: 1, concept: 2, entity: 3, fact: 4 };
  for (const n of nodes) {
    const parent = parentOf.get(n.id);
    const tn = tnById.get(n.id)!;
    if (parent && tnById.has(parent) && parent !== n.id) tnById.get(parent)!.children.push(tn);
    else roots.push(tn);
  }
  const sortRec = (list: TreeNode[]) => {
    list.sort((a, b) => (rank[a.node.level] ?? 9) - (rank[b.node.level] ?? 9) || a.node.label.localeCompare(b.node.label));
    for (const t of list) sortRec(t.children);
  };
  sortRec(roots);
  // Keep the root list to true zones when present, so it reads as a clean taxonomy.
  const zones = roots.filter((t) => t.node.level === 'business_domain' || t.node.level === 'tech_domain');
  return zones.length ? [...zones, ...roots.filter((t) => t.node.level !== 'business_domain' && t.node.level !== 'tech_domain' && t.children.length > 0)] : roots;
}

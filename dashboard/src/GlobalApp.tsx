import { useEffect, useMemo, useState } from 'react';
import type {
  GlobalDashboardSnapshot, WisdomSnapshot, WisdomInsight, WisdomGap,
  ParaArea, ParaProject, ParaSubject, ParaTopic, DashboardSnapshot, KnowledgeNode, KnowledgeEdge,
} from './types';
import {
  LEVEL_ORDER, LEVEL_LABELS_PROF, LEVEL_COLOR, KNOWLEDGE_LABELS, KNOWLEDGE_COLORS,
} from './types';

type View = 'projects' | 'areas' | 'resources' | 'archive';

const VIEW_META: Record<View, { label: string; hint: string }> = {
  projects: { label: 'Projects', hint: 'active work, ranked by recency' },
  areas: { label: 'Areas', hint: 'competencies maintained across repos' },
  resources: { label: 'Resources', hint: 'knowledge library · subjects → topics → items' },
  archive: { label: 'Archive', hint: 'inactive projects kept for reference' },
};

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

  const counts = useMemo(() => {
    const subjects = para?.subjects ?? [];
    const topics = subjects.reduce((n, s) => n + s.topics.length, 0);
    const items = subjects.reduce((n, s) => n + s.topics.reduce((m, t) => m + t.items.length, 0), 0);
    const skills = (para?.areas ?? []).reduce((n, a) => n + a.skills.length, 0);
    return {
      projects: para?.projects.length ?? 0,
      areas: para?.areas.length ?? 0,
      subjects: subjects.length,
      topics,
      items,
      skills,
      archive: para?.archives.length ?? 0,
      insights: wisdom?.insights.length ?? 0,
      gaps: wisdom?.gaps.length ?? 0,
    };
  }, [para, wisdom]);

  const empty = !para || (counts.projects + counts.areas + counts.subjects + counts.archive === 0);
  const viewCount = counts[view === 'resources' ? 'subjects' : view];

  const goView = (v: View) => { setView(v); setDrillProjectId(null); };

  return (
    <div className="app global-app">
      <header className="topbar global-topbar">
        <div className="content-frame topbar-shell">
        <div className="topbar-row">
          <span className="brand">subnet<span className="brand-dot">/</span><span className="brand-mode">global</span></span>
          <nav className="tabs" aria-label="PARA navigation">
            {(['projects', 'areas', 'resources', 'archive'] as View[]).map((v) => (
              <button
                key={v}
                className={`tab ${view === v && !drillProjectId ? 'active' : ''}`}
                onClick={() => goView(v)}
              >
                {v}
                <span className="tab-n">{counts[v === 'resources' ? 'subjects' : v]}</span>
              </button>
            ))}
          </nav>
          <div className="topbar-stats">
            <span className="top-stat"><b>{c.projects}</b> repos</span>
            <span className="top-stat"><b>{counts.skills}</b> skills</span>
            <span className="top-stat"><b>{counts.items}</b> items</span>
          </div>
        </div>
        {(drillProjectId || !empty) && (
          <div className="topbar-sub">
            {drillProjectId ? (
              <div className="crumbs">
                <button className="crumb" onClick={() => setDrillProjectId(null)}>{view}</button>
                <span className="sep">/</span>
                <span className="crumb active">{drillLabel}</span>
              </div>
            ) : (
              <p className="view-lede">
                <strong>{VIEW_META[view].label}</strong>
                <span className="view-lede-sep">·</span>
                {VIEW_META[view].hint}
                <span className="view-lede-count">{viewCount} record{viewCount === 1 ? '' : 's'}</span>
              </p>
            )}
          </div>
        )}
        </div>
      </header>

      <div className="body">
        <div className="main">
          <div className="content-frame dashboard-shell">
            {!drillProject && !empty && <StatsBar counts={counts} meta={c} />}
            {!drillProject && <WisdomHero wisdom={wisdom} counts={counts} />}

            {empty && (
              <p className="sub empty-hint">
                No organized knowledge yet. Run <code>subnet update --global</code> across your projects, then <code>subnet global wisdom</code>.
              </p>
            )}

            {drillProject ? (
              <ProjectDetail snapshot={drillProject} />
            ) : (
              <div className="view-panel">
                {view === 'projects' && (
                  <ProjectsView
                    projects={para?.projects ?? []}
                    onOpen={setDrillProjectId}
                    hasGraph={(id) => !!snapshot.drillDown[id]}
                  />
                )}
                {view === 'areas' && <AreasView areas={para?.areas ?? []} />}
                {view === 'resources' && <ResourcesView subjects={para?.subjects ?? []} />}
                {view === 'archive' && (
                  <ArchiveView
                    projects={para?.archives ?? []}
                    onOpen={setDrillProjectId}
                    hasGraph={(id) => !!snapshot.drillDown[id]}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Portfolio stats (data-first strip)
// ============================================================================

function StatsBar({ counts, meta }: {
  counts: Record<string, number>;
  meta: GlobalDashboardSnapshot['meta']['counts'];
}) {
  const stats = [
    { n: counts.projects, label: 'active projects', accent: true },
    { n: counts.areas, label: 'competency areas' },
    { n: counts.subjects, label: 'subjects' },
    { n: counts.topics, label: 'topics' },
    { n: counts.items, label: 'knowledge items' },
    { n: meta.businessDomains + meta.techDomains, label: 'domains' },
    { n: counts.insights, label: 'insights' },
    { n: counts.gaps, label: 'gaps', warn: counts.gaps > 0 },
  ];
  return (
    <div className="stats-bar" aria-label="Portfolio metrics">
      {stats.map((s) => (
        <div key={s.label} className={`stat-chip ${s.accent ? 'accent' : ''} ${s.warn ? 'warn' : ''}`}>
          <span className="stat-chip-n">{s.n}</span>
          <span className="stat-chip-l">{s.label}</span>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// Wisdom (compact synthesis + DIKW metrics)
// ============================================================================

function WisdomHero({ wisdom, counts }: {
  wisdom?: WisdomSnapshot;
  counts: Record<string, number>;
}) {
  const [open, setOpen] = useState(false);
  const headline = wisdom?.headline || 'Knowledge portfolio';
  const narrative = wisdom?.narrative
    || 'Cross-project knowledge organized by PARA and distilled toward wisdom.';
  const insights = wisdom?.insights ?? [];
  const gaps = wisdom?.gaps ?? [];

  const tiers = [
    { key: 'W', label: 'Wisdom', n: counts.insights },
    { key: 'K', label: 'Knowledge', n: counts.areas + counts.subjects },
    { key: 'I', label: 'Information', n: counts.topics },
    { key: 'D', label: 'Data', n: counts.items },
  ];

  return (
    <section className="wisdom-band">
      <div className="wisdom-band-main">
        <div className="wisdom-band-head">
          <span className="hero-label">
            synthesized wisdom{wisdom?.grounding ? ` · ${wisdom.grounding}` : ''}
          </span>
          <div className="dikw-inline" aria-label="DIKW pyramid counts">
            {tiers.map((t) => (
              <span key={t.key} className="dikw-chip" title={t.label}>
                <span className="dikw-chip-k">{t.key}</span>
                <span className="dikw-chip-n">{t.n}</span>
              </span>
            ))}
          </div>
        </div>
        <h1 className="wisdom-headline">{headline}</h1>
        <p className="wisdom-lede">{narrative}</p>
        {(insights.length > 0 || gaps.length > 0) && (
          <button className="synth-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'Hide' : 'Show'} synthesis — {insights.length} insight{insights.length === 1 ? '' : 's'}, {gaps.length} gap{gaps.length === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {open && (insights.length > 0 || gaps.length > 0) && (
        <div className="synth-grid">
          {insights.length > 0 && (
            <div className="synth-col">
              <h4>Insights &amp; principles <span className="col-count">{insights.length}</span></h4>
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
              <h4>Gaps to close <span className="col-count">{gaps.length}</span></h4>
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
    </section>
  );
}

const SEVERITY_COLOR: Record<string, string> = { high: '#e0563c', medium: '#caa23c', low: '#4caf78' };
function sevStyle(sev: string) {
  const c = SEVERITY_COLOR[sev.toLowerCase()] ?? '#8a8f98';
  return { color: c, borderColor: c };
}

// ============================================================================
// Projects + Archive
// ============================================================================

function relTime(ts?: number): string {
  if (!ts) return '—';
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
  if (projects.length === 0) {
    return <EmptyState message="No active projects. Recent work surfaces here after a global update." />;
  }
  return (
    <div className="data-grid">
      {projects.map((p) => <ProjectCard key={p.id} p={p} onOpen={onOpen} canOpen={hasGraph(p.id)} />)}
    </div>
  );
}

function ArchiveView({ projects, onOpen, hasGraph }: {
  projects: ParaProject[]; onOpen: (id: string) => void; hasGraph: (id: string) => boolean;
}) {
  if (projects.length === 0) {
    return <EmptyState message="Nothing archived. Inactive projects move here automatically." />;
  }
  return (
    <div className="data-grid">
      {projects.map((p) => <ProjectCard key={p.id} p={p} onOpen={onOpen} canOpen={hasGraph(p.id)} muted />)}
    </div>
  );
}

function ProjectCard({ p, onOpen, canOpen, muted }: {
  p: ParaProject; onOpen: (id: string) => void; canOpen: boolean; muted?: boolean;
}) {
  return (
    <article className={`data-card ${muted ? 'muted' : ''}`}>
      <div className="data-card-head">
        <h3 className="data-card-title">{p.name}</h3>
        <span className="data-metric">{relTime(p.lastActiveAt)}</span>
      </div>
      <div className="data-card-meta">
        <span className="meta-pill">{p.topics.length} topic{p.topics.length === 1 ? '' : 's'}</span>
        <span className={`status-pill ${p.status}`}>{p.status}</span>
      </div>
      {p.focus && <p className="data-card-body">{p.focus}</p>}
      {p.topics.length > 0 && (
        <div className="tag-row">
          {p.topics.slice(0, 6).map((t) => <span key={t} className="skill-pill">{t}</span>)}
          {p.topics.length > 6 && <span className="more-pill static">+{p.topics.length - 6}</span>}
        </div>
      )}
      {canOpen && (
        <button className="card-action" onClick={() => onOpen(p.id)}>
          Open knowledge tree →
        </button>
      )}
    </article>
  );
}

// ============================================================================
// Areas
// ============================================================================

function AreasView({ areas }: { areas: ParaArea[] }) {
  const sorted = useMemo(
    () => [...areas].sort((a, b) => b.weight - a.weight || b.skills.length - a.skills.length),
    [areas],
  );
  if (areas.length === 0) {
    return <EmptyState message="No competency areas yet. Run organize + wisdom to group skills by domain." />;
  }
  return (
    <div className="data-grid areas-grid">
      {sorted.map((a) => <AreaCard key={a.id} a={a} />)}
    </div>
  );
}

function AreaCard({ a }: { a: ParaArea }) {
  const [expanded, setExpanded] = useState(false);
  const level = (a.level || 'competent').toLowerCase();
  const color = LEVEL_COLOR[level] ?? '#8a8f98';
  const shown = expanded ? a.skills : a.skills.slice(0, 8);
  const rest = a.skills.length - shown.length;
  return (
    <article className="data-card">
      <div className="data-card-head">
        <h3 className="data-card-title">{a.name}</h3>
        <span className="lvl-badge" style={{ color, borderColor: color }}>{LEVEL_LABELS_PROF[level] ?? level}</span>
      </div>
      <div className="data-card-meta">
        <span className="data-metric strong">{a.weight.toFixed(1)} weight</span>
        <span className="meta-pill">{a.skills.length} skills</span>
        {a.projectCount > 1 && <span className="meta-pill">×{a.projectCount} repos</span>}
      </div>
      <LevelMeter level={level} />
      {a.summary && <p className="data-card-body">{a.summary}</p>}
      <div className="tag-row">
        {shown.map((s) => (
          <span key={s.name} className="skill-pill" title={`${LEVEL_LABELS_PROF[(s.level ?? '').toLowerCase()] ?? ''} · w=${s.weight.toFixed(1)}`}>
            <i className="skill-dot" style={{ background: LEVEL_COLOR[(s.level ?? '').toLowerCase()] ?? '#8a8f98' }} />
            {s.name}
          </span>
        ))}
        {rest > 0 && <button className="more-pill" onClick={() => setExpanded(true)}>+{rest}</button>}
        {expanded && a.skills.length > 8 && <button className="more-pill" onClick={() => setExpanded(false)}>less</button>}
      </div>
      {(a.projects.length > 0 || a.domains.length > 0) && (
        <div className="tag-row muted-row">
          {[...a.domains, ...a.projects].slice(0, 5).map((r) => <span key={r} className="ref-chip">{r}</span>)}
        </div>
      )}
    </article>
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
// Resources — master/detail split (data-centered explorer)
// ============================================================================

function ResourcesView({ subjects }: { subjects: ParaSubject[] }) {
  const sorted = useMemo(
    () => [...subjects].sort((a, b) => b.weight - a.weight),
    [subjects],
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const maxWeight = useMemo(() => Math.max(1, ...sorted.map((s) => s.weight)), [sorted]);

  useEffect(() => {
    if (sorted.length && !sorted.some((s) => s.id === activeId)) {
      setActiveId(sorted[0].id);
    }
  }, [sorted, activeId]);

  if (subjects.length === 0) {
    return <EmptyState message="No subjects yet. Skills, concepts, and domains cluster here after organization." />;
  }

  const current = sorted.find((s) => s.id === activeId) ?? sorted[0];
  const itemCount = current.topics.reduce((n, t) => n + t.items.length, 0);

  return (
    <div className="split-view">
      <aside className="split-nav" aria-label="Subjects">
        <div className="split-nav-head">
          <span>Subjects</span>
          <span className="split-nav-count">{sorted.length}</span>
        </div>
        <ul className="subject-list">
          {sorted.map((s) => {
            const active = s.id === current.id;
            const pct = Math.round((s.weight / maxWeight) * 100);
            const topics = s.topics.length;
            const items = s.topics.reduce((n, t) => n + t.items.length, 0);
            return (
              <li key={s.id}>
                <button
                  className={`subject-row ${active ? 'active' : ''}`}
                  onClick={() => setActiveId(s.id)}
                  aria-current={active ? 'true' : undefined}
                >
                  <span className="subject-row-top">
                    <span className="subject-row-name">{s.name}</span>
                    <span className="subject-row-n">{items}</span>
                  </span>
                  <span className="weight-bar" aria-hidden>
                    <i style={{ width: `${pct}%` }} />
                  </span>
                  <span className="subject-row-meta">{topics} topic{topics === 1 ? '' : 's'} · w={s.weight.toFixed(1)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <div className="split-detail">
        <header className="split-detail-head">
          <div>
            <h2 className="split-detail-title">{current.name}</h2>
            {current.summary && <p className="split-detail-sum">{current.summary}</p>}
          </div>
          <div className="split-detail-stats">
            <span className="detail-stat"><b>{current.topics.length}</b> topics</span>
            <span className="detail-stat"><b>{itemCount}</b> items</span>
            <span className="detail-stat"><b>{current.weight.toFixed(1)}</b> weight</span>
          </div>
        </header>
        <div className="topic-list dense">
          {current.topics.map((t) => <TopicRow key={t.id} topic={t} />)}
        </div>
      </div>
    </div>
  );
}

const ITEM_COLOR: Record<string, string> = {
  skill: '#e8743c', concept: '#b45ad6', domain: '#3c8ce0', entity: '#4caf78',
};

function TopicRow({ topic }: { topic: ParaTopic }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="topic-row">
      <button className="topic-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="topic-caret">{open ? '▾' : '▸'}</span>
        <span className="topic-name">{topic.name}</span>
        <span className="topic-weight">w={topic.weight.toFixed(1)}</span>
        <span className="topic-n">{topic.items.length}</span>
      </button>
      {topic.summary && !open && <p className="topic-sum">{topic.summary}</p>}
      {open && (
        <div className="topic-body">
          {topic.summary && <p className="topic-sum">{topic.summary}</p>}
          <div className="topic-items">
            {topic.items.map((it) => (
              <span key={`${it.kind}:${it.name}`} className="item-pill">
                <i className="item-dot" style={{ background: ITEM_COLOR[it.kind] ?? '#8a8f98' }} />
                {it.name}
                <span className="item-kind">{it.kind}</span>
                <span className="item-w">{it.weight.toFixed(1)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Per-project knowledge tree
// ============================================================================

interface TreeNode { node: KnowledgeNode; children: TreeNode[] }

function ProjectDetail({ snapshot }: { snapshot: DashboardSnapshot }) {
  const tree = useMemo(() => buildKnowledgeTree(snapshot.knowledge.nodes, snapshot.knowledge.edges), [snapshot]);
  const c = snapshot.meta.counts;
  if (tree.length === 0) {
    return <EmptyState message="No knowledge graph for this project yet." />;
  }
  return (
    <section className="project-detail">
      <header className="split-detail-head">
        <div className="split-detail-stats">
          <span className="detail-stat"><b>{c.knowledgeNodes}</b> nodes</span>
          <span className="detail-stat"><b>{c.knowledgeEdges}</b> edges</span>
          <span className="detail-stat"><b>{c.concepts}</b> concepts</span>
        </div>
      </header>
      <div className="topic-list dense">
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
    <div className="topic-row" style={{ marginLeft: depth ? 12 : 0 }}>
      <button className="topic-head" onClick={() => hasChildren && setOpen(!open)} aria-expanded={open}>
        <span className="topic-caret">{hasChildren ? (open ? '▾' : '▸') : '·'}</span>
        <i className="skill-dot" style={{ background: color }} />
        <span className="topic-name">{tn.node.label}</span>
        <span className="k-kind">{KNOWLEDGE_LABELS[tn.node.level] ?? tn.node.kind}</span>
        {hasChildren && <span className="topic-n">{tn.children.length}</span>}
      </button>
      {open && tn.node.summary && <p className="topic-sum">{tn.node.summary}</p>}
      {open && hasChildren && (
        <div className="topic-items-nested">
          {tn.children.map((c) => <KnowledgeRow key={c.node.id} tn={c} depth={depth + 1} />)}
        </div>
      )}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return <p className="empty-state">{message}</p>;
}

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
  const zones = roots.filter((t) => t.node.level === 'business_domain' || t.node.level === 'tech_domain');
  return zones.length
    ? [...zones, ...roots.filter((t) => t.node.level !== 'business_domain' && t.node.level !== 'tech_domain' && t.children.length > 0)]
    : roots;
}

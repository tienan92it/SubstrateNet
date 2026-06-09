import { useMemo, useState } from 'react';
import type {
  GlobalDashboardSnapshot, HierarchyNode, HierarchyLevel, KnowledgeNode,
  WisdomSnapshot, WisdomCompetency, WisdomInsight, WisdomGap,
} from './types';
import {
  LEVEL_COLORS, LEVEL_LABELS, KNOWLEDGE_COLORS, KNOWLEDGE_LABELS,
  LEVEL_ORDER, LEVEL_LABELS_PROF, LEVEL_COLOR,
} from './types';
import { ForceGraph, type FGNode } from './ForceGraph';

type View = 'profile' | 'map';

/** Bigger nodes for higher levels / more cross-project coverage. */
function nodeSize(n: HierarchyNode): number {
  const base: Record<HierarchyLevel, number> = {
    workspace: 8, industry: 6, business_domain: 4, tech_domain: 3, project: 3, file: 1,
  };
  return base[n.level] + Math.min(4, (n.projectCount ?? 1) - 1);
}

export function GlobalApp({ snapshot }: { snapshot: GlobalDashboardSnapshot }) {
  const [view, setView] = useState<View>('profile');
  const [drillProjectId, setDrillProjectId] = useState<string | null>(null);
  const [selected, setSelected] = useState<HierarchyNode | null>(null);
  const [selectedK, setSelectedK] = useState<KnowledgeNode | null>(null);

  const c = snapshot.meta.counts;
  const drillProject = drillProjectId ? snapshot.drillDown[drillProjectId] : undefined;
  const drillLabel = useMemo(() => {
    if (!drillProjectId) return '';
    const n = snapshot.hierarchy.nodes.find((x) => x.projectId === drillProjectId);
    return n?.label ?? drillProjectId;
  }, [drillProjectId, snapshot]);

  const goMap = () => { setView('map'); };

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">subnet<span className="brand-dot">/</span><span className="brand-mode">global</span></span>
        <div className="tabs">
          <button className={`tab ${view === 'profile' ? 'active' : ''}`} onClick={() => setView('profile')}>profile</button>
          <button className={`tab ${view === 'map' && !drillProjectId ? 'active' : ''}`} onClick={() => { setView('map'); setDrillProjectId(null); }}>map</button>
        </div>
        {view === 'map' && drillProjectId && (
          <div className="crumbs">
            <button className="crumb" onClick={() => { setDrillProjectId(null); setSelectedK(null); }}>map</button>
            <span className="sep">/</span><span className="crumb active">{drillLabel}</span>
          </div>
        )}
        <span className="counts">
          <b>{c.projects}</b> projects · <b>{c.industries}</b> industries · <b>{c.businessDomains}</b> biz · <b>{c.techDomains}</b> tech
        </span>
      </div>

      {view === 'map' && !drillProjectId && <LevelLegend />}

      <div className="body">
        <div className="main">
          {view === 'profile' && <ProfileView snapshot={snapshot} onOpenMap={goMap} />}
          {view === 'map' && !drillProject && (
            <HierarchyView
              snapshot={snapshot}
              onSelect={setSelected}
              onDrill={(pid) => { setDrillProjectId(pid); setSelected(null); }}
            />
          )}
          {view === 'map' && drillProject && (
            <DrillKnowledgeView snapshot={drillProject} onSelect={setSelectedK} />
          )}
        </div>

        {view === 'map' && !drillProject && selected && (
          <aside className="side">
            <span className="grounding" style={{ color: LEVEL_COLORS[selected.level] }}>{LEVEL_LABELS[selected.level]}</span>
            <h3>{selected.label}</h3>
            <div className="meta">
              {selected.projectCount ? `${selected.projectCount} project(s)` : ''}
              {selected.grounding ? ` · ${selected.grounding}` : ''}
            </div>
            {selected.summary && <p className="summary">{selected.summary}</p>}
            {selected.level === 'project' && selected.projectId && snapshot.drillDown[selected.projectId] && (
              <button className="drill-btn" onClick={() => { setDrillProjectId(selected.projectId!); setSelected(null); }}>
                Open knowledge graph →
              </button>
            )}
            {selected.level === 'project' && selected.projectId && !snapshot.drillDown[selected.projectId] && (
              <p className="sub">No local graph available for this project.</p>
            )}
          </aside>
        )}

        {view === 'map' && drillProject && selectedK && (
          <aside className="side">
            <span className="grounding" style={{ color: KNOWLEDGE_COLORS[selectedK.level] }}>{KNOWLEDGE_LABELS[selectedK.level]}</span>
            <h3>{selectedK.label}</h3>
            <div className="meta">
              {selectedK.kind}
              {selectedK.scope ? ` · ${selectedK.scope}` : ''}
              {selectedK.grounding ? ` · ${selectedK.grounding}` : ''}
            </div>
            {selectedK.summary && <p className="summary">{selectedK.summary}</p>}
          </aside>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Profile view — the balanced DIKW professional profile (Wisdom-first)
// ============================================================================

function ProfileView({ snapshot, onOpenMap }: { snapshot: GlobalDashboardSnapshot; onOpenMap: () => void }) {
  const { profile } = snapshot;
  const wisdom: WisdomSnapshot | undefined = snapshot.wisdom;
  const c = snapshot.meta.counts;

  const hasWisdom = !!wisdom && (wisdom.competencies.length > 0 || !!wisdom.headline);
  const emptyAll = !hasWisdom && profile.industries.length === 0 && profile.skills.length === 0 && profile.highlights.length === 0;

  return (
    <div className="profile">
      <WisdomHero wisdom={wisdom} counts={c} />

      {emptyAll && (
        <p className="sub empty-hint">No profile data yet. Run <code>subnet update --global</code> across your projects to aggregate skills and synthesize wisdom.</p>
      )}

      {!hasWisdom && !emptyAll && (
        <p className="sub empty-hint">
          Knowledge aggregated, but the wisdom layer is not synthesized yet. Run <code>subnet global wisdom</code> to
          classify competencies, distill insights, and surface gaps.
        </p>
      )}

      {profile.industries.length > 0 && (
        <section className="profile-section">
          <h2 className="sect-title">Industries <span className="sect-hint">the domains you build in</span></h2>
          <div className="chips">
            {profile.industries.map((i) => (
              <span key={i.name} className="chip">
                {i.name}
                <span className="chip-n">{i.projectCount}×</span>
              </span>
            ))}
          </div>
        </section>
      )}

      {hasWisdom && wisdom!.competencies.length > 0 && (
        <CompetencyMap competencies={wisdom!.competencies} />
      )}

      {/* Fallback to flat skills when no competency grouping exists yet. */}
      {!hasWisdom && profile.skills.length > 0 && <FlatSkills skills={profile.skills} />}

      {hasWisdom && wisdom!.insights.length > 0 && (
        <InsightsSection insights={wisdom!.insights} />
      )}

      {hasWisdom && wisdom!.gaps.length > 0 && (
        <GapsSection gaps={wisdom!.gaps} />
      )}

      {profile.highlights.length > 0 && (
        <section className="profile-section">
          <h2 className="sect-title">Portfolio highlights</h2>
          {profile.highlights.slice(0, 12).map((h, i) => (
            <div key={i} className="card">
              <h4>{h.statement}<span className="grounding">{h.grounding}</span>{h.projectCount > 1 && <span className="grounding cross">{h.projectCount} repos</span>}</h4>
              {h.evidence && <div className="ev">evidence: {h.evidence}</div>}
            </div>
          ))}
        </section>
      )}

      <div className="profile-cta">
        <button className="drill-btn" onClick={onOpenMap}>Explore the knowledge map →</button>
      </div>
    </div>
  );
}

/** DIKW hero: synthesized judgment + the pyramid that produced it. */
function WisdomHero({ wisdom, counts }: { wisdom?: WisdomSnapshot; counts: GlobalDashboardSnapshot['meta']['counts'] }) {
  const headline = wisdom?.headline || 'The second brain';
  const narrative = wisdom?.narrative
    || 'What you know, demonstrated across your projects — aggregated from code and conversations, every claim grounded.';
  const wisdomCount = (wisdom?.insights.length ?? 0) + (wisdom?.competencies.length ?? 0);
  const knowledgeCount = counts.businessDomains + counts.techDomains;
  const informationCount = counts.industries + counts.edges;

  const tiers = [
    { key: 'W', label: 'Wisdom', n: wisdom?.insights.length ?? 0, sub: 'insights + principles' },
    { key: 'K', label: 'Knowledge', n: wisdom?.competencies.length ?? knowledgeCount, sub: 'competency areas' },
    { key: 'I', label: 'Information', n: counts.industries, sub: 'industries' },
    { key: 'D', label: 'Data', n: counts.projects, sub: 'projects' },
  ];

  return (
    <div className="profile-hero wisdom-hero">
      <div className="hero-main">
        <div className="hero-label">// synthesized wisdom {wisdom?.grounding ? `· ${wisdom.grounding}` : ''}</div>
        <h1 className="hero-title">{headline}</h1>
        <p className="hero-sub">{narrative}</p>
        {wisdomCount > 0 && (
          <div className="hero-foot">
            grounded inference over {counts.projects} project(s) · regenerated on each build
          </div>
        )}
      </div>
      <div className="dikw" aria-label="DIKW pyramid">
        {tiers.map((t, i) => (
          <div key={t.key} className="dikw-tier" style={{ width: `${55 + i * 15}%` }}>
            <span className="dikw-k">{t.key}</span>
            <span className="dikw-n">{t.n}</span>
            <span className="dikw-l">{t.label}<span className="dikw-sub"> · {t.sub}</span></span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A discrete 5-segment Dreyfus level meter. */
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

function CompetencyMap({ competencies }: { competencies: WisdomCompetency[] }) {
  return (
    <section className="profile-section">
      <h2 className="sect-title">Competency map <span className="sect-hint">grouped by area · leveled by evidence</span></h2>
      <div className="comp-grid">
        {competencies.map((comp) => <CompetencyCard key={comp.id} comp={comp} />)}
      </div>
    </section>
  );
}

function CompetencyCard({ comp }: { comp: WisdomCompetency }) {
  const [expanded, setExpanded] = useState(false);
  const level = (comp.level || 'competent').toLowerCase();
  const color = LEVEL_COLOR[level] ?? '#8a8f98';
  const shown = expanded ? comp.skills : comp.skills.slice(0, 10);
  const rest = comp.skills.length - shown.length;

  return (
    <div className="comp-card">
      <div className="comp-head">
        <span className="comp-name">{comp.name}</span>
        <span className="lvl-badge" style={{ color, borderColor: color }}>{LEVEL_LABELS_PROF[level] ?? level}</span>
      </div>
      <div className="comp-meta">
        {comp.category ? `${comp.category} · ` : ''}{comp.skills.length} skill(s)
        {comp.projectCount > 1 ? ` · ×${comp.projectCount} repos` : ''}
        {comp.grounding ? ` · ${comp.grounding}` : ''}
      </div>
      <LevelMeter level={level} />
      {comp.summary && <p className="comp-sum">{comp.summary}</p>}
      <div className="comp-skills">
        {shown.map((s) => (
          <span key={s.name} className="skill-pill" title={`${LEVEL_LABELS_PROF[(s.level ?? '').toLowerCase()] ?? ''} w=${s.weight.toFixed(1)}`}>
            <i className="skill-dot" style={{ background: LEVEL_COLOR[(s.level ?? '').toLowerCase()] ?? '#8a8f98' }} />
            {s.name}
          </span>
        ))}
        {rest > 0 && <button className="more-pill" onClick={() => setExpanded(true)}>+{rest} more</button>}
        {expanded && comp.skills.length > 10 && <button className="more-pill" onClick={() => setExpanded(false)}>show less</button>}
      </div>
    </div>
  );
}

function InsightsSection({ insights }: { insights: WisdomInsight[] }) {
  return (
    <section className="profile-section">
      <h2 className="sect-title">Insights &amp; principles <span className="sect-hint">what the work reveals</span></h2>
      {insights.map((i) => (
        <div key={i.id} className="card insight-card">
          <h4>
            <span className={`kind-badge ${i.kind === 'principle' ? 'principle' : 'insight'}`}>{i.kind}</span>
            {i.title}
          </h4>
          {i.body && <p className="sub">{i.body}</p>}
          {i.evidence && <div className="ev">evidence: {i.evidence}</div>}
        </div>
      ))}
    </section>
  );
}

const SEVERITY_COLOR: Record<string, string> = { high: '#e0563c', medium: '#caa23c', low: '#4caf78' };

function GapsSection({ gaps }: { gaps: WisdomGap[] }) {
  return (
    <section className="profile-section">
      <h2 className="sect-title">Gaps to close <span className="sect-hint">where to grow next</span></h2>
      {gaps.map((g) => (
        <div key={g.id} className="card gap-card">
          <h4>
            {g.severity && <span className="sev-badge" style={{ color: SEVERITY_COLOR[g.severity.toLowerCase()] ?? '#8a8f98', borderColor: SEVERITY_COLOR[g.severity.toLowerCase()] ?? '#2c3340' }}>{g.severity}</span>}
            {g.title}
            {g.area && <span className="grounding">{g.area}</span>}
          </h4>
          {g.summary && <p className="sub">{g.summary}</p>}
          {g.recommendation && <div className="gap-rec">→ {g.recommendation}</div>}
        </div>
      ))}
      <p className="sub gap-hint">These are inferred targets (grounding: model), not facts about your projects. See <code>subnet learn</code>.</p>
    </section>
  );
}

/** Pre-synthesis fallback: the flat weighted skill list. */
function FlatSkills({ skills }: { skills: GlobalDashboardSnapshot['profile']['skills'] }) {
  const maxWeight = useMemo(() => Math.max(1, ...skills.map((s) => s.weight)), [skills]);
  return (
    <section className="profile-section">
      <h2 className="sect-title">Top technical skills <span className="sect-hint">by evidence weight</span></h2>
      <div className="skills">
        {skills.map((s) => (
          <div key={s.name} className="skill-row">
            <span className="skill-name">{s.name}</span>
            <span className="skill-bar"><span className="skill-fill" style={{ width: `${Math.max(4, (s.weight / maxWeight) * 100)}%` }} /></span>
            <span className="skill-meta">
              <span className="skill-weight">{s.weight.toFixed(1)}</span>
              {s.projectCount > 1 && <span className="skill-cross">{s.projectCount} repos</span>}
              <span className="grounding">{s.grounding}</span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ============================================================================
// Map view (knowledge hierarchy + per-project drill-down) — unchanged
// ============================================================================

function HierarchyView({ snapshot, onSelect, onDrill }: {
  snapshot: GlobalDashboardSnapshot;
  onSelect: (n: HierarchyNode) => void;
  onDrill: (projectId: string) => void;
}) {
  const byId = useMemo(() => {
    const m = new Map<string, HierarchyNode>();
    for (const n of snapshot.hierarchy.nodes) m.set(n.id, n);
    return m;
  }, [snapshot]);

  const nodes: FGNode[] = useMemo(() => snapshot.hierarchy.nodes.map((n) => ({
    id: n.id,
    label: `${LEVEL_LABELS[n.level]}: ${n.label}`,
    color: LEVEL_COLORS[n.level],
    val: nodeSize(n),
  })), [snapshot]);

  if (nodes.length === 0) {
    return <div className="list"><p className="sub">No knowledge zones yet. Run <code>subnet link</code> in your projects.</p></div>;
  }

  return (
    <ForceGraph
      nodes={nodes}
      links={snapshot.hierarchy.edges.map((e) => ({ source: e.source, target: e.target }))}
      onNodeClick={(n: FGNode) => {
        const hn = byId.get(n.id);
        if (!hn) return;
        if (hn.level === 'project' && hn.projectId && snapshot.drillDown[hn.projectId]) onDrill(hn.projectId);
        else onSelect(hn);
      }}
    />
  );
}

const KNOWLEDGE_SIZE: Record<string, number> = {
  business_domain: 6, tech_domain: 6, concept: 3, entity: 3, fact: 1,
};

/** Per-project knowledge graph shown when drilling into a project from global. */
function DrillKnowledgeView({ snapshot, onSelect }: {
  snapshot: GlobalDashboardSnapshot['drillDown'][string];
  onSelect: (n: KnowledgeNode) => void;
}) {
  const byId = useMemo(() => new Map(snapshot.knowledge.nodes.map((n) => [n.id, n])), [snapshot]);
  const nodes: FGNode[] = useMemo(() => snapshot.knowledge.nodes.map((n) => ({
    id: n.id,
    label: `${KNOWLEDGE_LABELS[n.level]}: ${n.label}`,
    color: KNOWLEDGE_COLORS[n.level],
    val: KNOWLEDGE_SIZE[n.level] ?? 1,
  })), [snapshot]);

  if (nodes.length === 0) {
    return <div className="list"><p className="sub">No knowledge graph for this project yet.</p></div>;
  }
  return (
    <ForceGraph
      nodes={nodes}
      links={snapshot.knowledge.edges.map((e) => ({ source: e.source, target: e.target }))}
      onNodeClick={(n: FGNode) => { const k = byId.get(n.id); if (k) onSelect(k); }}
    />
  );
}

function LevelLegend() {
  const levels: HierarchyLevel[] = ['workspace', 'industry', 'business_domain', 'tech_domain', 'project'];
  return (
    <div className="legend">
      {levels.map((l) => (
        <span key={l}><i className="swatch" style={{ background: LEVEL_COLORS[l] }} /> {LEVEL_LABELS[l]}</span>
      ))}
      <span className="legend-hint">click a project to drill into its knowledge graph</span>
    </div>
  );
}

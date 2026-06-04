import { useMemo, useState } from 'react';
import type { GlobalDashboardSnapshot, GlobalProfile, HierarchyNode, HierarchyLevel, KnowledgeNode } from './types';
import { LEVEL_COLORS, LEVEL_LABELS, KNOWLEDGE_COLORS, KNOWLEDGE_LABELS } from './types';
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
          {view === 'profile' && <ProfileView profile={snapshot.profile} onOpenMap={goMap} />}
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

function ProfileView({ profile, onOpenMap }: { profile: GlobalProfile; onOpenMap: () => void }) {
  const maxWeight = useMemo(() => Math.max(1, ...profile.skills.map((s) => s.weight)), [profile]);
  const empty = profile.industries.length === 0 && profile.skills.length === 0 && profile.highlights.length === 0;

  return (
    <div className="profile">
      <div className="profile-hero">
        <div className="hero-label">// cross-project profile</div>
        <h1 className="hero-title">The second brain</h1>
        <p className="hero-sub">What you know, demonstrated across {profile.projectCount} project(s) — aggregated from code and conversations, every claim grounded.</p>
        <div className="stat-row">
          <Stat n={profile.projectCount} label="projects" />
          <Stat n={profile.industries.length} label="industries" />
          <Stat n={profile.skills.length} label="skills" />
          <Stat n={profile.highlights.length} label="highlights" />
        </div>
      </div>

      {empty && (
        <p className="sub empty-hint">No profile data yet. Run <code>subnet link</code> in your projects to aggregate skills, industries, and highlights.</p>
      )}

      {profile.industries.length > 0 && (
        <section className="profile-section">
          <h2 className="sect-title">Industries</h2>
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

      {profile.skills.length > 0 && (
        <section className="profile-section">
          <h2 className="sect-title">Top technical skills <span className="sect-hint">by evidence weight</span></h2>
          <div className="skills">
            {profile.skills.map((s) => (
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
      )}

      {profile.highlights.length > 0 && (
        <section className="profile-section">
          <h2 className="sect-title">Portfolio highlights</h2>
          {profile.highlights.map((h, i) => (
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

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className="stat">
      <span className="stat-n">{n}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

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

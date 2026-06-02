import { useMemo, useState } from 'react';
import type { GlobalDashboardSnapshot, HierarchyNode, HierarchyLevel } from './types';
import { LEVEL_COLORS, LEVEL_LABELS, LAYER_COLORS } from './types';
import { ForceGraph, type FGNode } from './ForceGraph';

/** Bigger nodes for higher levels / more cross-project coverage. */
function nodeSize(n: HierarchyNode): number {
  const base: Record<HierarchyLevel, number> = {
    industry: 6, business_domain: 4, tech_domain: 3, project: 3, file: 1,
  };
  return base[n.level] + Math.min(4, (n.projectCount ?? 1) - 1);
}

export function GlobalApp({ snapshot }: { snapshot: GlobalDashboardSnapshot }) {
  const [drillProjectId, setDrillProjectId] = useState<string | null>(null);
  const [selected, setSelected] = useState<HierarchyNode | null>(null);
  const [selectedFile, setSelectedFile] = useState<{ label: string; layer: string; id: string; summary?: string } | null>(null);

  const c = snapshot.meta.counts;
  const drillProject = drillProjectId ? snapshot.drillDown[drillProjectId] : undefined;
  const drillLabel = useMemo(() => {
    if (!drillProjectId) return '';
    const n = snapshot.hierarchy.nodes.find((x) => x.projectId === drillProjectId);
    return n?.label ?? drillProjectId;
  }, [drillProjectId, snapshot]);

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">subnet</span>
        <span className="mode-badge">global</span>
        <div className="crumbs">
          <button className={`crumb ${drillProjectId ? '' : 'active'}`} onClick={() => { setDrillProjectId(null); setSelectedFile(null); }}>
            Knowledge base
          </button>
          {drillProjectId && <><span className="sep">/</span><span className="crumb active">{drillLabel}</span></>}
        </div>
        <span className="counts">
          {c.industries} industries · {c.businessDomains} business · {c.techDomains} tech · {c.projects} projects
        </span>
      </div>

      {!drillProjectId && <LevelLegend />}

      <div className="body">
        <div className="main">
          {!drillProject && (
            <HierarchyView
              snapshot={snapshot}
              onSelect={setSelected}
              onDrill={(pid) => { setDrillProjectId(pid); setSelected(null); }}
            />
          )}
          {drillProject && (
            <ForceGraph
              nodes={drillProject.nodes.map((n) => ({
                id: n.id, label: `${n.label} (${n.layer})`,
                color: LAYER_COLORS[n.layer] ?? LAYER_COLORS.other, val: 1,
                _layer: n.layer, _summary: n.summary,
              }))}
              links={drillProject.edges.map((e) => ({ source: e.source, target: e.target }))}
              onNodeClick={(n: FGNode) => setSelectedFile({
                label: String((n as any).label).replace(/ \(.*\)$/, ''),
                layer: String((n as any)._layer ?? 'other'),
                id: n.id, summary: (n as any)._summary,
              })}
            />
          )}
        </div>

        {!drillProject && selected && (
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
                Open file graph →
              </button>
            )}
            {selected.level === 'project' && selected.projectId && !snapshot.drillDown[selected.projectId] && (
              <p className="sub">No local graph available for this project.</p>
            )}
          </aside>
        )}

        {drillProject && selectedFile && (
          <aside className="side">
            <h3>{selectedFile.label}</h3>
            <div className="meta">
              <span className="grounding" style={{ color: LAYER_COLORS[selectedFile.layer] ?? LAYER_COLORS.other }}>{selectedFile.layer}</span>
              {' '}{selectedFile.id}
            </div>
            {selectedFile.summary && <p className="summary">{selectedFile.summary}</p>}
          </aside>
        )}
      </div>
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

function LevelLegend() {
  const levels: HierarchyLevel[] = ['industry', 'business_domain', 'tech_domain', 'project'];
  return (
    <div className="legend">
      {levels.map((l) => (
        <span key={l}><i className="swatch" style={{ background: LEVEL_COLORS[l] }} /> {LEVEL_LABELS[l]}</span>
      ))}
      <span className="legend-hint">click a project to drill into its file graph</span>
    </div>
  );
}

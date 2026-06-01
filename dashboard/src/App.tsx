import { useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { DashboardSnapshot, GraphNode, SearchItem } from './types';
import { LAYER_COLORS } from './types';

type Tab = 'graph' | 'domains' | 'layers' | 'search';

export function App({ snapshot }: { snapshot: DashboardSnapshot }) {
  const [tab, setTab] = useState<Tab>('graph');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<GraphNode | null>(null);

  const layerColor = (layer: string) => LAYER_COLORS[layer] ?? LAYER_COLORS.other;

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">codegps</span>
        <div className="tabs">
          {(['graph', 'domains', 'layers', 'search'] as Tab[]).map((t) => (
            <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t}</button>
          ))}
        </div>
        <div className="search">
          <input
            placeholder="Search files, concepts, domains…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); if (e.target.value) setTab('search'); }}
          />
        </div>
        <span className="counts">
          {snapshot.meta.counts.files} files · {snapshot.meta.counts.edges} edges · {snapshot.meta.counts.concepts} concepts
        </span>
      </div>

      {tab === 'graph' && <Legend layers={snapshot.meta.layers} color={layerColor} />}

      <div className="body">
        <div className="main">
          {tab === 'graph' && <GraphView snapshot={snapshot} color={layerColor} onSelect={setSelected} />}
          {tab === 'domains' && <DomainsView snapshot={snapshot} />}
          {tab === 'layers' && <LayersView snapshot={snapshot} color={layerColor} onSelect={setSelected} />}
          {tab === 'search' && <SearchView snapshot={snapshot} query={query} />}
        </div>
        {selected && (
          <aside className="side">
            <h3>{selected.label}</h3>
            <div className="meta">
              <span className="grounding" style={{ color: layerColor(selected.layer) }}>{selected.layer}</span>
              {' '}{selected.language} · {selected.id}
            </div>
            {selected.summary && <p className="summary">{selected.summary}</p>}
            <div>{selected.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>
          </aside>
        )}
      </div>
    </div>
  );
}

function Legend({ layers, color }: { layers: string[]; color: (l: string) => string }) {
  return (
    <div className="legend">
      {layers.map((l) => (
        <span key={l}><i className="swatch" style={{ background: color(l) }} /> {l}</span>
      ))}
    </div>
  );
}

function GraphView({ snapshot, color, onSelect }: {
  snapshot: DashboardSnapshot; color: (l: string) => string; onSelect: (n: GraphNode) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const data = useMemo(() => ({
    nodes: snapshot.nodes.map((n) => ({ ...n })),
    links: snapshot.edges.map((e) => ({ source: e.source, target: e.target })),
  }), [snapshot]);

  return (
    <div ref={ref} style={{ width: '100%', height: '100%' }}>
      <ForceGraph2D
        graphData={data}
        nodeId="id"
        nodeLabel={(n: any) => `${n.label} (${n.layer})`}
        nodeColor={(n: any) => color(n.layer)}
        nodeRelSize={4}
        linkColor={() => 'rgba(150,150,160,0.15)'}
        linkDirectionalParticles={0}
        onNodeClick={(n: any) => onSelect(n as GraphNode)}
        cooldownTicks={120}
        backgroundColor="#0f1115"
      />
    </div>
  );
}

function DomainsView({ snapshot }: { snapshot: DashboardSnapshot }) {
  const { industries, highlights, entities } = snapshot.domains;
  return (
    <div className="list">
      <h3>Industries</h3>
      {industries.length === 0 && <p className="sub">None classified.</p>}
      {industries.map((i) => (
        <div key={i.name} className="card"><h4>{i.name}</h4>{i.evidence && <div className="ev">{i.evidence}</div>}</div>
      ))}

      <h3>Portfolio highlights</h3>
      {highlights.length === 0 && <p className="sub">Run enrich to generate highlights.</p>}
      {highlights.map((h, i) => (
        <div key={i} className="card">
          <h4>{h.statement}<span className="grounding">{h.grounding}</span></h4>
          {h.evidence && <div className="ev">evidence: {h.evidence}</div>}
        </div>
      ))}

      <h3>Entities</h3>
      {entities.map((e) => (
        <div key={e.id} className="card">
          <h4>{e.title}<span className="grounding">{e.grounding}</span></h4>
          {e.summary && <div className="sub">{e.summary}</div>}
        </div>
      ))}
    </div>
  );
}

function LayersView({ snapshot, color, onSelect }: {
  snapshot: DashboardSnapshot; color: (l: string) => string; onSelect: (n: GraphNode) => void;
}) {
  const groups = useMemo(() => {
    const m = new Map<string, GraphNode[]>();
    for (const n of snapshot.nodes) { const a = m.get(n.layer) ?? []; a.push(n); m.set(n.layer, a); }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [snapshot]);

  return (
    <div className="list">
      {groups.map(([layer, files]) => (
        <div key={layer} className="layer-group">
          <div className="layer-head">
            <i className="swatch" style={{ background: color(layer) }} /> {layer} <span className="sub">({files.length})</span>
          </div>
          {files.slice(0, 200).map((f) => (
            <div key={f.id} className="file-row" onClick={() => onSelect(f)}>
              {f.label}<span className="path">{f.id}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function SearchView({ snapshot, query }: { snapshot: DashboardSnapshot; query: string }) {
  const results = useMemo(() => fuzzy(snapshot.search, query).slice(0, 200), [snapshot, query]);
  if (!query) return <div className="list"><p className="sub">Type to search.</p></div>;
  return (
    <div className="list searchlist">
      <p className="sub">{results.length} result(s) for "{query}"</p>
      {results.map((r) => (
        <div key={`${r.kind}-${r.id}`} className="file-row">
          <span className="kind">{r.kind}</span>{r.label}
          {r.layer && <span className="path">{r.layer}</span>}
        </div>
      ))}
    </div>
  );
}

/** Tiny subsequence fuzzy match with a simple score (lower = better). */
function fuzzy(items: SearchItem[], query: string): SearchItem[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const scored: Array<{ item: SearchItem; score: number }> = [];
  for (const item of items) {
    const label = item.label.toLowerCase();
    const idx = label.indexOf(q);
    if (idx !== -1) { scored.push({ item, score: idx }); continue; }
    if (subsequence(label, q)) scored.push({ item, score: 1000 + label.length });
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.item);
}

function subsequence(haystack: string, needle: string): boolean {
  let i = 0;
  for (const ch of haystack) { if (ch === needle[i]) i++; if (i === needle.length) return true; }
  return i === needle.length;
}

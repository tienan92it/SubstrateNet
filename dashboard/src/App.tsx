import { useMemo, useState } from 'react';
import type { ConceptItem, DashboardSnapshot, GraphNode, KnowledgeNode, KnowledgeLevel, SearchItem } from './types';
import { LAYER_COLORS, KNOWLEDGE_COLORS, KNOWLEDGE_LABELS } from './types';
import { ForceGraph, type FGNode } from './ForceGraph';

type Tab = 'graph' | 'domains' | 'layers' | 'concepts' | 'search';

export function App({ snapshot }: { snapshot: DashboardSnapshot }) {
  const [tab, setTab] = useState<Tab>('graph');
  const [query, setQuery] = useState('');
  const [selectedFile, setSelectedFile] = useState<GraphNode | null>(null);
  const [selectedK, setSelectedK] = useState<KnowledgeNode | null>(null);

  const layerColor = (layer: string) => LAYER_COLORS[layer] ?? LAYER_COLORS.other;
  const c = snapshot.meta.counts;

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">subnet</span>
        <div className="tabs">
          {(['graph', 'domains', 'layers', 'concepts', 'search'] as Tab[]).map((t) => (
            <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t}</button>
          ))}
        </div>
        <div className="search">
          <input
            placeholder="Search knowledge, files, domains…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); if (e.target.value) setTab('search'); }}
          />
        </div>
        <span className="counts">
          {c.knowledgeNodes} knowledge nodes · {c.knowledgeEdges} links · {c.concepts} concepts
        </span>
      </div>

      {tab === 'graph' && <KnowledgeLegend />}

      <div className="body">
        <div className="main">
          {tab === 'graph' && <KnowledgeGraphView snapshot={snapshot} onSelect={(n) => { setSelectedK(n); setSelectedFile(null); }} />}
          {tab === 'domains' && <DomainsView snapshot={snapshot} />}
          {tab === 'layers' && <LayersView snapshot={snapshot} color={layerColor} onSelect={(n) => { setSelectedFile(n); setSelectedK(null); }} />}
          {tab === 'concepts' && <ConceptsView snapshot={snapshot} />}
          {tab === 'search' && <SearchView snapshot={snapshot} query={query} />}
        </div>
        {selectedK && (
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
        {!selectedK && selectedFile && (
          <aside className="side">
            <h3>{selectedFile.label}</h3>
            <div className="meta">
              <span className="grounding" style={{ color: layerColor(selectedFile.layer) }}>{selectedFile.layer}</span>
              {' '}{selectedFile.language} · {selectedFile.id}
            </div>
            {selectedFile.summary && <p className="summary">{selectedFile.summary}</p>}
            <div>{selectedFile.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>
          </aside>
        )}
      </div>
    </div>
  );
}

const KNOWLEDGE_SIZE: Record<KnowledgeLevel, number> = {
  business_domain: 6, tech_domain: 6, concept: 3, entity: 3, fact: 1,
};

function KnowledgeLegend() {
  const levels: KnowledgeLevel[] = ['business_domain', 'tech_domain', 'concept', 'entity', 'fact'];
  return (
    <div className="legend">
      {levels.map((l) => (
        <span key={l}><i className="swatch" style={{ background: KNOWLEDGE_COLORS[l] }} /> {KNOWLEDGE_LABELS[l]}</span>
      ))}
      <span className="legend-hint">domains group concepts &amp; entities; click a node for detail</span>
    </div>
  );
}

function KnowledgeGraphView({ snapshot, onSelect }: {
  snapshot: DashboardSnapshot; onSelect: (n: KnowledgeNode) => void;
}) {
  const byId = useMemo(() => new Map(snapshot.knowledge.nodes.map((n) => [n.id, n])), [snapshot]);
  const nodes: FGNode[] = useMemo(() => snapshot.knowledge.nodes.map((n) => ({
    id: n.id,
    label: `${KNOWLEDGE_LABELS[n.level]}: ${n.label}`,
    color: KNOWLEDGE_COLORS[n.level],
    val: KNOWLEDGE_SIZE[n.level],
  })), [snapshot]);

  if (nodes.length === 0) {
    return <div className="list"><p className="sub">No knowledge graph yet. Run <code>subnet ingest</code> (extraction + enrichment) to populate it.</p></div>;
  }

  return (
    <ForceGraph
      nodes={nodes}
      links={snapshot.knowledge.edges.map((e) => ({ source: e.source, target: e.target }))}
      onNodeClick={(n: FGNode) => { const k = byId.get(n.id); if (k) onSelect(k); }}
    />
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

const STRUCTURED_ORDER = ['problem', 'constraints', 'options', 'decision', 'consequences', 'open_questions'] as const;

function ConceptsView({ snapshot }: { snapshot: DashboardSnapshot }) {
  const concepts = snapshot.concepts;
  if (concepts.length === 0) return <div className="list"><p className="sub">No concepts yet. Run ingest to cluster facts.</p></div>;
  return (
    <div className="list">
      <p className="sub">{concepts.length} concept(s), most-connected first.</p>
      {concepts.map((c: ConceptItem) => (
        <div key={c.id} className="card">
          <h4>
            {c.name}
            {c.scope && <span className="grounding">{c.scope}</span>}
            {c.domain && <span className="grounding">{c.domain}</span>}
          </h4>
          {c.summary && <div className="sub">{c.summary}</div>}
          {c.structured && (
            <div className="structured">
              {STRUCTURED_ORDER.filter((k) => c.structured![k]).map((k) => (
                <div key={k} className="struct-row">
                  <span className="struct-key">{k.replace('_', ' ')}</span>
                  <span className="struct-val">{c.structured![k]}</span>
                </div>
              ))}
            </div>
          )}
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

  if (snapshot.nodes.length === 0) {
    return <div className="list"><p className="sub">No file analysis available. Run <code>subnet analyze</code>.</p></div>;
  }

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

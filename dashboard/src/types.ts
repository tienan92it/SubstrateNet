export interface GraphNode {
  id: string;
  label: string;
  language: string;
  layer: string;
  summary?: string;
  tags: string[];
}
export interface GraphEdge { source: string; target: string; kind: string; }
export interface DomainHighlightItem { statement: string; evidence?: string; grounding: string; }
export interface ConceptItem { id: string; name: string; summary?: string; domain?: string; scope?: string; }
export interface SearchItem { id: string; label: string; kind: string; layer?: string; }

export interface DashboardSnapshot {
  meta: {
    project: string;
    generatedAt: number;
    layers: string[];
    counts: { files: number; edges: number; highlights: number; concepts: number };
  };
  nodes: GraphNode[];
  edges: GraphEdge[];
  domains: {
    industries: Array<{ name: string; evidence?: string }>;
    highlights: DomainHighlightItem[];
    entities: Array<{ id: string; title: string; summary?: string; grounding: string }>;
  };
  concepts: ConceptItem[];
  search: SearchItem[];
}

export const LAYER_COLORS: Record<string, string> = {
  api: '#e0723c',
  service: '#3c8ce0',
  data: '#4caf78',
  ui: '#b45ad6',
  utility: '#caa23c',
  other: '#8a8f98',
};

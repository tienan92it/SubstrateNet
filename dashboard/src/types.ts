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
export interface ConceptItem {
  id: string; name: string; summary?: string; domain?: string; scope?: string;
  structured?: Record<string, string>;
}
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

// =============================================================================
// Global hierarchy (cross-project, overview -> detail)
// =============================================================================

export type HierarchyLevel = 'industry' | 'business_domain' | 'tech_domain' | 'project' | 'file';

export interface HierarchyNode {
  id: string;
  label: string;
  level: HierarchyLevel;
  summary?: string;
  projectId?: string;
  projectCount?: number;
  grounding?: string;
}

export interface HierarchyEdge { source: string; target: string; kind: string; }

export interface GlobalDashboardSnapshot {
  meta: {
    mode: 'global';
    generatedAt: number;
    counts: {
      industries: number;
      businessDomains: number;
      techDomains: number;
      projects: number;
      edges: number;
    };
  };
  hierarchy: { nodes: HierarchyNode[]; edges: HierarchyEdge[] };
  drillDown: Record<string, DashboardSnapshot>;
}

export const LEVEL_COLORS: Record<HierarchyLevel, string> = {
  industry: '#e0723c',
  business_domain: '#4caf78',
  tech_domain: '#3c8ce0',
  project: '#b45ad6',
  file: '#8a8f98',
};

export const LEVEL_LABELS: Record<HierarchyLevel, string> = {
  industry: 'Industry',
  business_domain: 'Business domain',
  tech_domain: 'Tech domain',
  project: 'Project',
  file: 'File',
};

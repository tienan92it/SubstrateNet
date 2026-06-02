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

export type KnowledgeLevel = 'business_domain' | 'tech_domain' | 'concept' | 'entity' | 'fact';
export interface KnowledgeNode {
  id: string;
  label: string;
  level: KnowledgeLevel;
  kind: string;
  summary?: string;
  scope?: string;
  grounding?: string;
}
export interface KnowledgeEdge { source: string; target: string; kind: string; }

export interface DashboardSnapshot {
  meta: {
    project: string;
    generatedAt: number;
    layers: string[];
    counts: {
      files: number; edges: number; highlights: number; concepts: number;
      knowledgeNodes: number; knowledgeEdges: number;
    };
  };
  knowledge: { nodes: KnowledgeNode[]; edges: KnowledgeEdge[] };
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

export const KNOWLEDGE_COLORS: Record<KnowledgeLevel, string> = {
  business_domain: '#4caf78',
  tech_domain: '#3c8ce0',
  concept: '#b45ad6',
  entity: '#e0723c',
  fact: '#8a8f98',
};

export const KNOWLEDGE_LABELS: Record<KnowledgeLevel, string> = {
  business_domain: 'Business domain',
  tech_domain: 'Tech domain',
  concept: 'Concept',
  entity: 'Entity',
  fact: 'Fact',
};

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

export interface GlobalProfile {
  projectCount: number;
  industries: Array<{ name: string; projectCount: number; confidence: number }>;
  skills: Array<{ name: string; weight: number; projectCount: number; grounding: string }>;
  highlights: Array<{ statement: string; evidence?: string; grounding: string; projectCount: number }>;
}

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
  profile: GlobalProfile;
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

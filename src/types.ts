/**
 * Substrate Net core type definitions.
 *
 * Mirrors the layered model (L0..L4) described in the plan.
 */

// =============================================================================
// L0 — Code Structure (codegraph-compatible)
// =============================================================================

export const NODE_KINDS = [
  'file', 'module', 'class', 'struct', 'interface', 'trait', 'protocol',
  'function', 'method', 'property', 'field', 'variable', 'constant',
  'enum', 'enum_member', 'type_alias', 'namespace', 'parameter',
  'import', 'export', 'route', 'component',
  // SQL-specific
  'table', 'index',
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export type EdgeKind =
  | 'contains' | 'calls' | 'imports' | 'exports'
  | 'extends'  | 'implements' | 'references'
  | 'type_of'  | 'returns' | 'instantiates'
  | 'overrides' | 'decorates';

export const LANGUAGES = [
  'typescript', 'javascript', 'tsx', 'jsx', 'python',
  'dart', 'go', 'rust', 'java', 'csharp', 'sql', 'unknown',
] as const;
export type Language = (typeof LANGUAGES)[number];

export interface CodeNode {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  filePath: string;
  language: Language;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  docstring?: string;
  signature?: string;
  visibility?: 'public' | 'private' | 'protected' | 'internal';
  isExported?: boolean;
  isAsync?: boolean;
  isStatic?: boolean;
  isAbstract?: boolean;
  decorators?: string[];
  typeParameters?: string[];
  updatedAt: number;
}

export interface CodeEdge {
  id?: number;
  source: string;
  target: string;
  kind: EdgeKind;
  metadata?: Record<string, unknown>;
  line?: number;
  col?: number;
  provenance?: string;
}

export interface IndexedFile {
  path: string;
  contentHash: string;
  language: Language;
  size: number;
  modifiedAt: number;
  indexedAt: number;
  nodeCount: number;
  errors?: string[];
}

// =============================================================================
// L1 — Conversations
// =============================================================================

export type AgentId = 'cursor' | 'claude-code' | 'codex' | 'copilot' | 'docs';

export interface Session {
  id: string;
  agent: AgentId;
  sourceId: string;
  sourcePath: string;
  startedAt?: number;
  endedAt?: number;
  title?: string;
  ingestedAt: number;
  ingestOffset: number;
}

export type TurnRole = 'user' | 'assistant' | 'tool' | 'system';

export interface Turn {
  id: string;
  sessionId: string;
  idx: number;
  role: TurnRole;
  text: string;
  ts?: number;
  raw?: unknown;
}

export interface ToolCall {
  id: string;
  turnId: string;
  name: string;
  args?: unknown;
  resultExcerpt?: string;
  targetPaths?: string[];
}

export interface RawTurn {
  role: TurnRole;
  text: string;
  ts?: number;
  raw: unknown;
  toolCalls?: { name: string; args?: unknown; resultExcerpt?: string; targetPaths?: string[] }[];
}

export interface SessionRef {
  agent: AgentId;
  sourceId: string;
  sourcePath: string;
  title?: string;
  startedAt?: number;
}

// =============================================================================
// L1.5 — Triage
// =============================================================================

export interface TurnWindow {
  id: string;
  sessionId: string;
  startTurn: string;
  endTurn: string;
  textHash: string;
  text: string;           // not stored; computed on read
  turns: Turn[];          // hydrated when needed
}

export type Relevance = 'on_topic' | 'off_topic' | 'mixed' | 'unknown';
export type Domain =
  | 'business_logic' | 'architecture' | 'implementation' | 'debugging'
  | 'devops' | 'meta_process' | 'chitchat' | 'unknown';
export type Quality = 'noise' | 'boilerplate' | 'signal' | 'decision_grade';
export type Linkage = 'this_project' | 'cross_project' | 'general_knowledge' | 'unrelated';

export interface TriageLabels {
  windowId: string;
  relevance: Relevance;
  domain: Domain;
  quality: Quality;
  linkage: Linkage;
  confidence: number;
  rationale?: string;
  model: string;
  producedAt: number;
  kept: boolean;
}

// =============================================================================
// L2 — Facts (k_nodes)
// =============================================================================

export type KNodeKind =
  | 'decision' | 'intent' | 'business_rule' | 'problem' | 'solution'
  | 'question' | 'answer' | 'todo' | 'warning'
  | 'pattern'  | 'entity' | 'constraint'
  // domain-enrichment kinds:
  | 'actor' | 'process' | 'metric' | 'glossary_term' | 'knowledge_gap'
  // technical-profile kinds:
  | 'dependency' | 'tool' | 'skill'
  // industry-profile kind:
  | 'industry'
  // taxonomy / organization kinds (knowledge zones):
  | 'business_domain' | 'tech_domain'
  // portfolio synthesis (technical x industry):
  | 'domain_highlight'
  // syntax-source kinds (deterministic):
  | 'path_mention' | 'code_block' | 'shell_command'
  | 'error_message' | 'stack_trace' | 'ticket_id' | 'url';

export type KEdgeKind =
  | 'mentions' | 'resolves' | 'contradicts' | 'supersedes'
  | 'derived_from' | 'same_as' | 'depends_on' | 'caused_by'
  // domain-graph edges:
  | 'relates_to' | 'has_state' | 'transitions_to' | 'governed_by'
  | 'owned_by' | 'part_of' | 'gap_in';

/**
 * How a fact is grounded in evidence. This is the contract that enforces
 * "based on facts, never assume":
 *   - 'structural'   — derived from code structure (provenance → code node).
 *   - 'stated'       — explicitly said in a conversation (provenance → window).
 *   - 'corroborated' — supported by >=2 independent sources (stated + structural).
 *   - 'external'     — from a cited external/web source (source_url stored).
 *   - 'model'        — from the agent's parametric knowledge; an explicit
 *                      inference with NO project or web evidence.
 * A NULL value (legacy rows) is treated as 'stated'.
 *
 * Project-truth = {structural, stated, corroborated}. Enrichment = {external,
 * model}; always filterable, never silently mixed with project facts.
 */
export type Grounding = 'structural' | 'stated' | 'corroborated' | 'external' | 'model';

/** Project-grounded tiers, ordered by objectivity (descending). */
export const PROJECT_GROUNDING: Grounding[] = ['structural', 'corroborated', 'stated'];
/** Enrichment tiers — knowledge NOT grounded in the user's own work. */
export const ENRICHMENT_GROUNDING: Grounding[] = ['external', 'model'];

/**
 * What kind of knowledge a node/concept represents:
 *   - 'technical' — skills, technologies, frameworks, architecture, patterns.
 *   - 'industry'  — business domain: entities, rules, workflows, market.
 *   - 'meta'      — process/tooling/uncategorized.
 */
export type Scope = 'technical' | 'industry' | 'meta';

export interface KNode {
  id: string;
  kind: KNodeKind;
  title: string;
  summary?: string;
  evidenceText?: string;
  confidence: number;
  source: string;         // 'syntax' | 'agent:<name>' | 'structural:code' | 'manual'
  agentModel?: string;
  grounding?: Grounding;
  scope?: Scope;
  sourceUrl?: string;     // citation when grounding='external'
  createdAt: number;
  updatedAt: number;
  clusterId?: string;
}

export interface KEdge {
  id?: number;
  source: string;
  target: string;
  kind: KEdgeKind;
  weight?: number;
  metadata?: Record<string, unknown>;
}

export interface KProvenance {
  kNodeId: string;
  windowId: string;
  spanStart?: number;
  spanEnd?: number;
}

export interface KToCode {
  kNodeId: string;
  codeNodeId: string;
  codeFile?: string;
  weight?: number;
}

// =============================================================================
// Domain enrichment (L2.5) — entity/relationship graph + gaps
// =============================================================================

/** A domain entity with its evidence-grounded relationships. */
export interface DomainEntity {
  id: string;
  title: string;
  summary?: string;
  grounding: Grounding;
  source: string;
  codeFiles: string[];     // resolved L0 files backing this entity (if structural)
}

export interface DomainRelationship {
  fromId: string;
  toId: string;
  fromTitle: string;
  toTitle: string;
  kind: KEdgeKind;
  evidence?: string;       // verbatim quote or code ref (e.g. "table:accounts")
  grounding: Grounding;
}

export interface KnowledgeGap {
  id: string;
  title: string;
  summary?: string;
  evidenceText?: string;
  grounding: Grounding;
  source: string;
}

// =============================================================================
// L3 — Concepts
// =============================================================================

export interface Concept {
  id: string;
  name: string;
  summary?: string;
  domain?: Domain;
  scope?: Scope;
  grounding?: Grounding;   // dominant tier across members
  /** Optional "systematic thinking" digest (problem/constraints/decision/...). */
  structured?: ConceptStructured;
  memberCount: number;
  embedding?: Buffer;
}

export interface ConceptStructured {
  problem?: string;
  constraints?: string;
  options?: string;
  decision?: string;
  consequences?: string;
  open_questions?: string;
}

// =============================================================================
// L5 — Skill graph (global "second brain")
// =============================================================================

export interface Skill {
  id: string;
  name: string;
  scope: Scope;
  kind: string;            // 'language' | 'framework' | 'infra' | 'domain' | 'pattern' | ...
  evidenceWeight: number;  // aggregated across projects
  grounding: Grounding;    // strongest tier supporting it
  projectCount: number;
}

export interface TechnicalProfile {
  languages: Array<{ name: string; weight: number }>;
  frameworks: string[];
  infrastructure: string[];
  patterns: string[];
}

export interface IndustryProfile {
  industry: string;
  confidence: number;
  domains: string[];
}

// =============================================================================
// Agent runtime
// =============================================================================

export interface AgentRun {
  id: string;
  agentName: string;
  model: string;
  inputHash: string;
  outputJson: string;
  tokensIn?: number;
  tokensOut?: number;
  ms?: number;
  ok: boolean;
  error?: string;
  producedAt: number;
}

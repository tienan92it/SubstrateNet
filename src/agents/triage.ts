/**
 * Triage Agent.
 *
 * Classifies a TurnWindow on four orthogonal axes:
 *   - relevance: is this exchange about the project at all?
 *   - domain:    what kind of work does it discuss?
 *   - quality:   is the content noise, boilerplate, signal, or decision-grade?
 *   - linkage:   does it apply to this project, span projects, or stand alone?
 *
 * Output is strict JSON. The runtime caches by (agent, model, input_hash).
 */
import type { Agent, AgentInput } from './runtime.js';
import type { ChatMessage } from './backends/base.js';
import type { TurnWindow, TriageLabels, Relevance, Domain, Quality, Linkage, Activity } from '../types.js';
import { registerAgent } from './registry.js';

export interface TriagePayload {
  text: string;
  windowId: string;
  /** Optional compact project context to keep labels grounded + consistent. */
  context?: string;
}

export interface TriageOutput {
  relevance: Relevance;
  domain: Domain;
  quality: Quality;
  linkage: Linkage;
  activity: Activity;
  confidence: number;
  rationale: string;
}

const SYSTEM = `You are a triage classifier for a knowledge-graph tool. Given a window of
conversation between a developer and an AI coding agent, label it on four axes
and return STRICT JSON only — no prose, no fences.

Axes (pick exactly one value per axis):

RELEVANCE
  on_topic         — clearly about the project's code, design, business, or operations.
  off_topic        — chitchat, meta-process, unrelated topics, model housekeeping.
  mixed            — both project-relevant and irrelevant content meaningfully present.
  unknown          — cannot judge from the text given.

DOMAIN
  business_logic   — domain rules, entities, business invariants, product requirements.
  architecture     — high-level design, system boundaries, technology choices.
  implementation   — concrete code edits, function-level work, refactors, syntax.
  debugging        — finding and fixing a bug or failure.
  devops           — CI, deploy, infra, builds, packaging, env config.
  meta_process     — workflow, conventions, tooling about the tool itself.
  chitchat         — greetings, off-task talk, no engineering substance.
  unknown          — domain genuinely unclear.

QUALITY
  noise            — empty, trivial, broken, or nearly-content-free.
  boilerplate      — generic content that won't be useful later (e.g. "thanks!", restated prompts).
  signal           — useful information worth keeping in the knowledge graph.
  decision_grade   — contains an explicit decision, constraint, business rule,
                     or root-cause finding worth highlighting.

LINKAGE
  this_project     — only meaningful within this project.
  cross_project    — pattern, library choice, or knowledge applicable across projects.
  general_knowledge — generic engineering knowledge with no project specificity.
  unrelated        — not relevant to any project of the user.

ACTIVITY (what the exchange was DOING — orthogonal to domain)
  feature          — building/adding new functionality.
  bugfix           — diagnosing or fixing a defect or failure.
  info_request     — asking for information about the project/product.
  todo             — capturing a task or follow-up to do later.
  planning         — designing, scoping, prioritizing, or roadmapping.
  refactor         — restructuring code without changing behavior.
  ops              — deploy, infra, release, monitoring, incident response.
  question         — a general technical question (not project-specific info).
  chitchat         — no actionable activity.

Confidence: a number in [0,1] reflecting your overall certainty.
Rationale: ≤ 280 chars explaining the classification.

Return JSON exactly matching:
{
  "relevance":"...","domain":"...","quality":"...","linkage":"...",
  "activity":"...","confidence":0.0,"rationale":"..."
}`;

export const TRIAGE_AGENT: Agent<TriagePayload, TriageOutput> = {
  name: 'triage',
  promptVersion: 2,
  schema: {
    type: 'object',
    required: ['relevance', 'domain', 'quality', 'linkage', 'activity', 'confidence', 'rationale'],
    properties: {
      relevance: { enum: ['on_topic', 'off_topic', 'mixed', 'unknown'] },
      domain: {
        enum: [
          'business_logic', 'architecture', 'implementation', 'debugging',
          'devops', 'meta_process', 'chitchat', 'unknown',
        ],
      },
      quality: { enum: ['noise', 'boilerplate', 'signal', 'decision_grade'] },
      linkage: { enum: ['this_project', 'cross_project', 'general_knowledge', 'unrelated'] },
      activity: {
        enum: [
          'feature', 'bugfix', 'info_request', 'todo', 'planning',
          'refactor', 'ops', 'question', 'chitchat',
        ],
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      rationale: { type: 'string', maxLength: 800 },
    },
    additionalProperties: false,
  },
  prompt(input: AgentInput<TriagePayload>): ChatMessage[] {
    const body = clamp(input.payload.text, 6000);
    const ctx = input.payload.context ? `PROJECT CONTEXT (for grounding):\n${input.payload.context}\n\n` : '';
    return [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          ctx +
          `WINDOW ID: ${input.payload.windowId}\n` +
          `--- begin window ---\n${body}\n--- end window ---\n\n` +
          `Return JSON only.`,
      },
    ];
  },
};

registerAgent(TRIAGE_AGENT);

/**
 * Decide kept vs dropped from the agent's labels.
 *
 * Dropped only when at least one axis is firmly negative with high confidence.
 * Conservative: when in doubt, keep.
 */
export function shouldKeep(labels: TriageOutput): boolean {
  const c = labels.confidence;
  if (labels.quality === 'noise' && c >= 0.6) return false;
  if (labels.relevance === 'off_topic' && c >= 0.6) return false;
  if (labels.linkage === 'unrelated' && c >= 0.6) return false;
  if (labels.domain === 'chitchat' && labels.quality !== 'decision_grade' && c >= 0.6) return false;
  return true;
}

export function labelsToRow(
  windowId: string, model: string, o: TriageOutput, kept: boolean,
): TriageLabels {
  return {
    windowId,
    relevance: o.relevance,
    domain: o.domain,
    quality: o.quality,
    linkage: o.linkage,
    activity: o.activity,
    confidence: o.confidence,
    rationale: o.rationale,
    model,
    producedAt: Date.now(),
    kept,
  };
}

function clamp(s: string, n: number): string {
  if (s.length <= n) return s;
  // Keep head and tail; drop middle (most info usually sits at boundaries).
  const half = Math.floor((n - 32) / 2);
  return s.slice(0, half) + `\n\n...[trimmed ${s.length - n} chars]...\n\n` + s.slice(s.length - half);
}

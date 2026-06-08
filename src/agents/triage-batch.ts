/**
 * Batch Triage Agent — classifies several windows in one call.
 *
 * Same axes and label semantics as the single-window TRIAGE_AGENT, but the
 * payload carries N windows and the output is an array keyed by windowId.
 * Routed by `modelKey: 'triage'` so it shares the triage model config.
 *
 * The pipeline falls back to single-window triage when a batch fails to parse,
 * so this never reduces coverage — only call count.
 */
import type { Agent, AgentInput } from './runtime.js';
import type { ChatMessage } from './backends/base.js';
import type { Relevance, Domain, Quality, Linkage, Activity } from '../types.js';
import { registerAgent } from './registry.js';
import type { TriageOutput } from './triage.js';

export interface TriageBatchItem {
  windowId: string;
  text: string;
}

export interface TriageBatchPayload {
  windows: TriageBatchItem[];
  context?: string;
}

export interface TriageBatchResultItem extends TriageOutput {
  windowId: string;
}

export interface TriageBatchOutput {
  results: TriageBatchResultItem[];
}

const RELEVANCE: Relevance[] = ['on_topic', 'off_topic', 'mixed', 'unknown'];
const DOMAIN: Domain[] = ['business_logic', 'architecture', 'implementation', 'debugging', 'devops', 'meta_process', 'chitchat', 'unknown'];
const QUALITY: Quality[] = ['noise', 'boilerplate', 'signal', 'decision_grade'];
const LINKAGE: Linkage[] = ['this_project', 'cross_project', 'general_knowledge', 'unrelated'];
const ACTIVITY: Activity[] = ['feature', 'bugfix', 'info_request', 'todo', 'planning', 'refactor', 'ops', 'question', 'chitchat'];

const SYSTEM = `You are a triage classifier for a knowledge-graph tool. You are given SEVERAL
windows of developer/AI conversation. Classify EACH window independently on five
axes and return STRICT JSON only — no prose, no fences.

RELEVANCE: on_topic | off_topic | mixed | unknown
DOMAIN: business_logic | architecture | implementation | debugging | devops | meta_process | chitchat | unknown
QUALITY: noise | boilerplate | signal | decision_grade
LINKAGE: this_project | cross_project | general_knowledge | unrelated
ACTIVITY: feature | bugfix | info_request | todo | planning | refactor | ops | question | chitchat

For each input window emit one result object with its windowId echoed back.
confidence is a number in [0,1]; rationale is <= 280 chars.

Return JSON exactly matching:
{"results":[{"windowId":"...","relevance":"...","domain":"...","quality":"...","linkage":"...","activity":"...","confidence":0.0,"rationale":"..."}]}`;

const RESULT_ITEM_SCHEMA = {
  type: 'object',
  required: ['windowId', 'relevance', 'domain', 'quality', 'linkage', 'activity', 'confidence', 'rationale'],
  properties: {
    windowId: { type: 'string' },
    relevance: { enum: RELEVANCE },
    domain: { enum: DOMAIN },
    quality: { enum: QUALITY },
    linkage: { enum: LINKAGE },
    activity: { enum: ACTIVITY },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string', maxLength: 800 },
  },
  additionalProperties: false,
};

export const TRIAGE_BATCH_AGENT: Agent<TriageBatchPayload, TriageBatchOutput> = {
  name: 'triageBatch',
  modelKey: 'triage',
  promptVersion: 1,
  schema: {
    type: 'object',
    required: ['results'],
    properties: {
      results: { type: 'array', items: RESULT_ITEM_SCHEMA },
    },
    additionalProperties: false,
  },
  prompt(input: AgentInput<TriageBatchPayload>): ChatMessage[] {
    const ctx = input.payload.context ? `PROJECT CONTEXT (for grounding):\n${input.payload.context}\n\n` : '';
    const windows = input.payload.windows
      .map((w) => `### WINDOW ${w.windowId}\n${clamp(w.text, 2500)}`)
      .join('\n\n');
    return [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          ctx +
          `Classify these ${input.payload.windows.length} windows. Echo each windowId.\n\n` +
          `${windows}\n\nReturn JSON only.`,
      },
    ];
  },
};

registerAgent(TRIAGE_BATCH_AGENT);

function clamp(s: string, n: number): string {
  if (s.length <= n) return s;
  const half = Math.floor((n - 32) / 2);
  return s.slice(0, half) + `\n\n...[trimmed ${s.length - n} chars]...\n\n` + s.slice(s.length - half);
}

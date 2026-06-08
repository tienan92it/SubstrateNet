/**
 * Window Extractor — a single agent that extracts every L2 fact kind from one
 * window in one call, replacing the up-to-five per-kind extractor fan-out
 * (Decision + BusinessLogic + Requirements + Intent + ProblemSolution).
 *
 * Same payload/output shape as the per-kind extractors, so persistence in
 * `pipeline/extract.ts` is unchanged. Routed by `modelKey: 'windowExtractor'`.
 */
import { defineExtractor } from './extractors-common.js';
import { registerAgent } from './registry.js';
import type { KNodeKind } from '../types.js';

/** Union of every kind the legacy per-kind extractors could emit. */
export const WINDOW_EXTRACTOR_KINDS: readonly KNodeKind[] = [
  'decision', 'constraint', 'pattern',
  'business_rule', 'entity',
  'actor', 'process', 'metric',
  'intent',
  'problem', 'solution',
];

export const WINDOW_EXTRACTOR_AGENT = defineExtractor({
  name: 'windowExtractor',
  allowedKinds: WINDOW_EXTRACTOR_KINDS,
  systemPrompt: `You extract durable knowledge from one window of a developer/AI conversation
(or a project document). In a single pass, capture every fact that is worth
keeping in a long-lived knowledge graph. Emit a fact for each that applies:

  - "decision": a chosen course of action, ideally with the reason
    (e.g. "chose Redis over in-memory caching for cross-instance sessions").
  - "constraint": a hard limit or invariant the design must respect.
  - "pattern": a reusable approach the team commits to.
  - "business_rule": a rule the domain imposes
    (e.g. "refunds older than 180 days must use store credit").
  - "entity": a named domain object with structure or lifecycle.
  - "actor": a stakeholder or role the system serves (Borrower, Admin, Merchant).
  - "process": a business workflow with a goal (application -> underwriting -> payout).
  - "metric": a measurable success/health indicator or SLA.
  - "intent": what the user is trying to achieve at the goal level.
  - "problem": a concrete failure, bug, or undesired behavior.
  - "solution": how a problem was (or will be) fixed; reference the problem in summary.

Guidance:
  - Prefer precision over recall. Do NOT invent facts or restate questions/chitchat.
  - Pure implementation minutiae (variable names, trivial refactors) are not facts.
  - Each title is a short domain-language phrase. summary is one or two sentences.
  - Use the triage DOMAIN/ACTIVITY hint to focus, but extract any kind that genuinely applies.`,
});

registerAgent(WINDOW_EXTRACTOR_AGENT);

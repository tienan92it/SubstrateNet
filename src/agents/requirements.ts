/**
 * Requirements Agent — extracts BRD / PRD-style business knowledge from
 * documents and business-logic conversations: who the system serves (actors),
 * what it does (processes), the rules it must honor, and how success is
 * measured (metrics). Complements BusinessLogic (rules/entities) with the
 * operational and stakeholder layer that docs carry but chat rarely states.
 */
import { defineExtractor } from './extractors-common.js';
import { registerAgent } from './registry.js';

export const REQUIREMENTS_AGENT = defineExtractor({
  name: 'requirements',
  allowedKinds: ['actor', 'process', 'business_rule', 'metric', 'intent', 'constraint'],
  systemPrompt: `You extract BUSINESS REQUIREMENTS from a document or product discussion
(BRD, PRD, user stories, architecture/domain notes).

Look for:
  - "actor": a stakeholder or role the system serves or interacts with
    (e.g. "Borrower", "Compliance Officer", "Merchant", "Admin").
  - "process": a business workflow or operational flow with a goal
    (e.g. "Loan origination: application -> underwriting -> disbursement").
  - "business_rule": a rule the domain imposes (e.g. "KYC must complete before
    a wallet can hold a balance").
  - "metric": a measurable success/health indicator or SLA (e.g. "approval
    turnaround < 24h", "settlement success rate").
  - "intent": a stated product/business goal or requirement
    (e.g. "enable instant payouts to reduce churn").
  - "constraint": a hard limit or compliance/regulatory boundary.

Each fact's title is a short domain-language noun/verb phrase. summary states it
in one or two sentences. evidence_text quotes the smallest supporting passage.

Do NOT extract:
  - Implementation/code details, variable or function names, refactors.
  - Generic engineering best practice.
  - Marketing copy with no concrete requirement.

If nothing applies, return {"facts": []}. Never invent requirements.`,
});

registerAgent(REQUIREMENTS_AGENT);

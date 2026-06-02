/**
 * TechDomainModeler Agent.
 *
 * Groups technical facts (skills, architecture components, tools) into named
 * TECHNICAL DOMAINS / capabilities (e.g. "Authentication", "Data pipeline",
 * "API layer", "Observability"). These are the engineering counterpart to
 * business domains in the knowledge hierarchy.
 */
import { defineDomainGrouper } from './domain-grouper.js';
import { registerAgent } from './registry.js';

export const TECH_DOMAIN_MODELER_AGENT = defineDomainGrouper({
  name: 'techDomainModeler',
  systemPrompt: `You organize a system's technical knowledge into TECHNICAL DOMAINS
(engineering capabilities). Examples: "Authentication & Authorization",
"Data pipeline", "API layer", "Frontend UI", "Messaging", "Observability",
"Infrastructure & Deploy".

Name each domain the way a staff engineer would. Assign the given skills,
components, and tools to the capability they implement. A fact belongs to at
most one domain.`,
});

registerAgent(TECH_DOMAIN_MODELER_AGENT);

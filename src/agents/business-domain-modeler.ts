/**
 * BusinessDomainModeler Agent.
 *
 * Groups industry-scoped facts (entities, business rules, actors, processes,
 * glossary terms) into named BUSINESS DOMAINS — bounded contexts a domain
 * expert would recognize (e.g. "Payments", "Identity & KYC", "Lending").
 */
import { defineDomainGrouper } from './domain-grouper.js';
import { registerAgent } from './registry.js';

export const BUSINESS_DOMAIN_MODELER_AGENT = defineDomainGrouper({
  name: 'businessDomainModeler',
  systemPrompt: `You organize a system's business knowledge into BUSINESS DOMAINS
(bounded contexts). Each domain is a cohesive area of the business — for example
"Payments", "Identity & KYC", "Lending", "Catalog", "Fulfillment".

Name each domain in the language a domain expert (not an engineer) would use.
Assign the given entities, rules, actors, and processes to the domain they
belong to. A fact belongs to at most one domain.`,
});

registerAgent(BUSINESS_DOMAIN_MODELER_AGENT);

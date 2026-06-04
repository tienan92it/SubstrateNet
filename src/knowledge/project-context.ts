/**
 * Compact project context for grounding agent prompts.
 *
 * Injecting a small, stable summary of what the project already knows (industry,
 * domains, top entities, glossary, ticket prefixes) into triage / extraction /
 * classification keeps labels and facts consistent across windows and lets the
 * model deduplicate against established names instead of inventing variants.
 *
 * Built once per run and passed to each agent call. Bounded and cheap.
 */
import type { Database as SqliteDb } from 'better-sqlite3';

const MAX_CONTEXT_CHARS = 1500;

export interface ProjectContext {
  industries: string[];
  businessDomains: string[];
  techDomains: string[];
  entities: string[];
  glossary: string[];
  ticketPrefixes: string[];
}

export function collectProjectContext(knowDb: SqliteDb): ProjectContext {
  const titles = (sql: string, ...args: unknown[]) =>
    (knowDb.prepare(sql).all(...args) as Array<{ title: string }>).map((r) => r.title).filter(Boolean);

  const industries = titles(`SELECT DISTINCT title FROM k_nodes WHERE kind='industry' LIMIT 5`);
  const businessDomains = titles(`SELECT DISTINCT title FROM k_nodes WHERE kind='business_domain' LIMIT 20`);
  const techDomains = titles(`SELECT DISTINCT title FROM k_nodes WHERE kind='tech_domain' LIMIT 20`);
  const entities = titles(`SELECT title FROM k_nodes WHERE kind='entity' ORDER BY updated_at DESC LIMIT 30`);
  const glossary = titles(`SELECT DISTINCT title FROM k_nodes WHERE kind='glossary_term' LIMIT 20`);

  const ticketTitles = titles(`SELECT DISTINCT title FROM k_nodes WHERE kind='ticket_id' LIMIT 200`);
  const ticketPrefixes = uniqueTicketPrefixes(ticketTitles);

  return { industries, businessDomains, techDomains, entities, glossary, ticketPrefixes };
}

/** Extract distinct ticket prefixes (e.g. KAFI-123 -> KAFI), most common first. */
export function uniqueTicketPrefixes(tickets: string[]): string[] {
  const counts = new Map<string, number>();
  for (const t of tickets) {
    const m = /^([A-Z][A-Z0-9]{1,9})-\d+/.exec(t.trim());
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p).slice(0, 12);
}

/** Render the context as a compact, bounded string for prompt injection. */
export function renderProjectContext(ctx: ProjectContext): string {
  const lines: string[] = [];
  if (ctx.industries.length) lines.push(`Industry: ${ctx.industries.join(', ')}`);
  if (ctx.businessDomains.length) lines.push(`Business domains: ${ctx.businessDomains.join(', ')}`);
  if (ctx.techDomains.length) lines.push(`Tech domains: ${ctx.techDomains.join(', ')}`);
  if (ctx.entities.length) lines.push(`Known entities: ${ctx.entities.join(', ')}`);
  if (ctx.glossary.length) lines.push(`Glossary: ${ctx.glossary.join(', ')}`);
  if (ctx.ticketPrefixes.length) lines.push(`Ticket prefixes: ${ctx.ticketPrefixes.join(', ')}`);
  const text = lines.join('\n');
  return text.length > MAX_CONTEXT_CHARS ? text.slice(0, MAX_CONTEXT_CHARS) + '…' : text;
}

/** Convenience: build the rendered context string (empty when nothing known yet). */
export function buildProjectContext(knowDb: SqliteDb): string {
  return renderProjectContext(collectProjectContext(knowDb));
}

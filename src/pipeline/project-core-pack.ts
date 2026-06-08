/**
 * Shared project context pack with verbatim evidence lines for LLM stages.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Database as SqliteDb } from 'better-sqlite3';

export interface CoreEvidence {
  ref: string;
  verbatim: string;
}

export interface ProjectCorePack {
  projectName?: string;
  industries: string[];
  evidence: CoreEvidence[];
  entities: string[];
  decisions: string[];
  glossary: string[];
  ticketPrefixes: string[];
  charBudget: number;
}

const MAX_PACK_CHARS = 3000;

export function buildProjectCorePack(
  knowDb: SqliteDb,
  root: string,
): ProjectCorePack {
  const titles = (sql: string, ...args: unknown[]) =>
    (knowDb.prepare(sql).all(...args) as Array<{ title: string }>).map((r) => r.title).filter(Boolean);

  const industries = titles(`SELECT DISTINCT title FROM k_nodes WHERE kind='industry' LIMIT 5`);
  const entities = titles(`SELECT title FROM k_nodes WHERE kind='entity' ORDER BY updated_at DESC LIMIT 20`);
  const decisions = titles(`
    SELECT title FROM k_nodes WHERE kind='decision' ORDER BY confidence DESC LIMIT 12
  `);
  const glossary = titles(`SELECT DISTINCT title FROM k_nodes WHERE kind='glossary_term' LIMIT 12`);

  const evidence: CoreEvidence[] = [];
  let projectName: string | undefined;
  try {
    const pkgPath = join(root, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (typeof pkg.name === 'string') projectName = pkg.name;
      if (typeof pkg.description === 'string' && pkg.description) {
        evidence.push({ ref: 'package.json', verbatim: pkg.description.slice(0, 300) });
      }
    }
  } catch { /* ignore */ }

  for (const name of ['README.md', 'readme.md']) {
    const p = join(root, name);
    if (existsSync(p)) {
      try {
        const readme = readFileSync(p, 'utf8');
        const lede = readme.split('\n').filter((l) => l.trim() && !l.startsWith('#')).slice(0, 3).join(' ');
        if (lede) evidence.push({ ref: name, verbatim: lede.slice(0, 500) });
      } catch { /* ignore */ }
      break;
    }
  }

  const ticketRows = titles(`SELECT DISTINCT title FROM k_nodes WHERE kind='ticket_id' LIMIT 80`);
  const ticketPrefixes = uniqueTicketPrefixes(ticketRows);

  const pack: ProjectCorePack = {
    projectName,
    industries,
    evidence,
    entities,
    decisions,
    glossary,
    ticketPrefixes,
    charBudget: 0,
  };
  pack.charBudget = renderProjectCorePack(pack).length;
  return pack;
}

export function renderProjectCorePack(pack: ProjectCorePack): string {
  const lines: string[] = [];
  if (pack.projectName) lines.push(`Project: ${pack.projectName}`);
  if (pack.industries.length) lines.push(`Industry: ${pack.industries.join(', ')}`);
  if (pack.entities.length) lines.push(`Entities: ${pack.entities.join(', ')}`);
  if (pack.decisions.length) lines.push(`Decisions: ${pack.decisions.join('; ')}`);
  if (pack.glossary.length) lines.push(`Glossary: ${pack.glossary.join(', ')}`);
  if (pack.ticketPrefixes.length) lines.push(`Tickets: ${pack.ticketPrefixes.join(', ')}`);
  if (pack.evidence.length) {
    lines.push('Evidence:');
    for (const e of pack.evidence) {
      lines.push(`- [${e.ref}] ${e.verbatim}`);
    }
  }
  let text = lines.join('\n');
  if (text.length > MAX_PACK_CHARS) text = text.slice(0, MAX_PACK_CHARS) + '…';
  return text;
}

function uniqueTicketPrefixes(tickets: string[]): string[] {
  const counts = new Map<string, number>();
  for (const t of tickets) {
    const m = /^([A-Z][A-Z0-9]{1,9})-\d+/.exec(t.trim());
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p).slice(0, 12);
}

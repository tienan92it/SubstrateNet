import { resolve } from 'path';
import { slugForPath } from '../ingest/cursor.js';

/** Match a Cursor/Claude slug dir name to candidate absolute paths. */
export function matchSlugToPaths(slug: string, candidates: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const abs = resolve(raw);
    if (seen.has(abs)) continue;
    if (slugForPath(abs) === slug) {
      seen.add(abs);
      out.push(abs);
    }
  }
  return out;
}

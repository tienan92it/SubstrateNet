/**
 * Mechanical turn cleaning before segmentation (no LLM).
 */
import type { Turn } from '../types.js';
import type { IngestConfig } from '../config.js';

const THINKING_FENCE = /```(?:thinking|thought)[\s\S]*?```/gi;
const HOUSEKEEPING = /^(?:I'll |I will |Let me |Sure[,!]? |Okay[,!]? )/i;

export function normalizeTurnText(text: string, opts: Pick<IngestConfig, 'maxTurnChars'>): string {
  let t = text.replace(THINKING_FENCE, '').trim();
  const lines = t.split('\n');
  const filtered: string[] = [];
  let prev = '';
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed === prev && trimmed.length > 20) continue;
    if (/^[-+]{3,}\s*$/.test(trimmed) && filtered.length > 0) continue;
    filtered.push(line);
    prev = trimmed;
  }
  t = filtered.join('\n').trim();
  if (t.length > 0 && HOUSEKEEPING.test(t.slice(0, 80))) {
    t = t.replace(HOUSEKEEPING, '').trim();
  }
  const max = opts.maxTurnChars ?? 12_000;
  if (t.length > max) {
    const half = Math.floor((max - 40) / 2);
    t = t.slice(0, half) + `\n\n...[trimmed ${t.length - max} chars]...\n\n` + t.slice(t.length - half);
  }
  return t;
}

export function normalizeTurns(turns: Turn[], opts: Pick<IngestConfig, 'maxTurnChars'>): Turn[] {
  return turns.map((t) => ({ ...t, text: normalizeTurnText(t.text ?? '', opts) }));
}

import type { DiscoveredWorkspace } from './types.js';
import type { SetupPlan } from './types.js';

export function formatDiscoverTable(rows: DiscoveredWorkspace[]): string {
  const lines = [
    padRow(['Project', 'Path', 'Sessions', 'Transcripts', 'Files', 'Init']),
    padRow(['-------', '----', '--------', '-----------', '-----', '----']),
  ];
  for (const w of rows) {
    const sessions = w.sources.reduce((n, s) => n + s.sessions, 0);
    const bytes = w.sources.reduce((n, s) => n + s.transcriptBytes, 0);
    const path = w.path || `(unresolved: ${w.unresolvedSlug ?? '?'})`;
    lines.push(padRow([
      w.name,
      truncate(path, 48),
      String(sessions),
      formatBytes(bytes),
      '—',
      w.initialized ? 'yes' : 'no',
    ]));
  }
  return lines.join('\n');
}

export function formatPlanTable(plan: SetupPlan): string {
  const lines = [
    padRow(['Project', 'Files', 'Pending', 'Sessions', 'Windows', 'LLM calls', 'Cache', 'Est. time']),
    padRow(['-------', '-----', '-------', '--------', '-------', '---------', '-----', '---------']),
  ];
  for (const p of plan.projects) {
    lines.push(padRow([
      p.name,
      String(p.files),
      String(p.pendingFiles),
      String(p.sessions),
      String(p.estWindows),
      String(p.llmCalls),
      `${p.cacheHitPct}%`,
      formatDuration(p.estWallMs, p.backendMode),
    ]));
  }
  const t = plan.totals;
  lines.push(padRow([
    'TOTAL',
    String(t.files),
    String(t.pendingFiles),
    String(t.sessions),
    String(t.estWindows),
    String(t.llmCalls),
    `${t.cacheHitPct}%`,
    formatDuration(t.estWallMs, plan.backendMode),
  ]));
  if (plan.backendMode !== 'local' && t.estTokens > 0) {
    lines.push(`\nEstimated tokens (frontier): ~${formatNum(t.estTokens)}` +
      (t.estCostUsd != null ? ` · ~$${t.estCostUsd.toFixed(2)}` : ''));
  }
  lines.push(`Concurrency: ${plan.concurrency} · Backend: ${plan.backendMode}` +
    (plan.profile ? ` · Profile: ${plan.profile}` : ''));
  return lines.join('\n');
}

function padRow(cols: string[]): string {
  const widths = [14, 8, 8, 9, 8, 10, 6, 12];
  return cols.map((c, i) => c.slice(0, widths[i]!).padEnd(widths[i]!)).join(' ');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number, mode: string): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  return mode === 'local' ? `~${min} min` : `~${min} min wall`;
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

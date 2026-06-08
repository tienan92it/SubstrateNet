/**
 * Manifest + infrastructure parser — deterministic, zero-assumption.
 *
 * Walks the project (depth-limited, skipping heavy dirs) and reads every
 * dependency manifest and infra file it finds — root OR nested, so monorepos
 * (e.g. a Flutter app + a web frontend under one repo) are fully covered. It
 * emits `dependency` and `tool` facts (scope='technical',
 * grounding='structural', source='structural:manifest'). These are leaf
 * evidence — the raw material the TechnicalProfiler synthesizes into skills. A
 * declared dependency is an objective fact; no inference.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative, basename } from 'path';
import { createHash } from 'crypto';
import type { Database as SqliteDb } from 'better-sqlite3';
import type { KNode, KNodeKind } from '../types.js';
import { upsertKNode } from '../knowledge/store.js';

export interface ManifestStats {
  dependencies: number;
  tools: number;
}

interface RawFact {
  kind: KNodeKind;          // 'dependency' | 'tool'
  name: string;
  evidence: string;
}

type Add = (kind: KNodeKind, name: string, evidence: string) => void;

const MAX_DEPTH = 4;
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.substrate-net', '.dart_tool',
  '.next', '.nuxt', 'vendor', 'Pods', 'target', '.venv', 'venv', '__pycache__',
]);

export function runManifestParser(knowDb: SqliteDb, root: string): ManifestStats {
  const facts = new Map<string, RawFact>();   // dedup by kind+name
  const add: Add = (kind, name, evidence) => {
    const n = name.trim();
    if (!n) return;
    const key = `${kind}|${n.toLowerCase()}`;
    if (!facts.has(key)) facts.set(key, { kind, name: n, evidence });
  };

  for (const abs of walkManifests(root, add)) {
    const rel = relative(root, abs) || basename(abs);
    routeFile(abs, rel, add);
  }

  const stats: ManifestStats = { dependencies: 0, tools: 0 };
  const now = Date.now();
  const tx = knowDb.transaction(() => {
    for (const f of facts.values()) {
      const id = createHash('sha1').update(`${f.kind}|${f.name.toLowerCase()}`).digest('hex').slice(0, 16);
      const node: KNode = {
        id, kind: f.kind, title: f.name,
        summary: f.kind === 'dependency' ? `Declared dependency: ${f.name}` : `Tooling/infra: ${f.name}`,
        evidenceText: f.evidence,
        confidence: 1, source: 'structural:manifest', grounding: 'structural', scope: 'technical',
        createdAt: now, updatedAt: now,
      };
      upsertKNode(knowDb, node);
      if (f.kind === 'dependency') stats.dependencies++; else stats.tools++;
    }
  });
  tx();
  return stats;
}

/** Dispatch one file to the right parser by its basename. */
function routeFile(abs: string, rel: string, add: Add): void {
  const name = basename(abs);
  const raw = readSafe(abs);

  // Infra / tooling is detected by filename alone (content optional).
  detectInfra(name, rel, add);

  if (!raw) return;
  switch (name) {
    case 'package.json':     parsePackageJson(raw, rel, add); break;
    case 'requirements.txt': parseRequirements(raw, rel, add); break;
    case 'pyproject.toml':   parsePyproject(raw, rel, add); break;
    case 'go.mod':           parseGoMod(raw, rel, add); break;
    case 'Cargo.toml':       parseCargo(raw, rel, add); break;
    case 'pubspec.yaml':     parsePubspec(raw, rel, add); break;
    case 'composer.json':    parseComposer(raw, rel, add); break;
    case 'Gemfile':          parseGemfile(raw, rel, add); break;
    case 'mix.exs':          parseMixExs(raw, rel, add); break;
    case 'pom.xml':          parsePomXml(raw, rel, add); break;
    case 'build.gradle':
    case 'build.gradle.kts': parseGradle(raw, rel, add); break;
    default:
      if (name.endsWith('.csproj')) parseCsproj(raw, rel, add);
      break;
  }
}

function readSafe(abs: string): string | undefined {
  try { return readFileSync(abs, 'utf8'); } catch { return undefined; }
}

function parsePackageJson(raw: string, rel: string, add: Add): void {
  let pkg: any;
  try { pkg = JSON.parse(raw); } catch { return; }
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = pkg[section];
    if (deps && typeof deps === 'object') {
      for (const name of Object.keys(deps)) add('dependency', name, `${rel} (${section}): ${name}@${deps[name]}`);
    }
  }
}

function parseRequirements(raw: string, rel: string, add: Add): void {
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('-')) continue;
    const name = t.split(/[=<>!~\[ ]/)[0];
    if (name) add('dependency', name, `${rel}: ${t}`);
  }
}

function parsePyproject(raw: string, rel: string, add: Add): void {
  const arrMatch = raw.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
  if (arrMatch) {
    for (const m of arrMatch[1].matchAll(/["']([A-Za-z0-9_.\-]+)/g)) {
      add('dependency', m[1], `${rel}: ${m[1]}`);
    }
  }
  const poetry = raw.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(\n\[|$)/);
  if (poetry) {
    for (const m of poetry[1].matchAll(/^\s*([A-Za-z0-9_.\-]+)\s*=/gm)) {
      if (m[1].toLowerCase() !== 'python') add('dependency', m[1], `${rel} (poetry): ${m[1]}`);
    }
  }
}

function parseGoMod(raw: string, rel: string, add: Add): void {
  for (const m of raw.matchAll(/^\s*([a-z0-9.\-]+\/[^\s]+)\s+v[0-9]/gm)) {
    add('dependency', m[1], `${rel}: ${m[1]}`);
  }
}

function parseCargo(raw: string, rel: string, add: Add): void {
  const dep = raw.match(/\[dependencies\]([\s\S]*?)(\n\[|$)/);
  if (dep) {
    for (const m of dep[1].matchAll(/^\s*([A-Za-z0-9_\-]+)\s*=/gm)) add('dependency', m[1], `${rel}: ${m[1]}`);
  }
}

function parsePubspec(raw: string, rel: string, add: Add): void {
  const dep = raw.match(/\ndependencies:\s*\n([\s\S]*?)(\n\w|\n*$)/);
  if (dep) {
    for (const m of dep[1].matchAll(/^\s{2}([a-z0-9_]+):/gm)) {
      if (m[1] !== 'flutter') add('dependency', m[1], `${rel}: ${m[1]}`);
    }
  }
}

function parseComposer(raw: string, rel: string, add: Add): void {
  let pkg: any;
  try { pkg = JSON.parse(raw); } catch { return; }
  for (const section of ['require', 'require-dev']) {
    const deps = pkg[section];
    if (deps && typeof deps === 'object') {
      for (const name of Object.keys(deps)) if (name !== 'php') add('dependency', name, `${rel} (${section}): ${name}`);
    }
  }
}

function parseGemfile(raw: string, rel: string, add: Add): void {
  for (const m of raw.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)) add('dependency', m[1], `${rel}: ${m[1]}`);
}

function parseMixExs(raw: string, rel: string, add: Add): void {
  for (const m of raw.matchAll(/\{:\s*([a-zA-Z0-9_]+)\s*,/g)) {
    add('dependency', m[1], `${rel}: ${m[1]}`);
  }
}

function parsePomXml(raw: string, rel: string, add: Add): void {
  for (const m of raw.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)) add('dependency', m[1], `${rel}: ${m[1]}`);
}

function parseGradle(raw: string, rel: string, add: Add): void {
  for (const m of raw.matchAll(/(?:implementation|api|compile|testImplementation)[\s(]+["']([^"':]+:[^"':]+)/g)) {
    add('dependency', m[1], `${rel}: ${m[1]}`);
  }
}

function parseCsproj(raw: string, rel: string, add: Add): void {
  for (const m of raw.matchAll(/<PackageReference\s+Include="([^"]+)"/g)) {
    add('dependency', m[1], `${rel}: ${m[1]}`);
  }
}

const INFRA_FILES: Array<{ match: RegExp; tool: string }> = [
  { match: /^Dockerfile/, tool: 'Docker' },
  { match: /^docker-compose\.ya?ml$/, tool: 'Docker Compose' },
  { match: /^Makefile$/, tool: 'Make' },
  { match: /\.tf$/, tool: 'Terraform' },
  { match: /^(skaffold|helmfile)\.ya?ml$/, tool: 'Kubernetes' },
  { match: /^vercel\.json$/, tool: 'Vercel' },
  { match: /^netlify\.toml$/, tool: 'Netlify' },
  { match: /^serverless\.ya?ml$/, tool: 'Serverless Framework' },
];

function detectInfra(name: string, rel: string, add: Add): void {
  for (const rule of INFRA_FILES) {
    if (rule.match.test(name)) add('tool', rule.tool, rel);
  }
  if (name === '.gitlab-ci.yml') add('tool', 'GitLab CI', rel);
}

const INFRA_DIRS: Array<{ name: string; tool: string }> = [
  { name: '.circleci', tool: 'CircleCI' },
  { name: 'k8s', tool: 'Kubernetes' },
  { name: 'kubernetes', tool: 'Kubernetes' },
  { name: 'charts', tool: 'Kubernetes' },
];

/**
 * Collect manifest + infra files anywhere in the tree (depth-limited). Emits
 * directory-based tooling signals (GitHub Actions, CircleCI, k8s) via `add`
 * as it descends. Returns file paths for the caller to route by basename.
 */
function walkManifests(root: string, add: Add): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    if (entries.includes('.github') && existsSync(join(dir, '.github', 'workflows'))) {
      add('tool', 'GitHub Actions', `${relative(root, dir) || '.'}/.github/workflows/`);
    }
    for (const name of entries) {
      const infra = INFRA_DIRS.find((d) => d.name === name);
      if (infra) add('tool', infra.tool, `${relative(root, join(dir, name))}/`);
      if (SKIP_DIRS.has(name)) continue;
      const abs = join(dir, name);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) walk(abs, depth + 1);
      else out.push(abs);
    }
  };
  walk(root, 0);
  return out;
}

import { extname } from 'path';
import type { Language } from '../types.js';

interface LangSpec {
  language: Language;
  /** Tree-sitter WASM file; empty string for languages handled by a non-tree-sitter extractor (e.g. SQL). */
  wasmFile: string;
}

const EXT_MAP: Record<string, LangSpec> = {
  '.ts':   { language: 'typescript', wasmFile: 'tree-sitter-typescript.wasm' },
  '.mts':  { language: 'typescript', wasmFile: 'tree-sitter-typescript.wasm' },
  '.cts':  { language: 'typescript', wasmFile: 'tree-sitter-typescript.wasm' },
  '.tsx':  { language: 'tsx',        wasmFile: 'tree-sitter-tsx.wasm' },
  '.js':   { language: 'javascript', wasmFile: 'tree-sitter-javascript.wasm' },
  '.mjs':  { language: 'javascript', wasmFile: 'tree-sitter-javascript.wasm' },
  '.cjs':  { language: 'javascript', wasmFile: 'tree-sitter-javascript.wasm' },
  '.jsx':  { language: 'jsx',        wasmFile: 'tree-sitter-javascript.wasm' },
  '.py':   { language: 'python',     wasmFile: 'tree-sitter-python.wasm' },
  '.dart': { language: 'dart',       wasmFile: 'tree-sitter-dart.wasm' },
  '.go':   { language: 'go',         wasmFile: 'tree-sitter-go.wasm' },
  '.rs':   { language: 'rust',       wasmFile: 'tree-sitter-rust.wasm' },
  '.java': { language: 'java',       wasmFile: 'tree-sitter-java.wasm' },
  '.sql':  { language: 'sql',        wasmFile: '' },
  '.ddl':  { language: 'sql',        wasmFile: '' },
  '.cs':   { language: 'csharp',     wasmFile: 'tree-sitter-c_sharp.wasm' },
  '.ex':   { language: 'elixir',     wasmFile: 'tree-sitter-elixir.wasm' },
  '.exs':  { language: 'elixir',     wasmFile: 'tree-sitter-elixir.wasm' },
};

export function detectLanguage(filePath: string): LangSpec | undefined {
  return EXT_MAP[extname(filePath).toLowerCase()];
}

export function allSupportedExtensions(): string[] {
  return Object.keys(EXT_MAP);
}

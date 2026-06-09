/**
 * Language-specific extraction by walking tree-sitter syntax nodes.
 *
 * Trade-off: this is intentionally simpler than codegraph's full extraction.
 * It captures the most useful symbol kinds (classes / functions / methods /
 * imports) and containment + import edges + call edges (best-effort,
 * name-based, left for cross-file resolution).
 */
import type { Node as TsNode, Tree } from 'web-tree-sitter';
import { createHash } from 'crypto';
import type { CodeNode, CodeEdge, Language, NodeKind, EdgeKind } from '../types.js';

export interface ExtractionResult {
  nodes: CodeNode[];
  edges: CodeEdge[];
  unresolvedCalls: { fromId: string; name: string; line: number; col: number }[];
}

export interface ExtractCtx {
  filePath: string;       // path relative to project root
  language: Language;
  source: string;
  now: number;
}

export function extract(tree: Tree, ctx: ExtractCtx): ExtractionResult {
  const result: ExtractionResult = { nodes: [], edges: [], unresolvedCalls: [] };
  const fileId = nodeId(ctx.filePath, 'file', ctx.filePath);
  result.nodes.push({
    id: fileId,
    kind: 'file',
    name: basename(ctx.filePath),
    qualifiedName: ctx.filePath,
    filePath: ctx.filePath,
    language: ctx.language,
    startLine: 1,
    endLine: countLines(ctx.source),
    startColumn: 0,
    endColumn: 0,
    updatedAt: ctx.now,
  });

  walk(tree.rootNode, fileId, [], ctx, result);
  return result;
}

function walk(
  node: TsNode,
  parentId: string,
  qualifier: string[],
  ctx: ExtractCtx,
  result: ExtractionResult,
): void {
  const handler = HANDLERS[node.type];
  let newParentId = parentId;
  let newQualifier = qualifier;

  if (handler) {
    const created = handler(node, parentId, qualifier, ctx, result);
    if (created) {
      newParentId = created.id;
      newQualifier = [...qualifier, created.name];
    }
  } else {
    // Best-effort call-site capture for known call expression types.
    if (node.type === 'call_expression') {
      captureCall(node, parentId, ctx, result);
    }
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) walk(child, newParentId, newQualifier, ctx, result);
  }
}

// ============================================================================
// Per-node-type handlers
// ============================================================================

type Handler = (
  node: TsNode, parentId: string, qualifier: string[], ctx: ExtractCtx, result: ExtractionResult,
) => { id: string; name: string } | undefined;

const HANDLERS: Record<string, Handler> = {
  // ---------- TS / JS ----------
  function_declaration: (n, p, q, c, r) => emitNamed(n, 'function', p, q, c, r),
  function:             (n, p, q, c, r) => emitNamed(n, 'function', p, q, c, r),
  generator_function_declaration: (n, p, q, c, r) => emitNamed(n, 'function', p, q, c, r),
  arrow_function:       (n, p, q, c, r) => emitAnonFunctionFromAssignment(n, p, q, c, r),
  class_declaration:    (n, p, q, c, r) => emitNamed(n, 'class', p, q, c, r),
  class:                (n, p, q, c, r) => emitNamed(n, 'class', p, q, c, r),
  abstract_class_declaration: (n, p, q, c, r) => emitNamed(n, 'class', p, q, c, r),
  interface_declaration: (n, p, q, c, r) => emitNamed(n, 'interface', p, q, c, r),
  type_alias_declaration: (n, p, q, c, r) => emitNamed(n, 'type_alias', p, q, c, r),
  enum_declaration:     (n, p, q, c, r) => emitNamed(n, 'enum', p, q, c, r),
  method_definition:    (n, p, q, c, r) => emitNamed(n, 'method', p, q, c, r),
  method_signature:     (n, p, q, c, r) => emitNamed(n, 'method', p, q, c, r),
  abstract_method_signature: (n, p, q, c, r) => emitNamed(n, 'method', p, q, c, r),
  public_field_definition: (n, p, q, c, r) => emitNamed(n, 'property', p, q, c, r),
  property_signature:   (n, p, q, c, r) => emitNamed(n, 'property', p, q, c, r),
  import_statement:     (n, p, _q, c, r) => emitImport(n, p, c, r),
  // ---------- Python ----------
  function_definition:  (n, p, q, c, r) => emitNamed(n, qualifierIsClass(q) ? 'method' : 'function', p, q, c, r),
  class_definition:     (n, p, q, c, r) => emitNamed(n, 'class', p, q, c, r),
  import_from_statement: (n, p, _q, c, r) => emitPyImport(n, p, c, r),
  import_statement_py:  (n, p, _q, c, r) => emitPyImport(n, p, c, r),
  // ---------- Dart ----------
  // class_definition is shared with Python and works for Dart as-is.
  mixin_declaration:    (n, p, q, c, r) => emitNamed(n, 'class', p, q, c, r),
  // function_signature is the name-bearing node in Dart — used for both
  // top-level functions and (nested inside method_signature) for class methods.
  function_signature:   (n, p, q, c, r) => emitDartFunctionLike(n, p, q, c, r),
  constructor_signature: (n, p, q, c, r) => emitNamed(n, 'method', p, q, c, r),
  getter_signature:     (n, p, q, c, r) => emitNamed(n, 'method', p, q, c, r),
  setter_signature:     (n, p, q, c, r) => emitNamed(n, 'method', p, q, c, r),
  // Field shapes:
  //   declaration > initialized_identifier_list > initialized_identifier (instance)
  //   declaration > static_final_declaration_list > static_final_declaration (static)
  initialized_identifier: (n, p, q, c, r) => emitDartField(n, p, q, c, r),
  static_final_declaration: (n, p, q, c, r) => emitDartField(n, p, q, c, r),
  // Local variables (in function bodies) — still useful but lower-priority.
  initialized_variable_definition: (n, p, q, c, r) =>
    emitNamed(n, 'variable', p, q, c, r),
  import_or_export:     (n, p, _q, c, r) => emitDartImport(n, p, c, r),
  // Enum members (enum_declaration is shared with TS); extensions; typedefs.
  enum_constant:        (n, p, q, c, r) => emitNamed(n, 'enum_member', p, q, c, r),
  extension_declaration: (n, p, q, c, r) => emitDartExtension(n, p, q, c, r),
  type_alias:           (n, p, q, c, r) => emitNamed(n, 'type_alias', p, q, c, r),
  // ---------- Go (function_declaration / type_alias shared with TS/Dart) ----------
  method_declaration:   (n, p, q, c, r) => emitNamed(n, 'method', p, q, c, r),
  type_spec:            (n, p, q, c, r) => emitGoTypeSpec(n, p, q, c, r),
  const_spec:           (n, p, q, c, r) => emitNamed(n, 'constant', p, q, c, r),
  var_spec:             (n, p, q, c, r) => emitNamed(n, 'variable', p, q, c, r),
  // field_declaration: shape-aware (Go field_identifier OR Java variable_declarator).
  field_declaration:    (n, p, q, c, r) => emitFieldDeclarationMulti(n, p, q, c, r),
  method_spec:          (n, p, q, c, r) => emitNamed(n, 'method', p, q, c, r),
  // import_declaration: shape-aware (Go import_spec OR Java scoped_identifier).
  import_declaration:   (n, p, _q, c, r) => emitImportDeclarationMulti(n, p, c, r),
  // ---------- Rust ----------
  use_declaration:      (n, p, _q, c, r) => emitRustUse(n, p, c, r),
  mod_item:             (n, p, q, c, r) => emitNamed(n, 'module', p, q, c, r),
  struct_item:          (n, p, q, c, r) => emitNamed(n, 'struct', p, q, c, r),
  enum_item:            (n, p, q, c, r) => emitNamed(n, 'enum', p, q, c, r),
  enum_variant:         (n, p, q, c, r) => emitNamed(n, 'enum_member', p, q, c, r),
  trait_item:           (n, p, q, c, r) => emitNamed(n, 'interface', p, q, c, r),
  impl_item:            (n, p, q, c, r) => emitRustImpl(n, p, q, c, r),
  function_item:        (n, p, q, c, r) => emitRustFn(n, p, q, c, r),
  function_signature_item: (n, p, q, c, r) => emitNamed(n, 'method', p, q, c, r),
  const_item:           (n, p, q, c, r) => emitNamed(n, 'constant', p, q, c, r),
  static_item:          (n, p, q, c, r) => emitNamed(n, 'constant', p, q, c, r),
  type_item:            (n, p, q, c, r) => emitNamed(n, 'type_alias', p, q, c, r),
  // ---------- Java ----------
  // class_declaration, interface_declaration, enum_declaration, enum_constant
  // and method_declaration are already registered for TS/Go/Dart with the
  // correct kinds and node shapes. Java-only additions:
  constructor_declaration: (n, p, q, c, r) => emitNamed(n, 'method', p, q, c, r),
  record_declaration:   (n, p, q, c, r) => emitNamed(n, 'class', p, q, c, r),
  // ---------- C# (most C# nodes overlap with TS/Java) ----------
  // class_declaration / interface_declaration / enum_declaration / method_declaration /
  // constructor_declaration / record_declaration / field_declaration are already handled.
  using_directive:          (n, p, _q, c, r) => emitCsUsing(n, p, c, r),
  namespace_declaration:    (n, p, q, c, r) => emitCsNamespace(n, p, q, c, r),
  struct_declaration:       (n, p, q, c, r) => emitNamed(n, 'struct', p, q, c, r),
  property_declaration:     (n, p, q, c, r) => emitNamed(n, 'property', p, q, c, r),
  event_field_declaration:  (n, p, q, c, r) => emitFieldDeclarationMulti(n, p, q, c, r),
  enum_member_declaration:  (n, p, q, c, r) => emitNamed(n, 'enum_member', p, q, c, r),
  delegate_declaration:     (n, p, q, c, r) => emitNamed(n, 'type_alias', p, q, c, r),
  // ---------- Elixir (all top-level forms are `call` nodes) ----------
  call:                     (n, p, q, c, r) => (c.language === 'elixir' ? emitElixirCall(n, p, q, c, r) : undefined),
};

function qualifierIsClass(q: string[]): boolean {
  // Heuristic: only correct if we track parent kind; for now treat any non-empty qualifier as nested.
  return q.length > 0;
}

function emitNamed(
  node: TsNode, kind: NodeKind, parentId: string, qualifier: string[],
  ctx: ExtractCtx, result: ExtractionResult,
): { id: string; name: string } | undefined {
  const name = identifierName(node);
  if (!name) return undefined;
  const qualified = `${ctx.filePath}::${[...qualifier, name].join('.')}`;
  const id = nodeId(ctx.filePath, kind, qualified);
  result.nodes.push({
    id,
    kind,
    name,
    qualifiedName: qualified,
    filePath: ctx.filePath,
    language: ctx.language,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    signature: firstLine(node.text),
    isAsync: node.text.startsWith('async '),
    updatedAt: ctx.now,
  });
  result.edges.push({ source: parentId, target: id, kind: 'contains' });
  return { id, name };
}

/** `const foo = () => {}` → emit a function node named `foo`. */
function emitAnonFunctionFromAssignment(
  node: TsNode, parentId: string, qualifier: string[],
  ctx: ExtractCtx, result: ExtractionResult,
): { id: string; name: string } | undefined {
  const parent = node.parent;
  if (!parent) return undefined;
  if (parent.type !== 'variable_declarator' && parent.type !== 'assignment_expression') return undefined;
  const nameNode = parent.childForFieldName('name') ?? parent.namedChild(0);
  const name = nameNode?.text;
  if (!name) return undefined;
  const qualified = `${ctx.filePath}::${[...qualifier, name].join('.')}`;
  const id = nodeId(ctx.filePath, 'function', qualified);
  result.nodes.push({
    id,
    kind: 'function',
    name,
    qualifiedName: qualified,
    filePath: ctx.filePath,
    language: ctx.language,
    startLine: parent.startPosition.row + 1,
    endLine: parent.endPosition.row + 1,
    startColumn: parent.startPosition.column,
    endColumn: parent.endPosition.column,
    signature: firstLine(parent.text),
    isAsync: node.text.startsWith('async '),
    updatedAt: ctx.now,
  });
  result.edges.push({ source: parentId, target: id, kind: 'contains' });
  return { id, name };
}

function emitImport(node: TsNode, fileId: string, ctx: ExtractCtx, result: ExtractionResult): undefined {
  // import_statement → source field on a string literal.
  const sourceNode = node.childForFieldName('source')
    ?? node.namedChildren.find((c) => c?.type === 'string') ?? null;
  if (!sourceNode) return undefined;
  const moduleName = sourceNode.text.replace(/^['"`]|['"`]$/g, '');
  const id = nodeId(ctx.filePath, 'import', `${ctx.filePath}::import::${moduleName}`);
  result.nodes.push({
    id,
    kind: 'import',
    name: moduleName,
    qualifiedName: `${ctx.filePath}::import::${moduleName}`,
    filePath: ctx.filePath,
    language: ctx.language,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    signature: node.text.split('\n')[0],
    updatedAt: ctx.now,
  });
  result.edges.push({ source: fileId, target: id, kind: 'imports', line: node.startPosition.row + 1 });
  return undefined;
}

/**
 * Dart function_signature handler.
 *
 * In Dart this is the node that *holds* the function/method name. It appears:
 *   - directly under `program` for top-level functions
 *   - inside `method_signature` for class methods
 *   - inside class-body `declaration` wrappers for some forms
 *
 * Kind is decided by the qualifier chain: empty → top-level function,
 * non-empty → nested under a class/mixin/etc. → method.
 */
function emitDartFunctionLike(
  node: TsNode, parentId: string, qualifier: string[],
  ctx: ExtractCtx, result: ExtractionResult,
): { id: string; name: string } | undefined {
  // Avoid double-emit on Dart `mixin walk()` style where the TS
  // `method_signature` handler already produced a node above us.
  if (node.parent?.type === 'method_signature') {
    // method_signature has no name itself on Dart; in that case the
    // existing TS handler bailed (identifierName=undefined) so no dup —
    // we still want to emit here. Continue.
  }
  return emitNamed(node, qualifierIsClass(qualifier) ? 'method' : 'function', parentId, qualifier, ctx, result);
}

/**
 * Dart `import_or_export` handler.
 *
 * Structure: import_or_export > library_import > import_specification > configurable_uri.
 * The URI is a string literal; we strip the quotes.
 */
function emitDartImport(node: TsNode, fileId: string, ctx: ExtractCtx, result: ExtractionResult): undefined {
  const uriNode = findDescendantByType(node, 'configurable_uri', 4);
  if (!uriNode) return undefined;
  const raw = uriNode.text.trim();
  const moduleName = raw.replace(/^['"`]|['"`]$/g, '');
  const id = nodeId(ctx.filePath, 'import', `${ctx.filePath}::import::${moduleName}`);
  result.nodes.push({
    id,
    kind: 'import',
    name: moduleName,
    qualifiedName: `${ctx.filePath}::import::${moduleName}`,
    filePath: ctx.filePath,
    language: ctx.language,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    signature: firstLine(node.text),
    updatedAt: ctx.now,
  });
  result.edges.push({ source: fileId, target: id, kind: 'imports', line: node.startPosition.row + 1 });
  return undefined;
}

/**
 * Dart field emitter — only emit when this initialized_identifier sits in a
 * class body (skips locals in function bodies). Walks up the AST to confirm.
 */
function emitDartField(
  node: TsNode, parentId: string, qualifier: string[],
  ctx: ExtractCtx, result: ExtractionResult,
): { id: string; name: string } | undefined {
  if (!isInsideClassBody(node)) return undefined;
  return emitNamed(node, 'field', parentId, qualifier, ctx, result);
}

/**
 * True if this node sits inside a class/enum/extension body without an
 * intervening function body. Used to distinguish fields from locals.
 */
function isInsideClassBody(node: TsNode): boolean {
  let cur: TsNode | null = node.parent;
  while (cur) {
    if (cur.type === 'function_body' || cur.type === 'block') return false;
    if (cur.type === 'class_body' || cur.type === 'enum_body' || cur.type === 'extension_body') return true;
    cur = cur.parent;
  }
  return false;
}

/**
 * Dart extension handler. Extensions may be anonymous (`extension on String {...}`);
 * in that case we synthesize a stable name from the extended type so members
 * still get a parent + qualifier chain.
 */
function emitDartExtension(
  node: TsNode, parentId: string, qualifier: string[],
  ctx: ExtractCtx, result: ExtractionResult,
): { id: string; name: string } | undefined {
  // First direct named child is either the extension name (identifier) or the
  // extended type (type_identifier) when anonymous.
  let name: string | undefined;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c?.type === 'identifier') { name = c.text; break; }
  }
  if (!name) {
    const onType = (() => {
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c?.type === 'type_identifier') return c.text;
      }
      return undefined;
    })();
    name = onType ? `__ext_on_${onType}` : undefined;
  }
  if (!name) return undefined;
  const qualified = `${ctx.filePath}::${[...qualifier, name].join('.')}`;
  const id = nodeId(ctx.filePath, 'class', qualified);
  result.nodes.push({
    id,
    kind: 'class',
    name,
    qualifiedName: qualified,
    filePath: ctx.filePath,
    language: ctx.language,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    signature: firstLine(node.text),
    updatedAt: ctx.now,
  });
  result.edges.push({ source: parentId, target: id, kind: 'contains' });
  return { id, name };
}

/**
 * Go `type_spec` handler. Kind is decided by the kind of type expression.
 *   type Foo struct {...}      -> struct
 *   type Foo interface {...}   -> interface
 *   type Foo []int             -> type_alias (named type)
 *   type Foo = ...             -> handled by `type_alias` node, not type_spec
 */
function emitGoTypeSpec(
  node: TsNode, parentId: string, qualifier: string[],
  ctx: ExtractCtx, result: ExtractionResult,
): { id: string; name: string } | undefined {
  let kind: NodeKind = 'type_alias';
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type === 'struct_type')    { kind = 'struct'; break; }
    if (c.type === 'interface_type') { kind = 'interface'; break; }
  }
  return emitNamed(node, kind, parentId, qualifier, ctx, result);
}

/**
 * Shape-aware field_declaration handler covering Go, Rust, Java, and C#.
 *   - Go:   `field_declaration > field_identifier (one or more), type`
 *   - Rust: `field_declaration > field_identifier (one), type`
 *   - Java: `field_declaration > modifiers, type_*, variable_declarator > identifier`
 *   - C#:   `field_declaration > variable_declaration > variable_declarator > identifier`
 *           also `event_field_declaration` with same nested shape
 *
 * Emits one `field` node per field name. Containment edge points at the
 * enclosing struct/class/interface body (the walker's current parentId).
 */
function emitFieldDeclarationMulti(
  node: TsNode, parentId: string, qualifier: string[],
  ctx: ExtractCtx, result: ExtractionResult,
): { id: string; name: string } | undefined {
  const names: string[] = [];
  const declarators: TsNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type === 'field_identifier') names.push(c.text);
    else if (c.type === 'variable_declarator') declarators.push(c);
    else if (c.type === 'variable_declaration') {
      // C# wraps declarators inside variable_declaration; drill one level.
      for (let j = 0; j < c.namedChildCount; j++) {
        const inner = c.namedChild(j);
        if (inner?.type === 'variable_declarator') declarators.push(inner);
      }
    }
  }
  for (const decl of declarators) {
    for (let j = 0; j < decl.namedChildCount; j++) {
      const id = decl.namedChild(j);
      if (id?.type === 'identifier') { names.push(id.text); break; }
    }
  }
  let lastEmit: { id: string; name: string } | undefined;
  for (const name of names) {
    const qualified = `${ctx.filePath}::${[...qualifier, name].join('.')}`;
    const id = nodeId(ctx.filePath, 'field', qualified);
    result.nodes.push({
      id, kind: 'field', name, qualifiedName: qualified,
      filePath: ctx.filePath, language: ctx.language,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startColumn: node.startPosition.column,
      endColumn: node.endPosition.column,
      signature: firstLine(node.text),
      updatedAt: ctx.now,
    });
    result.edges.push({ source: parentId, target: id, kind: 'contains' });
    lastEmit = { id, name };
  }
  return lastEmit;
}

/**
 * Shape-aware import_declaration handler covering Go and Java.
 *   - Go:   `import_declaration > import_spec(_list) > interpreted_string_literal`
 *   - Java: `import_declaration > scoped_identifier` (or `identifier` for single segment)
 */
function emitImportDeclarationMulti(node: TsNode, fileId: string, ctx: ExtractCtx, result: ExtractionResult): undefined {
  const goSpecs: TsNode[] = [];
  collectByType(node, 'import_spec', goSpecs);
  if (goSpecs.length > 0) {
    for (const spec of goSpecs) {
      const pathNode = findChildByType(spec, ['interpreted_string_literal', 'raw_string_literal']);
      if (!pathNode) continue;
      const importPath = pathNode.text.replace(/^['"`]|['"`]$/g, '');
      pushImport(result, fileId, ctx, spec, importPath);
    }
    return undefined;
  }
  // Java path: take the deepest scoped_identifier / identifier as the full path.
  const ident = findChildByType(node, ['scoped_identifier', 'identifier']);
  if (ident) pushImport(result, fileId, ctx, node, ident.text);
  return undefined;
}

function pushImport(
  result: ExtractionResult, fileId: string, ctx: ExtractCtx, spanNode: TsNode, importPath: string,
): void {
  const id = nodeId(ctx.filePath, 'import', `${ctx.filePath}::import::${importPath}`);
  result.nodes.push({
    id, kind: 'import', name: importPath,
    qualifiedName: `${ctx.filePath}::import::${importPath}`,
    filePath: ctx.filePath, language: ctx.language,
    startLine: spanNode.startPosition.row + 1,
    endLine: spanNode.endPosition.row + 1,
    startColumn: spanNode.startPosition.column,
    endColumn: spanNode.endPosition.column,
    signature: firstLine(spanNode.text),
    updatedAt: ctx.now,
  });
  result.edges.push({ source: fileId, target: id, kind: 'imports', line: spanNode.startPosition.row + 1 });
}

function collectByType(node: TsNode, type: string, out: TsNode[]): void {
  if (node.type === type) { out.push(node); return; }
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c) collectByType(c, type, out);
  }
}

function findChildByType(node: TsNode, types: string[]): TsNode | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && types.includes(c.type)) return c;
  }
  return undefined;
}

// ============================================================================
// Rust helpers
// ============================================================================

/**
 * `use std::collections::HashMap;` / `use crate::api::{Client, Request};`
 * Emit a single import node per use_declaration; name = full text (sans `use ` and `;`).
 */
function emitRustUse(node: TsNode, fileId: string, ctx: ExtractCtx, result: ExtractionResult): undefined {
  // Pull the path-bearing child (scoped_identifier, scoped_use_list, identifier, use_wildcard).
  const pathNode =
    findChildByType(node, ['scoped_identifier', 'scoped_use_list', 'use_as_clause', 'identifier', 'use_wildcard']);
  const name = (pathNode?.text ?? node.text.replace(/^use\s+|;\s*$/g, '')).trim();
  if (!name) return undefined;
  pushImport(result, fileId, ctx, node, name);
  return undefined;
}

/**
 * `impl Foo { ... }` / `impl Trait for Foo { ... }`.
 * Synthesize a name so the impl block becomes a parent container for its methods.
 */
function emitRustImpl(
  node: TsNode, parentId: string, qualifier: string[],
  ctx: ExtractCtx, result: ExtractionResult,
): { id: string; name: string } | undefined {
  // Two leading type_identifiers in "impl Trait for Foo": first=trait, second=type.
  const types: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type === 'type_identifier' || c.type === 'scoped_type_identifier' || c.type === 'generic_type') {
      types.push(c.text);
      if (types.length === 2) break;
    }
  }
  const name = types.length === 2 ? `impl ${types[0]} for ${types[1]}` :
               types.length === 1 ? `impl ${types[0]}` : 'impl';
  const qualified = `${ctx.filePath}::${[...qualifier, name].join('.')}`;
  const id = nodeId(ctx.filePath, 'class', qualified);
  result.nodes.push({
    id, kind: 'class', name, qualifiedName: qualified,
    filePath: ctx.filePath, language: ctx.language,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    signature: firstLine(node.text),
    updatedAt: ctx.now,
  });
  result.edges.push({ source: parentId, target: id, kind: 'contains' });
  return { id, name };
}

// ============================================================================
// Elixir helpers
// ============================================================================

const ELIXIR_DEF_KW = new Set(['def', 'defp', 'defmacro', 'defmacrop']);
const ELIXIR_IMPORT_KW = new Set(['alias', 'import', 'use', 'require']);

function emitElixirCall(
  node: TsNode, parentId: string, qualifier: string[],
  ctx: ExtractCtx, result: ExtractionResult,
): { id: string; name: string } | undefined {
  const kw = elixirCallKeyword(node);
  if (!kw) {
    captureElixirCall(node, parentId, result);
    return undefined;
  }
  const args = elixirCallArguments(node);
  if (kw === 'defmodule') {
    const name = args ? elixirModuleName(args) : undefined;
    if (!name) return undefined;
    return emitElixirNamed(node, 'module', name, parentId, qualifier, ctx, result);
  }
  if (ELIXIR_DEF_KW.has(kw)) {
    const name = args ? elixirDefName(args) : undefined;
    if (!name) return undefined;
    const kind = qualifierIsClass(qualifier) ? 'method' : 'function';
    return emitElixirNamed(node, kind, name, parentId, qualifier, ctx, result);
  }
  if (ELIXIR_IMPORT_KW.has(kw)) {
    const path = args ? elixirImportPath(args) : undefined;
    if (path) pushImport(result, parentId, ctx, node, path);
    return undefined;
  }
  captureElixirCall(node, parentId, result);
  return undefined;
}

function elixirCallKeyword(node: TsNode): string | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c?.type === 'identifier') return c.text;
  }
  return undefined;
}

function elixirCallArguments(node: TsNode): TsNode | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c?.type === 'arguments') return c;
  }
  return undefined;
}

function elixirModuleName(args: TsNode): string | undefined {
  for (let i = 0; i < args.namedChildCount; i++) {
    const c = args.namedChild(i);
    if (c?.type === 'alias') return c.text;
  }
  return undefined;
}

function elixirDefName(args: TsNode): string | undefined {
  for (let i = 0; i < args.namedChildCount; i++) {
    const c = args.namedChild(i);
    if (!c) continue;
    if (c.type === 'identifier') return c.text;
    if (c.type === 'call') return elixirCallKeyword(c);
  }
  return undefined;
}

function elixirImportPath(args: TsNode): string | undefined {
  for (let i = 0; i < args.namedChildCount; i++) {
    const c = args.namedChild(i);
    if (c?.type === 'alias') return c.text;
  }
  return undefined;
}

function emitElixirNamed(
  node: TsNode, kind: NodeKind, name: string, parentId: string, qualifier: string[],
  ctx: ExtractCtx, result: ExtractionResult,
): { id: string; name: string } {
  const qualified = `${ctx.filePath}::${[...qualifier, name].join('.')}`;
  const id = nodeId(ctx.filePath, kind, qualified);
  result.nodes.push({
    id, kind, name, qualifiedName: qualified,
    filePath: ctx.filePath, language: ctx.language,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    signature: firstLine(node.text),
    updatedAt: ctx.now,
  });
  result.edges.push({ source: parentId, target: id, kind: 'contains' });
  return { id, name };
}

function isElixirDefHeadCall(node: TsNode): boolean {
  const parent = node.parent;
  if (parent?.type !== 'arguments') return false;
  const grand = parent.parent;
  if (grand?.type !== 'call') return false;
  const kw = elixirCallKeyword(grand);
  return !!kw && ELIXIR_DEF_KW.has(kw);
}

function captureElixirCall(node: TsNode, currentParentId: string, result: ExtractionResult): void {
  if (isElixirDefHeadCall(node)) return;
  const kw = elixirCallKeyword(node);
  if (kw && (kw === 'defmodule' || ELIXIR_DEF_KW.has(kw) || ELIXIR_IMPORT_KW.has(kw))) return;
  const name = elixirCalleeName(node);
  if (!name) return;
  result.unresolvedCalls.push({
    fromId: currentParentId,
    name,
    line: node.startPosition.row + 1,
    col: node.startPosition.column,
  });
}

function elixirCalleeName(node: TsNode): string | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type === 'dot') {
      for (let j = c.namedChildCount - 1; j >= 0; j--) {
        const part = c.namedChild(j);
        if (part?.type === 'identifier') return part.text;
      }
    }
    if (c.type === 'identifier') return c.text;
  }
  return undefined;
}

// ============================================================================
// C# helpers
// ============================================================================

/**
 * `using System;` / `using A.B.C;` / `using Alias = A.B;` — emit one import
 * per using_directive with the path as the name. For aliased usings, take
 * the target path (right of `=`), not the alias.
 */
function emitCsUsing(node: TsNode, fileId: string, ctx: ExtractCtx, result: ExtractionResult): undefined {
  // Skip `name_equals` (the alias side); the path is the next qualified_name or identifier.
  let pathNode: TsNode | undefined;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c || c.type === 'name_equals') continue;
    if (c.type === 'qualified_name' || c.type === 'identifier') { pathNode = c; break; }
  }
  if (!pathNode) return undefined;
  pushImport(result, fileId, ctx, node, pathNode.text);
  return undefined;
}

/**
 * `namespace A.B { ... }` (and file-scoped `namespace A.B;`). Emit as a
 * `module` node so child types are correctly nested in the qualifier chain.
 */
function emitCsNamespace(
  node: TsNode, parentId: string, qualifier: string[],
  ctx: ExtractCtx, result: ExtractionResult,
): { id: string; name: string } | undefined {
  // Take the first qualified_name or identifier as the namespace path.
  let nameNode: TsNode | undefined;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && (c.type === 'qualified_name' || c.type === 'identifier')) { nameNode = c; break; }
  }
  if (!nameNode) return undefined;
  const name = nameNode.text;
  const qualified = `${ctx.filePath}::${[...qualifier, name].join('.')}`;
  const id = nodeId(ctx.filePath, 'module', qualified);
  result.nodes.push({
    id, kind: 'module', name, qualifiedName: qualified,
    filePath: ctx.filePath, language: ctx.language,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    signature: `namespace ${name}`,
    updatedAt: ctx.now,
  });
  result.edges.push({ source: parentId, target: id, kind: 'contains' });
  return { id, name };
}

/**
 * Rust `function_item`. Kind depends on enclosing context: inside an impl_item
 * (via declaration_list) → method; otherwise → function.
 */
function emitRustFn(
  node: TsNode, parentId: string, qualifier: string[],
  ctx: ExtractCtx, result: ExtractionResult,
): { id: string; name: string } | undefined {
  const isMethod = node.parent?.type === 'declaration_list' && node.parent.parent?.type === 'impl_item';
  return emitNamed(node, isMethod ? 'method' : 'function', parentId, qualifier, ctx, result);
}

function findDescendantByType(node: TsNode, type: string, maxDepth: number): TsNode | undefined {
  if (node.type === type) return node;
  if (maxDepth <= 0) return undefined;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    const found = findDescendantByType(c, type, maxDepth - 1);
    if (found) return found;
  }
  return undefined;
}

function emitPyImport(node: TsNode, fileId: string, ctx: ExtractCtx, result: ExtractionResult): undefined {
  // For Python: just record the full import statement text as the import name.
  const name = firstLine(node.text);
  const id = nodeId(ctx.filePath, 'import', `${ctx.filePath}::import::${name}`);
  result.nodes.push({
    id,
    kind: 'import',
    name,
    qualifiedName: `${ctx.filePath}::import::${name}`,
    filePath: ctx.filePath,
    language: ctx.language,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    signature: name,
    updatedAt: ctx.now,
  });
  result.edges.push({ source: fileId, target: id, kind: 'imports', line: node.startPosition.row + 1 });
  return undefined;
}

function captureCall(node: TsNode, currentParentId: string, ctx: ExtractCtx, result: ExtractionResult): void {
  // Calls have `function` field which is the callee expression.
  const fn = node.childForFieldName('function') ?? node.namedChild(0);
  if (!fn) return;
  const name = simpleCalleeName(fn);
  if (!name) return;
  // The caller is whatever symbol owns `currentParentId` — the walker tracks this.
  result.unresolvedCalls.push({
    fromId: currentParentId,
    name,
    line: node.startPosition.row + 1,
    col: node.startPosition.column,
  });
}

function simpleCalleeName(fn: TsNode): string | undefined {
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'member_expression' || fn.type === 'attribute') {
    // Use the property/attr name as the call target name.
    const prop = fn.childForFieldName('property') ?? fn.childForFieldName('attribute') ?? fn.lastChild;
    return prop?.text;
  }
  return undefined;
}

function identifierName(node: TsNode): string | undefined {
  const named = node.childForFieldName('name');
  if (named?.text) return named.text;
  // Fallback: scan children for the first identifier-like node. `field_identifier`
  // is included so Go method_declaration and struct/interface field names resolve.
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (
      c && (
        c.type === 'identifier' ||
        c.type === 'type_identifier' ||
        c.type === 'property_identifier' ||
        c.type === 'field_identifier'
      )
    ) {
      return c.text;
    }
  }
  return undefined;
}

// ============================================================================
// utils
// ============================================================================

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

function countLines(s: string): number {
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return (i < 0 ? s : s.slice(0, i)).trim().slice(0, 240);
}

function nodeId(filePath: string, kind: string, qualified: string): string {
  return createHash('sha1').update(`${kind}|${qualified}|${filePath}`).digest('hex').slice(0, 16);
}

// Suppress unused-var warning for emitNamed `edges` arg destruct -- kind referenced once
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _ek: EdgeKind = 'contains';

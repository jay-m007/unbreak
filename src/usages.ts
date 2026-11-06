// Finds every place the project uses something a rule covers, and works out the exact text edit.
// All lookups go through the TypeScript checker, so aliases (`const f = faker`), renamed imports
// and other instances (`fakerDE.person`) are found by meaning, not by searching text.
import ts from "typescript";
import { declKeyOf } from "./surface.ts";
import type { Surface } from "./surface.ts";
import { ruleForPath } from "./rules.ts";
import type { Rule, RuleIndex } from "./rules.ts";
import { isProjectFile } from "./project.ts";
import type { Project } from "./project.ts";

export interface Edit {
  start: number;
  end: number;
  text: string;
}

export interface Usage {
  id: number;
  file: string;
  start: number; // range of the code that uses the old API (for matching compiler errors)
  end: number;
  line: number;
  path: string; // old API path, e.g. faker.random.numeric
  rule: Rule;
  edits: Edit[];
  summary: string; // "faker.random.numeric -> faker.string.numeric"
  problem?: string; // set when a rule applies but no safe edit could be made
}

const slash = (p: string) => p.replace(/\\/g, "/");

function resolveSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  let sym = checker.getSymbolAtLocation(node);
  if (sym && sym.flags & ts.SymbolFlags.Alias) {
    try { sym = checker.getAliasedSymbol(sym); } catch { /* unresolved alias */ }
  }
  return sym;
}

function splitPath(path: string): string[] {
  return path.split(/[.#]/);
}

/** Collects the property names of a chain like a.b?.c, outermost last, with their name nodes. */
function chainNames(node: ts.PropertyAccessExpression): ts.MemberName[] {
  const names: ts.MemberName[] = [];
  let cur: ts.Expression = node;
  while (ts.isPropertyAccessExpression(cur)) {
    names.unshift(cur.name);
    cur = cur.expression;
  }
  return names;
}

function objectArgsEdit(sf: ts.SourceFile, call: ts.CallExpression, names: string[]): Edit | string {
  const args = call.arguments;
  if (!args.length) return { start: args.pos, end: args.end, text: "" };
  if (args.some(ts.isSpreadElement)) return "the call spreads its arguments, so they can't be matched to names";
  if (args.length > names.length) return "the call passes more arguments than the new options object has fields";
  const fields: string[] = [];
  args.forEach((a, i) => {
    const text = a.getText(sf);
    if (text === "undefined") return;
    fields.push(text === names[i] ? names[i] : `${names[i]}: ${text}`);
  });
  return { start: args[0].getStart(sf), end: args[args.length - 1].end, text: fields.length ? `{ ${fields.join(", ")} }` : "" };
}

export function findUsages(program: ts.Program, project: Project, pkgName: string, prev: Surface, next: Surface, index: RuleIndex): Usage[] {
  const checker = program.getTypeChecker();
  const usages: Usage[] = [];
  let id = 0;

  const pathOf = (sym: ts.Symbol | undefined): string | undefined => {
    for (const d of sym?.declarations ?? []) {
      const key = declKeyOf(d, pkgName);
      const path = key && prev.byDecl.get(key);
      if (path) return path;
    }
    return undefined;
  };

  for (const sf of program.getSourceFiles()) {
    if (!isProjectFile(project, sf.fileName)) continue;
    const file = slash(sf.fileName);
    const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line;
    const handled = new Set<ts.Node>();

    const add = (node: ts.Node, path: string, rule: Rule, edits: Edit[], summary: string, problem?: string) => {
      const start = node.getStart(sf);
      usages.push({ id: id++, file, start, end: node.end, line: lineOf(start), path, rule, edits, summary, problem });
    };

    const visit = (node: ts.Node) => {
      // a.b.c member access (outermost first, so the most specific rule wins)
      if (ts.isPropertyAccessExpression(node) && !handled.has(node)) {
        const path = pathOf(resolveSymbol(checker, node.name));
        const found = path ? ruleForPath(index, path, next) : undefined;
        if (path && found) {
          let inner: ts.Expression = node.expression;
          while (ts.isPropertyAccessExpression(inner)) { handled.add(inner); inner = inner.expression; }
          const { rule, to } = found;
          if (rule.kind === "rename" && to) {
            const from = splitPath(path);
            const dest = splitPath(to);
            let k = 0;
            while (k < from.length && k < dest.length && from[k] === dest[k]) k++;
            const oldTail = from.slice(k);
            const newTail = dest.slice(k);
            const names = chainNames(node);
            const tailNodes = names.slice(names.length - oldTail.length);
            const ok = oldTail.length > 0 && tailNodes.length === oldTail.length && tailNodes.every((n, i) => n.text === oldTail[i]);
            const summary = `${path} → ${to}`;
            if (!ok) {
              add(node, path, rule, [], summary, "the code reaches this member through a variable, so the path can't be rewritten safely");
            } else {
              const edits: Edit[] = [];
              if (newTail.length === oldTail.length) {
                tailNodes.forEach((n, i) => { if (n.text !== newTail[i]) edits.push({ start: n.getStart(sf), end: n.end, text: newTail[i] }); });
              } else {
                edits.push({ start: tailNodes[0].getStart(sf), end: tailNodes[tailNodes.length - 1].end, text: newTail.join(".") });
              }
              let problem: string | undefined;
              if (rule.objectArgs && ts.isCallExpression(node.parent) && node.parent.expression === node) {
                const e = objectArgsEdit(sf, node.parent, rule.objectArgs);
                if (typeof e === "string") problem = e;
                else if (node.parent.arguments.length && !(node.parent.arguments.length === 1 && ts.isObjectLiteralExpression(node.parent.arguments[0]))) edits.push(e);
              }
              add(node, path, rule, problem ? [] : edits, summary, problem);
            }
          } else if (rule.kind === "removed") {
            add(node, path, rule, [], `${path} was removed`, rule.note);
          }
        }
      }

      // f(a, b) where that overload is gone: f({ a, b })
      if (ts.isCallExpression(node)) {
        const sig = checker.getResolvedSignature(node);
        const decl = sig?.getDeclaration();
        const key = decl && declKeyOf(decl, pkgName);
        const rule = key ? index.bySig.get(key) : undefined;
        if (rule && rule.kind === "toObject") {
          const e = objectArgsEdit(sf, node, rule.names);
          const summary = `${rule.path}(${rule.names.join(", ")}) → ${rule.path}({ ${rule.names.join(", ")} })`;
          if (typeof e === "string") add(node, rule.path, rule, [], summary, e);
          else add(node, rule.path, rule, [e], summary);
        }
      }

      // { abbr: true } option renamed to { abbreviated: true }
      if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && ts.isObjectLiteralExpression(node.parent)) {
        const sym = checker.getSymbolAtLocation(node.name);
        const propName = ts.isShorthandPropertyAssignment(node) ? node.name.text : node.name.getText(sf);
        let path = ts.isShorthandPropertyAssignment(node) ? undefined : pathOf(sym);
        if (!path) {
          // Look the key up on the type the object is passed as (each member of a union / overload).
          const contextual = checker.getContextualType(node.parent);
          const types = contextual ? (contextual.isUnion() ? contextual.types : [contextual]) : [];
          for (const t of types) { path = pathOf(t.getProperty(propName)); if (path) break; }
        }
        const rule = path ? index.byPath.get(path)?.find((r) => r.kind === "renameOption") : undefined;
        if (path && rule && rule.kind === "renameOption") {
          const edit: Edit = ts.isShorthandPropertyAssignment(node)
            ? { start: node.name.getStart(sf), end: node.name.end, text: `${rule.to}: ${node.name.text}` }
            : { start: node.name.getStart(sf), end: node.name.end, text: rule.to };
          add(node, path, rule, [edit], `option ${path.split(".").pop()} → ${rule.to}`);
        }
      }

      // import { oldName } from "pkg"
      if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
        const nameNode = node.propertyName ?? node.name;
        const path = pathOf(resolveSymbol(checker, node.name));
        const rule = path && !path.includes(".") ? index.byPath.get(path)?.[0] : undefined;
        if (path && rule) {
          if (rule.kind === "rename" && !rule.to.includes(".") && !rule.to.includes(":")) {
            const local = node.name.text;
            const text = node.propertyName ? rule.to : `${rule.to} as ${local}`;
            add(node, path, rule, [{ start: (node.propertyName ?? node.name).getStart(sf), end: node.name.end, text: node.propertyName ? `${rule.to} as ${local}` : text }], `import ${path} → ${rule.to}`);
          } else if (rule.kind === "removed") {
            add(node, path, rule, [], `${path} was removed`, rule.note);
          }
          void nameNode;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return usages;
}

// Builds the "API surface" of a package from its type definitions: every public path a user can
// reach (faker.person.firstName, Faker#helpers.arrayElement, uuid:v4 ...), with signatures and the
// text of any @deprecated note. Two surfaces (old and new version) are later compared.
import ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export type Kind = "function" | "method" | "property" | "class" | "variable" | "type" | "namespace" | "option" | "other";

export interface ParamInfo {
  name: string;
  optional: boolean;
  rest: boolean;
  type: string;
}

export interface SigInfo {
  text: string;
  params: ParamInfo[];
  deprecated?: string;
  declKey?: string;
}

export interface ApiEntry {
  path: string;
  kind: Kind;
  deprecated?: string;
  signatures: SigInfo[];
  declKeys: string[];
  typeText?: string;
}

export interface Surface {
  name: string;
  version: string;
  dir: string;
  entries: Map<string, ApiEntry>;
  byDecl: Map<string, string>; // declKey -> path
}

const MAX_DEPTH = 6;
const MAX_ENTRIES = 60000;

/** Finds the type entry files of a package, keyed by module specifier ("faker", "uuid/v4"). */
export function typeEntries(pkgDir: string, name: string): Map<string, string[]> {
  const pj = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const out = new Map<string, string[]>();
  const add = (spec: string, file: string) => {
    const abs = resolve(pkgDir, file);
    if (!existsSync(abs) || !/\.d\.[cm]?ts$/.test(abs)) return;
    const list = out.get(spec) ?? [];
    if (!list.includes(abs)) list.push(abs);
    out.set(spec, list);
  };
  const collect = (node: unknown, spec: string) => {
    if (typeof node === "string") { if (/\.d\.[cm]?ts$/.test(node)) add(spec, node); return; }
    if (Array.isArray(node)) { node.forEach((n) => collect(n, spec)); return; }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === "types" && typeof v === "string") add(spec, v);
        else collect(v, spec);
      }
    }
  };
  const exp = pj.exports;
  if (exp && typeof exp === "object" && !Array.isArray(exp) && Object.keys(exp).some((k) => k.startsWith("."))) {
    for (const [key, val] of Object.entries(exp)) {
      if (key.includes("*") || key === "./package.json") continue;
      collect(val, key === "." ? name : name + "/" + key.replace(/^\.\//, ""));
    }
  } else if (exp) collect(exp, name);
  for (const f of [pj.types, pj.typings]) if (typeof f === "string") add(name, f);
  if (!out.has(name)) {
    if (typeof pj.main === "string") add(name, pj.main.replace(/\.(c|m)?js$/, ".d.$1ts"));
    add(name, "index.d.ts");
  }
  return out;
}

export function packageRelative(fileName: string, pkgName: string, pkgDir?: string): string | undefined {
  const norm = fileName.replace(/\\/g, "/");
  if (pkgDir) {
    const rel = relative(pkgDir, fileName).replace(/\\/g, "/");
    if (!rel.startsWith("..")) return rel;
  }
  const marker = `/node_modules/${pkgName}/`;
  const i = norm.lastIndexOf(marker);
  return i === -1 ? undefined : norm.slice(i + marker.length);
}

export function declKeyOf(decl: ts.Node, pkgName: string, pkgDir?: string): string | undefined {
  const rel = packageRelative(decl.getSourceFile().fileName, pkgName, pkgDir);
  return rel === undefined ? undefined : `${rel}:${decl.pos}`;
}

export function deprecatedText(decl: ts.Node): string | undefined {
  for (const tag of ts.getJSDocTags(decl)) {
    if (tag.tagName.text === "deprecated") {
      const text = ts.getTextOfJSDocComment(tag.comment) ?? "";
      return text.trim() || "Deprecated.";
    }
  }
  return undefined;
}

function isLibFile(sf: ts.SourceFile, program: ts.Program): boolean {
  return program.isSourceFileDefaultLibrary(sf) || /[\\/]typescript[\\/]lib[\\/]/.test(sf.fileName) || /[\\/]@types[\\/]node[\\/]/.test(sf.fileName);
}

function kindOf(sym: ts.Symbol): Kind {
  const f = sym.flags;
  if (f & ts.SymbolFlags.Class) return "class";
  if (f & ts.SymbolFlags.Function) return "function";
  if (f & ts.SymbolFlags.Method) return "method";
  if (f & (ts.SymbolFlags.Property | ts.SymbolFlags.Accessor)) return "property";
  if (f & ts.SymbolFlags.Variable) return "variable";
  if (f & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Enum)) return "type";
  if (f & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule)) return "namespace";
  return "other";
}

const KIND_ORDER: Record<Kind, number> = { variable: 0, function: 1, namespace: 2, class: 3, method: 4, property: 4, option: 5, type: 6, other: 7 };

export function buildSurface(pkgDir: string, name: string, version: string): Surface {
  const entriesBySpec = typeEntries(pkgDir, name);
  const roots = [...new Set([...entriesBySpec.values()].flat())];
  const surface: Surface = { name, version, dir: pkgDir, entries: new Map(), byDecl: new Map() };
  if (!roots.length) return surface;
  const program = ts.createProgram(roots, {
    noEmit: true, skipLibCheck: true, types: [], target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: false,
  });
  const checker = program.getTypeChecker();
  const seenDecl = new Set<string>();

  const keysOf = (sym: ts.Symbol): string[] =>
    (sym.declarations ?? []).map((d) => declKeyOf(d, name, pkgDir)).filter((k): k is string => !!k);

  const inPackage = (sym: ts.Symbol) =>
    (sym.declarations ?? []).some((d) => !isLibFile(d.getSourceFile(), program) && packageRelative(d.getSourceFile().fileName, name, pkgDir) !== undefined);

  const sigInfo = (sig: ts.Signature): SigInfo => {
    const decl = sig.getDeclaration();
    return {
      text: checker.signatureToString(sig, undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.WriteArrowStyleSignature),
      params: sig.getParameters().map((p) => {
        const pd = p.valueDeclaration as ts.ParameterDeclaration | undefined;
        return {
          name: p.name,
          optional: !!pd && (!!pd.questionToken || !!pd.initializer),
          rest: !!pd?.dotDotDotToken,
          type: checker.typeToString(checker.getTypeOfSymbol(p)),
        };
      }),
      deprecated: decl ? deprecatedText(decl) : undefined,
      declKey: decl ? declKeyOf(decl, name, pkgDir) : undefined,
    };
  };

  const record = (path: string, sym: ts.Symbol, kind: Kind, type: ts.Type | undefined): ApiEntry => {
    const decls = sym.declarations ?? [];
    const deps = decls.map(deprecatedText);
    const sigs = type ? type.getCallSignatures().map(sigInfo) : [];
    const entry: ApiEntry = {
      path, kind,
      deprecated: decls.length && deps.every(Boolean) ? deps[0] : undefined,
      signatures: sigs,
      declKeys: keysOf(sym),
      typeText: type && !sigs.length ? checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation).slice(0, 300) : undefined,
    };
    surface.entries.set(path, entry);
    for (const k of entry.declKeys) if (!surface.byDecl.has(k)) surface.byDecl.set(k, path);
    for (const s of sigs) if (s.declKey && !surface.byDecl.has(s.declKey)) surface.byDecl.set(s.declKey, path);
    return entry;
  };

  const walkOptions = (path: string, type: ts.Type) => {
    for (const sig of type.getCallSignatures()) {
      for (const p of sig.getParameters()) {
        const pt = checker.getNonNullableType(checker.getTypeOfSymbol(p));
        const candidates = pt.isUnion() ? pt.types : [pt];
        for (const t of candidates) {
          if (!(t.flags & ts.TypeFlags.Object) || t.getCallSignatures().length) continue;
          for (const prop of t.getProperties()) {
            if (!inPackage(prop)) continue;
            const keys = keysOf(prop);
            if (keys.length && keys.every((k) => seenDecl.has(k))) continue;
            keys.forEach((k) => seenDecl.add(k));
            record(`${path}(${p.name}).${prop.name}`, prop, "option", undefined);
          }
        }
      }
    }
  };

  const walk = (path: string, sym: ts.Symbol, depth: number, stack: Set<ts.Type>) => {
    if (surface.entries.size >= MAX_ENTRIES) return;
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    const kind = kindOf(sym);
    const type = sym.flags & ts.SymbolFlags.Value && decl ? checker.getTypeOfSymbolAtLocation(sym, decl) : undefined;
    record(path, sym, kind, type);
    if (type && type.getCallSignatures().length) walkOptions(path, type);
    if (!type || depth >= MAX_DEPTH || stack.has(type)) return;
    const next = new Set(stack).add(type);
    const children: Array<[string, ts.Symbol]> = type.getProperties().map((p) => [path + "." + p.name, p]);
    if (kind === "class" && sym.flags & ts.SymbolFlags.Class) {
      for (const p of checker.getDeclaredTypeOfSymbol(sym).getProperties()) children.push([path + "#" + p.name, p]);
    }
    for (const [childPath, child] of children) {
      if (child.name.startsWith("_") || child.name.startsWith("#") || child.name === "prototype") continue;
      if (!inPackage(child)) continue;
      const cdecl = child.valueDeclaration ?? child.declarations?.[0];
      if (cdecl && ts.getCombinedModifierFlags(cdecl as ts.Declaration) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue;
      const keys = keysOf(child);
      if (keys.length && keys.every((k) => seenDecl.has(k))) continue;
      keys.forEach((k) => seenDecl.add(k));
      walk(childPath, child, depth + 1, next);
    }
  };

  const richness = (sym: ts.Symbol): number => {
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    if (!(sym.flags & ts.SymbolFlags.Value) || !decl) return 0;
    const t = checker.getTypeOfSymbolAtLocation(sym, decl);
    let n = t.getCallSignatures().length ? 1 : 0;
    for (const p of t.getProperties()) {
      const pt = checker.getTypeOfSymbol(p);
      if (pt.getCallSignatures().length) n++;
      else for (const q of pt.getProperties().slice(0, 200)) if (checker.getTypeOfSymbol(q).getCallSignatures().length) n++;
    }
    return n;
  };

  for (const [spec, files] of entriesBySpec) {
    const prefix = spec === name ? "" : spec.slice(name.length + 1) + ":";
    const exportsList: Array<[string, ts.Symbol]> = [];
    const seenExport = new Set<string>();
    for (const file of files) {
      const sf = program.getSourceFile(file);
      const modSym = sf && checker.getSymbolAtLocation(sf);
      if (!modSym) continue;
      for (const ex of checker.getExportsOfModule(modSym)) {
        if (seenExport.has(ex.name)) continue;
        seenExport.add(ex.name);
        const target = ex.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(ex) : ex;
        exportsList.push([ex.name, target]);
      }
    }
    // Walk the "richest" export first (most callable members), so shared declarations get their
    // most natural path: faker.person.firstName rather than fakerDE.person.firstName.
    const base = name.split("/").pop()!.toLowerCase();
    const score = new Map(exportsList.map(([n, t]) => [n, richness(t)]));
    exportsList.sort((a, b) =>
      Number(b[0].toLowerCase() === base) - Number(a[0].toLowerCase() === base) ||
      score.get(b[0])! - score.get(a[0])! ||
      KIND_ORDER[kindOf(a[1])] - KIND_ORDER[kindOf(b[1])] || a[0].length - b[0].length || a[0].localeCompare(b[0]));
    for (const [exName, target] of exportsList) {
      const keys = keysOf(target);
      const path = prefix + exName;
      if (keys.length && keys.every((k) => seenDecl.has(k))) {
        // Same declaration exported again under another name: remember the export, don't re-walk.
        surface.entries.set(path, { path, kind: kindOf(target), signatures: [], declKeys: keys, deprecated: (target.declarations ?? []).map(deprecatedText).find(Boolean) });
        continue;
      }
      keys.forEach((k) => seenDecl.add(k));
      walk(path, target, 0, new Set());
    }
  }
  return surface;
}

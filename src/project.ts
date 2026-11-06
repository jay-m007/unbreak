// Loads the user's project and builds TypeScript programs over it, optionally with
//  - the new version of the package "overlaid" on node_modules (no install needed), and
//  - edited file contents held in memory (nothing is written until the user says --apply).
import ts from "typescript";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export interface Project {
  dir: string;
  configPath?: string;
  options: ts.CompilerOptions;
  rootNames: string[];
}

export interface Overlay {
  fromDirs: string[]; // node_modules/<pkg> (and its real path, for pnpm symlinks)
  toDir: string; // extracted new version
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".turbo", ".cache"]);
const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

const slash = (p: string) => p.replace(/\\/g, "/");

function listSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) listSources(p, out);
    else if (SOURCE_EXT.test(name) && !name.endsWith(".d.ts")) out.push(slash(p));
  }
  return out;
}

function parseConfig(configPath: string): { options: ts.CompilerOptions; rootNames: string[] } {
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n")); },
  });
  if (!parsed) throw new Error(`Could not read ${configPath}`);
  let rootNames = parsed.fileNames;
  let options = parsed.options;
  // Solution-style tsconfig ("files": [], "references": [...]): use the referenced projects.
  if (!rootNames.length && parsed.projectReferences?.length) {
    // Use the settings of the referenced project with the most files (usually the app itself).
    let most = -1;
    for (const ref of parsed.projectReferences) {
      const p = ts.resolveProjectReferencePath(ref);
      if (!existsSync(p)) continue;
      const sub = parseConfig(p);
      rootNames = rootNames.concat(sub.rootNames);
      if (sub.rootNames.length > most) { most = sub.rootNames.length; options = sub.options; }
    }
  }
  return { options, rootNames };
}

export function loadProject(dir: string): Project {
  const abs = resolve(dir);
  const configPath = ["tsconfig.json", "jsconfig.json"].map((f) => join(abs, f)).find(existsSync);
  let options: ts.CompilerOptions;
  let rootNames: string[];
  if (configPath) {
    ({ options, rootNames } = parseConfig(configPath));
    if (configPath.endsWith("jsconfig.json")) options = { allowJs: true, checkJs: true, ...options };
  } else {
    options = {
      allowJs: true, checkJs: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve, esModuleInterop: true,
      resolveJsonModule: true, strict: false,
    };
    rootNames = listSources(abs);
  }
  options = { ...options, noEmit: true, skipLibCheck: true, incremental: false, composite: false, declaration: false, emitDeclarationOnly: false, tsBuildInfoFile: undefined };
  return { dir: slash(abs), configPath, options, rootNames: rootNames.map(slash) };
}

export function overlayFor(installedDir: string, newDir: string): Overlay {
  const fromDirs = [slash(resolve(installedDir))];
  try { const real = slash(realpathSync(installedDir)); if (!fromDirs.includes(real)) fromDirs.push(real); } catch { /* ignore */ }
  return { fromDirs, toDir: slash(resolve(newDir)) };
}

export class ProgramFactory {
  private cache = new Map<string, ts.SourceFile>();
  private project: Project;
  constructor(project: Project) { this.project = project; }

  create(overlay: Overlay | undefined, overrides: Map<string, string> | undefined, old?: ts.Program): ts.Program {
    const { options, rootNames } = this.project;
    const base = ts.createCompilerHost(options, true);
    const map = (p: string): string => {
      if (!overlay) return p;
      const s = slash(p);
      for (const from of overlay.fromDirs) {
        if (s === from) return overlay.toDir;
        if (s.startsWith(from + "/")) return overlay.toDir + s.slice(from.length);
      }
      return p;
    };
    const isOverlaid = (p: string) => map(p) !== p;
    const host: ts.CompilerHost = {
      ...base,
      fileExists: (f) => overrides?.has(slash(f)) || base.fileExists(map(f)),
      readFile: (f) => overrides?.get(slash(f)) ?? base.readFile(map(f)),
      directoryExists: (d) => (base.directoryExists ? base.directoryExists(map(d)) : true),
      getDirectories: (d) => (base.getDirectories ? base.getDirectories(map(d)) : []),
      realpath: (p) => (isOverlaid(p) || overrides?.has(slash(p)) ? p : base.realpath ? base.realpath(p) : p),
      getSourceFile: (fileName, lang, onError) => {
        const key = slash(fileName);
        const text = overrides?.get(key);
        if (text !== undefined) return ts.createSourceFile(fileName, text, lang, true);
        const real = map(fileName);
        const cacheKey = (overlay && real !== fileName ? "new:" : "") + slash(real) + "|" + JSON.stringify(lang);
        const hit = this.cache.get(cacheKey);
        if (hit && hit.fileName === fileName) return hit;
        const content = base.readFile(real);
        if (content === undefined) { onError?.(`Cannot read ${fileName}`); return undefined; }
        const sf = ts.createSourceFile(fileName, content, lang, true);
        if (key.includes("/node_modules/") || /[\\/]typescript[\\/]lib[\\/]/.test(fileName)) this.cache.set(cacheKey, sf);
        return sf;
      },
    };
    return ts.createProgram({ rootNames, options, host, oldProgram: old });
  }
}

export function isProjectFile(project: Project, fileName: string): boolean {
  const f = slash(fileName);
  return f.startsWith(project.dir + "/") && !f.includes("/node_modules/") && !/\.d\.[cm]?ts$/.test(f);
}

export interface Diag {
  file: string;
  start: number;
  length: number;
  code: number;
  message: string;
  line: number;
}

export function diagnosticsOf(program: ts.Program, project: Project): Diag[] {
  const out: Diag[] = [];
  for (const sf of program.getSourceFiles()) {
    if (!isProjectFile(project, sf.fileName)) continue;
    for (const d of [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]) {
      if (d.start === undefined) continue;
      out.push({
        file: slash(sf.fileName), start: d.start, length: d.length ?? 0, code: d.code,
        message: ts.flattenDiagnosticMessageText(d.messageText, " "),
        line: sf.getLineAndCharacterOfPosition(d.start).line,
      });
    }
  }
  return out;
}

export const diagKey = (d: Diag) => `${d.file}|${d.start}|${d.code}|${d.message}`;
export const diagKind = (d: Diag) => `${d.code}|${d.message}`;
export { sep };

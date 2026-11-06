# Contributing

## Set up

```
npm install
npm test          # offline: uses the demo-lib fixture, no network
npm run typecheck
```

Node 22.18 or newer runs the TypeScript sources directly (`node src/cli.ts ...`). `npm run build` writes `dist/` for publishing.

## How the code is laid out

| File | Job |
|---|---|
| `src/surface.ts` | Reads a package's `.d.ts` files into a map of public paths, signatures and `@deprecated` notes |
| `src/rules.ts` | Compares two surfaces and produces rules (rename, positional-to-object, option rename, removed) |
| `src/usages.ts` | Finds uses in the project through the type checker and builds text edits |
| `src/project.ts` | Loads the project's tsconfig and builds programs, with the new version overlaid on `node_modules` |
| `src/migrate.ts` | The pipeline: find breaks, apply fixes, re-check, undo what the compiler rejects |
| `src/report.ts`, `src/cli.ts` | Terminal output, Markdown report, command line |
| `recipes/` | Hand-written rules for changes a library did not document |

## Adding a recipe

When a library changes something without a `@deprecated` note, add `recipes/<package>.json`
(scoped names: `@scope/name` becomes `scope__name.json`):

```json
{
  "package": "some-lib",
  "migrations": [
    {
      "breaksAfter": 3,
      "rules": [
        { "kind": "rename", "from": "client.fetchAll", "to": "client.list", "note": "Renamed in 4.0" },
        { "kind": "removed", "path": "client.legacy", "note": "Use client.modern() and pass { compat: true }" }
      ]
    }
  ]
}
```

`breaksAfter: 3` means the old API existed up to 3.x. Paths use the names `unbreak diff <pkg> <from> <to>` prints.
Every rule still goes through the compiler check, so a wrong recipe is undone, not shipped.

## Rules for changes

- A fix must be proven by the compiler or left for a person. Never weaken the check to raise the fix rate.
- Add a test for every new kind of rewrite, in `test/` with the offline fixtures.
- Keep runtime dependencies at one (`typescript`).

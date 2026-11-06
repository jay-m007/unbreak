# Unbreak

CLI that upgrades an npm library and fixes the TypeScript/JavaScript code the upgrade breaks.
Every fix is type-checked against the new version; rejected fixes are undone.

## Commands
- `npm test`: offline test suite (node:test, fixtures in `test/fixtures`)
- `npm run typecheck`: `tsc --noEmit`
- `node src/cli.ts <pkg>@<version> --project <dir>`: dry run (Node 22.18+ runs .ts directly)
- `node bench/run-one.ts <dir> <pkg> <version>`: JSON result for one project

## Code rules
- TypeScript run by Node's type stripping: no enums, namespaces or constructor parameter properties; use `import type` for types; relative imports end in `.ts`.
- Only runtime dependency is `typescript` (5.9.x, the JS compiler API).
- Never keep a fix the compiler rejects. Add a test for every new rewrite kind.
- Tests must not need the network: fixtures live in `test/fixtures/cache`, and `UNBREAK_OFFLINE=1` is set in `test/helpers.ts`.

## Git
- Commits are authored as Jay Maurya <maurya67jay@gmail.com>. Do not add co-author or "generated with" lines to commits or pull requests.

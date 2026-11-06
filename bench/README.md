# Benchmark: @faker-js/faker 8 → 9 on real projects

`faker-8-repos.txt` lists 46 public GitHub projects that pin `@faker-js/faker` 8.x. They were found with
GitHub code search for calls that faker 9 removed (`faker.datatype.number`, `faker.internet.avatar`, ...).

`run-all.sh` clones each one (shallow), puts the faker 8.x its `package.json` asks for into `node_modules`
(nothing else is installed and no install scripts run), and runs Unbreak against faker 9 in dry-run mode.
`results/faker-8-to-9.json` holds the numbers from the last run.

Because only faker is installed, other libraries are untyped during this run. That can hide breaks, never add
them. A separate check with full installs is described in the main README.

#!/bin/bash
# Re-runs the faker 8 -> 9 benchmark. Needs git, node >= 22.18 and network access.
# Clones every repo in faker-8-repos.txt (shallow), puts the faker 8.x its package.json asks for
# into node_modules (nothing else is installed, no install scripts run), and runs Unbreak in dry-run mode.
set -u
here=$(cd "$(dirname "$0")" && pwd); work=${WORK:-/tmp/unbreak-bench}; mkdir -p "$work/repos"
: > "$work/results.jsonl"
while read -r r; do
  d="$work/repos/${r//\//__}"
  [ -d "$d" ] || git clone -q --depth 1 "https://github.com/$r" "$d" || continue
  spec=$(node -p "const p=require('$d/package.json');({...p.devDependencies,...p.dependencies})['@faker-js/faker']")
  ver=$(npm view "@faker-js/faker@$spec" version --json | node -p "const v=JSON.parse(require('fs').readFileSync(0,'utf8'));Array.isArray(v)?v.at(-1):v")
  dir=$(node -e "import('$here/../src/npm.ts').then(m=>console.log(m.fetchPackage('@faker-js/faker','$ver').dir))")
  mkdir -p "$d/node_modules/@faker-js" && rm -rf "$d/node_modules/@faker-js/faker" && cp -r "$dir" "$d/node_modules/@faker-js/faker"
  node "$here/run-one.ts" "$d" @faker-js/faker 9 >> "$work/results.jsonl"
done < "$here/faker-8-repos.txt"
echo "Results: $work/results.jsonl"

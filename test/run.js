#!/usr/bin/env node
// Runs every suite against real throwaway git repositories. No test framework:
// the suites need real repos and a stubbed editor, which plain Node does fine.
//
//   npm test                  # everything
//   npm test -- parent        # only suites whose name matches
const path = require('path');
const { results } = require('./support/harness');

const SUITES = [
  ['git-service', './git-service.test.js'],
  ['parent-branch', './parent-branch.test.js'],
  ['notifications', './notifications.test.js']
];

async function main() {
  const filter = process.argv[2];
  const selected = SUITES.filter(([name]) => !filter || name.includes(filter));

  if (selected.length === 0) {
    console.error(`No suite matches "${filter}". Available: ${SUITES.map(([n]) => n).join(', ')}`);
    process.exit(1);
  }

  const started = Date.now();
  for (const [name, file] of selected) {
    console.log(`\n\u001b[1m── ${name} ──\u001b[0m`);
    const before = results.fail;
    try {
      await require(file)();
    } catch (error) {
      results.fail++;
      console.error(`  ✗ suite crashed: ${error && error.stack ? error.stack : error}`);
    }
    if (results.fail > before) {
      console.log(`  (${results.fail - before} failure(s) in ${name})`);
    }
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `\n${results.fail === 0 ? '\u001b[32mALL PASS\u001b[0m' : '\u001b[31mFAILURES\u001b[0m'}: ` +
      `${results.pass} passed, ${results.fail} failed in ${seconds}s`
  );
  process.exit(results.fail === 0 ? 0 : 1);
}

void path;
main();

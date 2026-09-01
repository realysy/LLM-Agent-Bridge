import assert from 'node:assert/strict';
import { cp, lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { inspectInstallation } from '../skills/universal-agent-bridge/scripts/doctor.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceSkill = join(repoRoot, 'skills', 'universal-agent-bridge');

test('uses Node test runner cleanly', async () => {
  const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.test, 'node tests/run-all.mjs');
});

test('keeps text artifacts on canonical LF line endings across platforms', async () => {
  const attributes = await readFile(join(repoRoot, '.gitattributes'), 'utf8');
  assert.match(attributes, /^\* text=auto eol=lf$/m);
  assert.match(attributes, /^\*\.png binary$/m);
});

test('a copied skill package passes Doctor without relying on a symlink', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'agent-bridge-chatgpt-'));
  const copiedSkill = join(temporaryRoot, basename(sourceSkill));

  try {
    await cp(sourceSkill, copiedSkill, { recursive: true });
    assert.equal((await lstat(copiedSkill)).isSymbolicLink(), false);

    const result = await inspectInstallation(copiedSkill);
    assert.equal(result.status, 'READY');
    assert.equal(result.skill_name, 'universal-agent-bridge');

    const sourceSkillText = await readFile(join(copiedSkill, 'SKILL.md'), 'utf8');
    assert.doesNotMatch(sourceSkillText, /\/Users\/example/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

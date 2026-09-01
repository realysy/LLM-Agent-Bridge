import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { inspectInstallation } from '../skills/universal-agent-bridge/scripts/doctor.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceSkill = join(repoRoot, 'skills', 'universal-agent-bridge');

test('Doctor reports READY for a complete installation', async () => {
  const result = await inspectInstallation(sourceSkill);
  assert.equal(result.status, 'READY');
  assert.equal(result.skill_name, 'universal-agent-bridge');
});

test('Doctor reports INVALID_INSTALLATION when a required contract is missing', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'agent-bridge-doctor-'));
  const copiedSkill = join(temporaryRoot, 'universal-agent-bridge');

  try {
    await cp(sourceSkill, copiedSkill, { recursive: true });
    await rm(join(copiedSkill, 'references', 'context-packet.md'));

    const result = await inspectInstallation(copiedSkill);
    assert.equal(result.status, 'INVALID_INSTALLATION');
    assert.ok(result.checks.some((check) => check.id === 'context_packet' && !check.ok));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

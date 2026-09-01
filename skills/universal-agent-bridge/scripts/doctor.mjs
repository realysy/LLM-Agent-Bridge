#!/usr/bin/env node

/**
 * Doctor health checker for agent-bridge-chatgpt
 */

import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentFile = fileURLToPath(import.meta.url);
const defaultSkillRoot = dirname(dirname(currentFile));
const minimumNodeMajor = 18;

const requiredFiles = [
  ['skill', 'SKILL.md'],
  ['interface', 'agents/openai.yaml'],
  ['validator', 'scripts/validate-handoff.mjs'],
  ['ws_transport', 'scripts/ws-transport.mjs'],
  ['browser_transport', 'references/browser-transport.md'],
  ['context_packet', 'references/context-packet.md'],
  ['reasoning_request', 'references/reasoning-request.md'],
  ['run_receipt', 'references/run-receipt.md'],
  ['doctor_guide', 'references/doctor.md'],
];

async function fileCheck(skillRoot, id, relativePath) {
  try {
    await access(join(skillRoot, relativePath));
    return { id, path: relativePath, ok: true };
  } catch {
    return { id, path: relativePath, ok: false };
  }
}

export async function inspectInstallation(skillRoot = defaultSkillRoot) {
  const normalizedRoot = resolve(skillRoot);
  const checks = await Promise.all(
    requiredFiles.map(([id, relativePath]) => fileCheck(normalizedRoot, id, relativePath)),
  );

  let skillName = null;
  if (checks.find((check) => check.id === 'skill')?.ok) {
    const skill = await readFile(join(normalizedRoot, 'SKILL.md'), 'utf8');
    skillName = skill.match(/^name:\s*([a-z0-9-]+)$/m)?.[1] ?? null;
  }

  checks.push({
    id: 'skill_name',
    path: 'SKILL.md#name',
    ok: skillName === 'universal-agent-bridge',
  });

  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  const runtimeReady = Number.isInteger(nodeMajor) && nodeMajor >= minimumNodeMajor;
  checks.push({
    id: 'node_runtime',
    path: `node>=${minimumNodeMajor}`,
    ok: runtimeReady,
  });

  // Check if WebSocket bridge is running
  let bridgeStatus = 'NOT_RUNNING';
  let connectedClients = 0;
  try {
    const res = await fetch('http://127.0.0.1:8765/status', { signal: AbortSignal.timeout(800) });
    if (res.ok) {
      const data = await res.json();
      bridgeStatus = data.status;
      connectedClients = data.connected_clients || 0;
    }
  } catch {
    bridgeStatus = 'NOT_RUNNING';
  }

  checks.push({
    id: 'bridge_status',
    path: 'http://127.0.0.1:8765/status',
    ok: true,
    detail: { bridgeStatus, connectedClients },
  });

  const status = !runtimeReady
    ? 'MISSING_RUNTIME'
    : checks.every((check) => check.ok)
      ? 'READY'
      : 'INVALID_INSTALLATION';

  return {
    schema_version: 1,
    status,
    skill_name: skillName,
    platform: process.platform,
    node: process.versions.node,
    minimum_node_major: minimumNodeMajor,
    bridge: {
      status: bridgeStatus,
      connected_clients: connectedClients,
    },
    checks,
  };
}

function parseArgs(argv) {
  const options = { json: false, skillRoot: defaultSkillRoot };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (argument === '--skill-root' && argv[index + 1]) {
      options.skillRoot = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`unknown or incomplete argument: ${argument}`);
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`usage: doctor.mjs [--json] [--skill-root <path>]\n${error.message}`);
    process.exitCode = 2;
    return;
  }

  try {
    const report = await inspectInstallation(options.skillRoot);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`[Doctor] Status: ${report.status}`);
      console.log(`[Doctor] Skill: ${report.skill_name}`);
      console.log(`[Doctor] Node: ${report.node} (min: ${report.minimum_node_major})`);
      console.log(`[Doctor] Bridge: ${report.bridge.status} (${report.bridge.connected_clients} browser tab connected)`);
      for (const check of report.checks) {
        console.log(`  - ${check.id}: ${check.ok ? 'OK' : 'FAIL'} (${check.path})`);
      }
    }
    if (report.status !== 'READY') {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`doctor check failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith('doctor.mjs')) {
  main();
}

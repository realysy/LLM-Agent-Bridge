#!/usr/bin/env node

/**
 * Portable Verifier for agent-bridge-chatgpt
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectInstallation } from '../skills/universal-agent-bridge/scripts/doctor.mjs';
import {
  validatePacket,
  validateResult,
  validatePair,
  validateReceipt,
  receiptCompletionErrors,
  verifyReceiptArtifacts,
} from '../skills/universal-agent-bridge/scripts/validate-handoff.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const skillRoot = join(repoRoot, 'skills', 'universal-agent-bridge');

async function architectureCheck(id, filename) {
  const path = join(repoRoot, 'assets', filename);
  try {
    const image = await readFile(path);
    const signature = image.subarray(0, 8).toString('hex');
    const width = image.readUInt32BE(16);
    const height = image.readUInt32BE(20);
    const ok = signature === '89504e470d0a1a0a' && width >= 1200 && height >= 700;
    return {
      id,
      status: ok ? 'passed' : 'failed',
      exit_code: ok ? 0 : 1,
      detail: ok ? `PNG ${width}x${height}` : 'architecture PNG is missing or too small',
    };
  } catch (error) {
    return {
      id,
      status: 'failed',
      exit_code: 1,
      detail: error.message,
    };
  }
}

async function readmeCheck(id, filename, requiredFragments) {
  try {
    const content = await readFile(join(repoRoot, filename), 'utf8');
    const missing = requiredFragments.filter((fragment) => !content.includes(fragment));
    return {
      id,
      status: missing.length === 0 ? 'passed' : 'failed',
      exit_code: missing.length === 0 ? 0 : 1,
      detail: missing.length === 0 ? `${filename} bilingual contract present` : `missing: ${missing.join(', ')}`,
    };
  } catch (error) {
    return {
      id,
      status: 'failed',
      exit_code: 1,
      detail: error.message,
    };
  }
}

async function runAllChecks() {
  // 1. Doctor check
  const doctorReport = await inspectInstallation(skillRoot);
  const doctorPass = doctorReport.status === 'READY';
  const doctorCheck = {
    id: 'doctor',
    status: doctorPass ? 'passed' : 'failed',
    exit_code: doctorPass ? 0 : 1,
    detail: `doctor status: ${doctorReport.status}`,
  };

  // 2. Packet validation
  const packetText = await readFile(join(repoRoot, 'tests/artifacts/e2e-packet-1k.md'), 'utf8');
  const packetErrors = validatePacket(packetText);
  const packetCheck = {
    id: 'packet',
    status: packetErrors.length === 0 ? 'passed' : 'failed',
    exit_code: packetErrors.length === 0 ? 0 : 1,
    detail: packetErrors.length === 0 ? 'packet is valid' : packetErrors.join('; '),
  };

  // 3. Result validation
  const resultText = await readFile(join(repoRoot, 'tests/artifacts/e2e-result-1k-sol.md'), 'utf8');
  const resultErrors = validateResult(resultText);
  const resultCheck = {
    id: 'result',
    status: resultErrors.length === 0 ? 'passed' : 'failed',
    exit_code: resultErrors.length === 0 ? 0 : 1,
    detail: resultErrors.length === 0 ? 'result is valid' : resultErrors.join('; '),
  };

  // 4. Pair validation
  const pairErrors = validatePair(packetText, resultText);
  const pairCheck = {
    id: 'pair',
    status: pairErrors.length === 0 ? 'passed' : 'failed',
    exit_code: pairErrors.length === 0 ? 0 : 1,
    detail: pairErrors.length === 0 ? 'packet-result pair matches' : pairErrors.join('; '),
  };

  // 5. Receipt validation
  const receiptJson = JSON.parse(await readFile(join(repoRoot, 'tests/artifacts/e2e-receipt-1k-sol.json'), 'utf8'));
  const receiptErrors = validateReceipt(receiptJson);
  const receiptCheck = {
    id: 'receipt',
    status: receiptErrors.length === 0 ? 'passed' : 'failed',
    exit_code: receiptErrors.length === 0 ? 0 : 1,
    detail: receiptErrors.length === 0 ? 'receipt schema valid' : receiptErrors.join('; '),
  };

  // 6. Complete verification
  const completeErrors = [
    ...receiptCompletionErrors(receiptJson),
    ...(await verifyReceiptArtifacts(receiptJson, repoRoot)),
  ];
  const completeCheck = {
    id: 'complete',
    status: completeErrors.length === 0 ? 'passed' : 'failed',
    exit_code: completeErrors.length === 0 ? 0 : 1,
    detail: completeErrors.length === 0 ? 'complete receipt with verified sha256' : completeErrors.join('; '),
  };

  const checks = [
    doctorCheck,
    packetCheck,
    resultCheck,
    pairCheck,
    receiptCheck,
    completeCheck,
    await architectureCheck('architecture_asset_en', 'codex-bridge-chatgpt-architecture.en.png'),
    await architectureCheck('architecture_asset_zh', 'codex-bridge-chatgpt-architecture.png'),
    await readmeCheck('readme_en', 'README.md', [
      '[简体中文](README.zh-CN.md)',
      '## Workflow',
      '## How it works',
      '## Installation',
      '## Quick start',
      'assets/codex-bridge-chatgpt-architecture.en.png',
    ]),
    await readmeCheck('readme_zh', 'README.zh-CN.md', [
      '[English](README.md)',
      '## 工作流',
      '## 工作原理',
      '## 安装',
      '## 快速上手',
      'assets/codex-bridge-chatgpt-architecture.png',
    ]),
    await readmeCheck('openai_api_doc', 'skills/universal-agent-bridge/references/openai-api.md', [
      'POST `/stream`',
      'request_id',
      '累积文本',
    ]),
  ];

  const receipt = {
    schema_version: 1,
    status: checks.every((check) => check.status === 'passed') ? 'passed' : 'failed',
    checks,
  };

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(receipt, null, 2));
  } else {
    for (const check of checks) {
      console.log(`${check.status === 'passed' ? 'PASS' : 'FAIL'} ${check.id}: ${check.detail}`);
    }
    console.log(`Verification: ${receipt.status}`);
  }

  process.exitCode = receipt.status === 'passed' ? 0 : 1;
}

runAllChecks();

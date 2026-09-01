import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeServer } from '../skills/universal-agent-bridge/scripts/ws-transport.mjs';

test('BridgeServer starts, reports HTTP status and shuts down cleanly', async () => {
  const testPort = 8799;
  const server = new BridgeServer(testPort);

  await server.start();

  try {
    const res = await fetch(`http://127.0.0.1:${testPort}/status`);
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.equal(data.status, 'NEEDS_BROWSER_CONNECTION');
    assert.equal(data.connected_clients, 0);
  } finally {
    await server.stop();
  }
});

test('BridgeServer throws NEEDS_BROWSER_CONNECTION when executing with no connected clients', async () => {
  const testPort = 8798;
  const server = new BridgeServer(testPort);

  await server.start();

  try {
    await assert.rejects(
      async () => {
        await server.executeHandoff('dummy packet content', { timeout: 1 });
      },
      /NEEDS_BROWSER_CONNECTION/,
    );
  } finally {
    await server.stop();
  }
});

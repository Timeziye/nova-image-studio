const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

async function availablePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startServer(port, directory) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOSTNAME: '127.0.0.1',
      PORT: String(port),
      NOVA_TASK_DB: path.join(directory, 'tasks.sqlite'),
      NOVA_IMAGE_DIR: path.join(directory, 'images'),
      NOVA_ADMIN_PASSWORD_FILE: path.join(directory, 'admin-password'),
    },
    stdio: 'ignore',
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`测试服务器过早退出: ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/nova/queue-status`);
      if (response.ok) return { child, baseUrl };
    } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error('测试服务器未在 8 秒内就绪');
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  await new Promise(resolve => {
    child.once('exit', resolve);
    child.kill();
  });
}

test('admin-only per-key setting is validated and survives a server restart', { timeout: 30_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-concurrency-'));
  const passwordPath = path.join(directory, 'admin-password');
  fs.writeFileSync(passwordPath, 'test-admin-password\n', { mode: 0o600 });
  const port = await availablePort();
  let server;
  try {
    server = await startServer(port, directory);
    const initial = await (await fetch(`${server.baseUrl}/api/nova/queue-status`)).json();
    assert.equal(initial.concurrencyLimit, 50);
    assert.equal(initial.perKeyConcurrencyLimit, 10);
    assert.equal(initial.configuredPerKeyConcurrency, 10);

    const save = (value, password) => fetch(`${server.baseUrl}/api/nova/admin/per-key-concurrency`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(password ? { Authorization: `Bearer ${password}` } : {}),
      },
      body: JSON.stringify({ value }),
    });
    assert.equal((await save(3)).status, 401);
    assert.equal((await save(3, 'wrong-password')).status, 401);
    assert.equal((await save(0, 'test-admin-password')).status, 400);
    assert.equal((await save(11, 'test-admin-password')).status, 400);
    fs.renameSync(passwordPath, `${passwordPath}.hidden`);
    assert.equal((await save(3, 'test-admin-password')).status, 503);
    fs.renameSync(`${passwordPath}.hidden`, passwordPath);

    const updated = await save(3, 'test-admin-password');
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).configuredPerKeyConcurrency, 3);
    await stopServer(server.child);
    server = await startServer(port, directory);
    const afterRestart = await (await fetch(`${server.baseUrl}/api/nova/queue-status`)).json();
    assert.equal(afterRestart.configuredPerKeyConcurrency, 3);
  } finally {
    if (server) await stopServer(server.child);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

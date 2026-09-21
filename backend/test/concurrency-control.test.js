const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateConcurrency,
  normalizeConcurrency,
  taskSlots,
  selectRunnableTask,
  runItemsWithConcurrency,
  verifyAdminPassword,
} = require('../concurrency-control');

test('the shared per-key policy accepts only integers from 1 through 10', () => {
  assert.equal(validateConcurrency(1, 10), 1);
  assert.equal(validateConcurrency(10, 10), 10);
  for (const value of [0, 11, 1.5, '10', null, Number.NaN]) {
    assert.throws(() => validateConcurrency(value, 10), /并发数必须是 1 到 10 的整数/);
  }
  assert.equal(normalizeConcurrency('7', 10, 10), 7);
  assert.equal(normalizeConcurrency('invalid', 10, 10), 10);
});

test('a multi-image task reserves no more slots than the per-key limit', () => {
  assert.equal(taskSlots(4, 1), 1);
  assert.equal(taskSlots(4, 2), 2);
  assert.equal(taskSlots(4, 10), 4);
});

test('a saturated key does not block a different key in the shared queue', () => {
  const queue = [
    { id: 'a-next', key: 'key-a', parallelCount: 1 },
    { id: 'b-next', key: 'key-b', parallelCount: 2 },
  ];
  assert.deepEqual(selectRunnableTask(queue, new Map([['key-a', 10]]), 10, 50, 10), {
    index: 1,
    key: 'key-b',
    slots: 2,
  });
  assert.deepEqual(selectRunnableTask([queue[0]], new Map(), 1, 50, 10), {
    index: 0,
    key: 'key-a',
    slots: 1,
  });
  assert.deepEqual(selectRunnableTask([{ id: 'a-multi', key: 'key-a', parallelCount: 4 }], new Map([['key-a', 3]]), 5, 50, 3), {
    index: 0,
    key: 'key-a',
    slots: 2,
  });
});

test('multi-image work obeys the reserved slot count and preserves result order', async () => {
  const releases = [];
  let active = 0;
  let peak = 0;
  const running = runItemsWithConcurrency(4, 2, async (index) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => releases.push(resolve));
    active -= 1;
    return index;
  });

  await Promise.resolve();
  assert.equal(peak, 2);
  assert.equal(releases.length, 2);
  releases.splice(0).forEach(resolve => resolve());
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(releases.length, 2);
  releases.splice(0).forEach(resolve => resolve());

  assert.deepEqual(await running, [
    { status: 'fulfilled', value: 0 },
    { status: 'fulfilled', value: 1 },
    { status: 'fulfilled', value: 2 },
    { status: 'fulfilled', value: 3 },
  ]);
  assert.equal(peak, 2);
});

test('admin password comparison rejects missing or incorrect credentials', () => {
  assert.equal(verifyAdminPassword('correct', 'correct'), true);
  assert.equal(verifyAdminPassword('wrong', 'correct'), false);
  assert.equal(verifyAdminPassword('', 'correct'), false);
  assert.equal(verifyAdminPassword('correct', ''), false);
});

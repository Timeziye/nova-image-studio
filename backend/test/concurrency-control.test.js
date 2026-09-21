const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateConcurrency,
  normalizeConcurrency,
  clampServerConcurrency,
  taskSlots,
  selectRunnableTasks,
  verifyAdminPassword,
} = require('../concurrency-control');

test('the shared per-key policy accepts only integers from 4 through 10', () => {
  assert.equal(validateConcurrency(4, 4, 10), 4);
  assert.equal(validateConcurrency(10, 4, 10), 10);
  for (const value of [0, 1, 3, 11, 4.5, '4', null, Number.NaN]) {
    assert.throws(() => validateConcurrency(value, 4, 10), /并发数必须是 4 到 10 的整数/);
  }
  assert.equal(normalizeConcurrency('7', 4, 10, 10), 7);
  assert.equal(normalizeConcurrency('invalid', 4, 10, 10), 10);
  assert.equal(clampServerConcurrency('3', 4, 50, 50), 4);
  assert.equal(clampServerConcurrency('50', 4, 50, 50), 50);
  assert.equal(clampServerConcurrency('invalid', 4, 50, 50), 50);
});

test('a four-image task waits until four slots are available', () => {
  assert.equal(taskSlots(4, 3), 0);
  assert.equal(taskSlots(4, 4), 4);
  assert.equal(taskSlots(4, 10), 4);
});

test('a saturated key does not block a different key in the shared queue', () => {
  const queue = [
    { id: 'a-next', key: 'key-a', parallelCount: 1 },
    { id: 'b-next', key: 'key-b', parallelCount: 2 },
  ];
  assert.deepEqual(selectRunnableTasks(queue, new Map([['key-a', 10]]), 10, 50, 10), [
    { id: 'b-next', key: 'key-b', slots: 2 },
  ]);
  assert.deepEqual(selectRunnableTasks([queue[0]], new Map(), 4, 50, 10), [
    { id: 'a-next', key: 'key-a', slots: 1 },
  ]);
  assert.deepEqual(selectRunnableTasks([
    { id: 'a-four', key: 'key-a', parallelCount: 4 },
    { id: 'a-one', key: 'key-a', parallelCount: 1 },
    { id: 'b-one', key: 'key-b', parallelCount: 1 },
  ], new Map([['key-a', 3]]), 4, 50, 3), [
    { id: 'b-one', key: 'key-b', slots: 1 },
  ]);
});

test('admin password comparison rejects missing or incorrect credentials', () => {
  assert.equal(verifyAdminPassword('correct', 'correct'), true);
  assert.equal(verifyAdminPassword('wrong', 'correct'), false);
  assert.equal(verifyAdminPassword('', 'correct'), false);
  assert.equal(verifyAdminPassword('correct', ''), false);
});

const { createHash, timingSafeEqual } = require('node:crypto');

function validateConcurrency(value, maximum) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`并发数必须是 1 到 ${maximum} 的整数`);
  }
  return value;
}

function normalizeConcurrency(value, maximum, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : fallback;
}

function taskSlots(parallelCount, availableSlots) {
  const count = Number.isInteger(parallelCount) && parallelCount > 0 ? parallelCount : 1;
  return Math.min(count, availableSlots);
}

function selectRunnableTask(queue, activeByKey, perKeyLimit, globalLimit, activeTotal) {
  const globalAvailable = globalLimit - activeTotal;
  if (globalAvailable <= 0) return null;
  for (let index = 0; index < queue.length; index += 1) {
    const task = queue[index];
    const keyAvailable = perKeyLimit - (activeByKey.get(task.key) || 0);
    if (keyAvailable <= 0) continue;
    return {
      index,
      key: task.key,
      slots: taskSlots(task.parallelCount, Math.min(keyAvailable, globalAvailable)),
    };
  }
  return null;
}

async function runItemsWithConcurrency(count, concurrency, runItem) {
  const results = new Array(count);
  let nextIndex = 0;
  const workerCount = Math.min(count, concurrency);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < count) {
      const index = nextIndex++;
      try {
        results[index] = { status: 'fulfilled', value: await runItem(index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }));
  return results;
}

function verifyAdminPassword(provided, expected) {
  if (!provided || !expected) return false;
  const expectedHash = createHash('sha256').update(expected).digest();
  const providedHash = createHash('sha256').update(provided).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

module.exports = {
  validateConcurrency,
  normalizeConcurrency,
  taskSlots,
  selectRunnableTask,
  runItemsWithConcurrency,
  verifyAdminPassword,
};

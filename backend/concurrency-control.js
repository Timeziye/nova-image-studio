const { createHash, timingSafeEqual } = require('node:crypto');

function validateConcurrency(value, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`并发数必须是 ${minimum} 到 ${maximum} 的整数`);
  }
  return value;
}

function normalizeConcurrency(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function clampServerConcurrency(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.floor(parsed))) : fallback;
}

function taskSlots(parallelCount, availableSlots) {
  const count = Number.isInteger(parallelCount) && parallelCount > 0 ? parallelCount : 1;
  return count <= availableSlots ? count : 0;
}

function selectRunnableTasks(queue, activeByKey, perKeyLimit, globalLimit, activeTotal) {
  const selected = [];
  const plannedByKey = new Map(activeByKey);
  const blockedKeys = new Set();
  let plannedTotal = activeTotal;
  for (const task of queue) {
    if (blockedKeys.has(task.key)) continue;
    const keyAvailable = perKeyLimit - (plannedByKey.get(task.key) || 0);
    const globalAvailable = globalLimit - plannedTotal;
    const slots = taskSlots(task.parallelCount, Math.min(keyAvailable, globalAvailable));
    if (slots > 0) {
      selected.push({ id: task.id, key: task.key, slots });
      plannedByKey.set(task.key, (plannedByKey.get(task.key) || 0) + slots);
      plannedTotal += slots;
    } else {
      blockedKeys.add(task.key);
    }
  }
  return selected;
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
  clampServerConcurrency,
  taskSlots,
  selectRunnableTasks,
  verifyAdminPassword,
};

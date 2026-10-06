'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter, mapWithConcurrency } = require('../services/concurrency');

test('并发限制器不会超过指定并发数', async () => {
  const limit = createLimiter(2);
  let active = 0;
  let maxActive = 0;
  const tasks = Array.from({ length: 8 }, (_, index) => limit(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return index;
  }));
  const results = await Promise.all(tasks);
  assert.equal(maxActive, 2);
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('mapWithConcurrency 保留输入顺序', async () => {
  const results = await mapWithConcurrency([3, 1, 2], 2, async (value) => {
    await new Promise((resolve) => setTimeout(resolve, value * 5));
    return value * 10;
  });
  assert.deepEqual(results, [30, 10, 20]);
});

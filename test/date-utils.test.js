'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDateInfo,
  formatAperture,
  formatExposure,
  parseDimensions
} = require('../services/date-utils');

test('生成中文日期与分组字段', () => {
  const info = buildDateInfo(new Date(2024, 0, 2, 3, 4), 'exif');
  assert.equal(info.date, '2024年01月02日 03:04');
  assert.equal(info.day, '2024年01月02日');
  assert.equal(info.dateSource, 'exif');
});

test('格式化光圈、快门和尺寸', () => {
  assert.equal(formatAperture(2.8), 'f/2.8');
  assert.equal(formatExposure(0.004), '1/250s');
  assert.equal(formatExposure('1/125'), '1/125s');
  assert.deepEqual(parseDimensions(0, 0, '6000x4000'), { width: 6000, height: 4000 });
});

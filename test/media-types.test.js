'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getMediaInfo, getExtension } = require('../services/media-types');

test('识别常见标准图片、RAW 和视频格式', () => {
  assert.deepEqual(getMediaInfo('photo.jpg'), {
    supported: true, type: 'image', isRaw: false, extension: '.jpg', rawFormat: ''
  });
  assert.equal(getMediaInfo('camera.CR3').isRaw, true);
  assert.equal(getMediaInfo('camera.CR3').rawFormat, 'CR3');
  assert.equal(getMediaInfo('clip.mov').type, 'video');
  assert.equal(getMediaInfo('notes.txt').supported, false);
});

test('扩展名统一转为小写', () => {
  assert.equal(getExtension('PHOTO.NEF'), '.nef');
  assert.equal(getExtension('no-extension'), '');
});

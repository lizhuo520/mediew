'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { escapeHtml, baseName, joinPath, dirName } = require(
  path.join('..', 'renderer', 'components', 'folder-tree.js')
);

test('escapeHtml 把会拆坏 innerHTML 的字符都转掉', () => {
  assert.strictEqual(escapeHtml('普通目录'), '普通目录');
  assert.strictEqual(escapeHtml('<b>'), '&lt;b&gt;');
  assert.strictEqual(escapeHtml('a"b'), 'a&quot;b');
  assert.strictEqual(escapeHtml("a'b"), 'a&#39;b');
  assert.strictEqual(escapeHtml('a&b'), 'a&amp;b');
});

test('escapeHtml 先转 & 再转别的，不会二次转义', () => {
  // 顺序反了的话 &lt; 会被再转成 &amp;lt;
  assert.strictEqual(escapeHtml('<'), '&lt;');
  assert.strictEqual(escapeHtml('&lt;'), '&amp;lt;');
});

test('escapeHtml 挡住能逃出 title 属性的目录名', () => {
  const payload = '" onmouseover="alert(1)';
  const escaped = escapeHtml(payload);
  assert.ok(!escaped.includes('"'), '转义后不该再出现裸双引号');
  assert.strictEqual(escaped, '&quot; onmouseover=&quot;alert(1)');
});

test('escapeHtml 非字符串输入也不炸', () => {
  assert.strictEqual(escapeHtml(undefined), 'undefined');
  assert.strictEqual(escapeHtml(null), 'null');
  assert.strictEqual(escapeHtml(0), '0');
});

test('baseName 取最后一段，Windows 与 POSIX 路径都认', () => {
  assert.strictEqual(baseName('C:\\Users\\Lizhuo\\Pictures'), 'Pictures');
  assert.strictEqual(baseName('C:\\Users\\Lizhuo\\Pictures\\'), 'Pictures');
  assert.strictEqual(baseName('/home/lizhuo/pictures'), 'pictures');
  assert.strictEqual(baseName('/home/lizhuo/pictures/'), 'pictures');
  assert.strictEqual(baseName('D:\\'), 'D:');
  assert.strictEqual(baseName('photos'), 'photos');
  assert.strictEqual(baseName(''), '');
});

test('joinPath 保持父路径的分隔符风格，不硬编码反斜杠', () => {
  assert.strictEqual(joinPath('C:\\Users', 'Pictures'), 'C:\\Users\\Pictures');
  // 父路径末尾已有分隔符时不能再叠一个
  assert.strictEqual(joinPath('C:\\Users\\', 'Pictures'), 'C:\\Users\\Pictures');
  assert.strictEqual(joinPath('C:\\Users///', 'Pictures'), 'C:\\Users\\Pictures');
  // 只有盘符时按 Windows 习惯补反斜杠
  assert.strictEqual(joinPath('C:', 'Pictures'), 'C:\\Pictures');
  // POSIX 路径不能被塞进反斜杠
  assert.strictEqual(joinPath('/home/lizhuo', 'pictures'), '/home/lizhuo/pictures');
  assert.strictEqual(joinPath('/home/lizhuo/', 'pictures'), '/home/lizhuo/pictures');
});

test('joinPath 保留目录名里的空格与中文', () => {
  assert.strictEqual(
    joinPath('C:\\Users\\Lizhuo\\My Pictures', '2024 春节'),
    'C:\\Users\\Lizhuo\\My Pictures\\2024 春节'
  );
});

test('dirName 取上一级，两种分隔符都认', () => {
  assert.strictEqual(dirName('C:\\Users\\Lizhuo\\Pictures'), 'C:\\Users\\Lizhuo');
  assert.strictEqual(dirName('/home/lizhuo/pictures'), '/home/lizhuo');
  // 末尾分隔符不影响结果
  assert.strictEqual(dirName('C:\\Users\\Lizhuo\\Pictures\\'), 'C:\\Users\\Lizhuo');
  // 只有盘符 / 只有一层时返回空串，而不是返回 "C:" 这种半截路径去当父目录
  assert.strictEqual(dirName('C:\\'), '');
  assert.strictEqual(dirName('C:'), '');
  assert.strictEqual(dirName('photos'), '');
  assert.strictEqual(dirName(''), '');
});

test('joinPath 与 dirName 互为逆运算（同一分隔符风格下）', () => {
  const parent = 'C:\\Users\\Lizhuo\\Pictures';
  const child = '2024';
  assert.strictEqual(dirName(joinPath(parent, child)), parent);
  const posixParent = '/home/lizhuo/pictures';
  assert.strictEqual(dirName(joinPath(posixParent, child)), posixParent);
});

test('嵌套层级可以直接喂给 delete 流程当 parentPath', () => {
  // folder-tree 删目录后会拿 parentPath 重新 loadFolders，
  // 这里确认深层目录取出来的上一级正好是它所在的目录。
  assert.strictEqual(
    dirName('C:\\Users\\Lizhuo\\Pictures\\2024\\01'),
    'C:\\Users\\Lizhuo\\Pictures\\2024'
  );
});

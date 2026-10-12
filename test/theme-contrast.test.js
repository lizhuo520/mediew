'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const cssPath = path.join(__dirname, '..', 'renderer', 'styles.css');
const css = fs.readFileSync(cssPath, 'utf8');

/**
 * 从 styles.css 里取出两套主题的设计令牌。
 * 深色是默认的 :root，浅色是 :root[data-theme="light"]，
 * 所以用同一个正则扫，没有 data-theme 的那块就是深色。
 */
function readTokens() {
  const themes = { dark: {}, light: {} };
  const blockPattern = /:root(?:\[data-theme="(\w+)"\])?\s*\{([^}]*)\}/g;
  let match;
  while ((match = blockPattern.exec(css)) !== null) {
    const theme = match[1] === 'light' ? 'light' : 'dark';
    const declarationPattern = /(--[\w-]+)\s*:\s*([^;]+);/g;
    let declaration;
    while ((declaration = declarationPattern.exec(match[2])) !== null) {
      themes[theme][declaration[1]] = declaration[2].trim();
    }
  }
  return themes;
}

/**
 * 只支持十六进制。测试断言的都是设计令牌，不用管 rgba。
 */
function parseHex(value) {
  const hex = value.replace('#', '');
  assert.match(hex, /^[0-9a-fA-F]{6}$/, `期望 6 位十六进制颜色，收到 ${value}`);
  return [
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255
  ];
}

/** WCAG 2.x 相对亮度 */
function relativeLuminance(hex) {
  const [r, g, b] = parseHex(hex).map((channel) => (
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x 对比度，返回 1~21 之间的比值 */
function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

const AA_NORMAL_TEXT = 4.5;

const themes = readTokens();

test('两套主题都定义了全套文字色与危险色令牌', () => {
  for (const theme of ['dark', 'light']) {
    const tokens = themes[theme];
    assert.ok(Object.keys(tokens).length > 10, `${theme} 主题的令牌没解析出来`);
    for (const name of ['--bg-primary', '--bg-secondary', '--bg-card', '--text-primary',
      '--text-secondary', '--text-tertiary', '--danger']) {
      assert.ok(tokens[name], `${theme} 主题缺少 ${name}`);
    }
  }
});

test('深色主题：正文与次级/三级文字都达到 WCAG AA 4.5:1', () => {
  const t = themes.dark;
  // 这几组正是审计里实测不达标的位置：日期分组标题、统计栏、预览面板标签、
  // 缩略图占位文字，它们分别渲染在 bg-primary / bg-secondary / bg-card 上。
  const pairs = [
    ['--text-primary', '--bg-primary'],
    ['--text-primary', '--bg-card'],
    ['--text-secondary', '--bg-primary'],
    ['--text-secondary', '--bg-secondary'],
    ['--text-tertiary', '--bg-primary'],
    ['--text-tertiary', '--bg-secondary'],
    ['--text-tertiary', '--bg-card'],
    ['--danger', '--bg-primary']
  ];
  for (const [fg, bg] of pairs) {
    const ratio = contrastRatio(t[fg], t[bg]);
    assert.ok(
      ratio >= AA_NORMAL_TEXT,
      `深色 ${fg}(${t[fg]}) 在 ${bg}(${t[bg]}) 上只有 ${ratio.toFixed(2)}:1，低于 AA ${AA_NORMAL_TEXT}:1`
    );
  }
});

test('浅色主题：正文与次级/三级文字都达到 WCAG AA 4.5:1', () => {
  const t = themes.light;
  const pairs = [
    ['--text-primary', '--bg-primary'],
    ['--text-primary', '--bg-card'],
    ['--text-secondary', '--bg-primary'],
    ['--text-secondary', '--bg-secondary'],
    ['--text-tertiary', '--bg-primary'],
    ['--text-tertiary', '--bg-secondary'],
    ['--text-tertiary', '--bg-card'],
    ['--danger', '--bg-primary']
  ];
  for (const [fg, bg] of pairs) {
    const ratio = contrastRatio(t[fg], t[bg]);
    assert.ok(
      ratio >= AA_NORMAL_TEXT,
      `浅色 ${fg}(${t[fg]}) 在 ${bg}(${t[bg]}) 上只有 ${ratio.toFixed(2)}:1，低于 AA ${AA_NORMAL_TEXT}:1`
    );
  }
});

test('回归锁定：深色主题不再回退到审计时测出的暗色值', () => {
  const t = themes.dark;
  // #71767b(3.59:1) 与 #536471(2.69:1) 是修复前的值，谁改回去这里就红。
  assert.notStrictEqual(t['--text-secondary'].toLowerCase(), '#71767b');
  assert.notStrictEqual(t['--text-tertiary'].toLowerCase(), '#536471');
  assert.notStrictEqual(t['--text-tertiary'].toLowerCase(), '#71767b');
});

test('浅色主题不再回退到审计时测出的 4.34:1', () => {
  assert.notStrictEqual(themes.light['--text-tertiary'].toLowerCase(), '#71767b');
});

test('文件夹树的 active/selected 用正文色，不用强调蓝当文字色', () => {
  // 审计里 .folder-item.active 把 --accent-blue(#1d9bf0) 直接当 color，
  // 浅色主题上只有 2.84:1 —— 而"正在浏览的文件夹"恰恰是最需要看清的那个标签。
  const activeBlock = css.match(/\.folder-item\.active\s*\{[^}]*\}/);
  assert.ok(activeBlock, '.folder-item.active 规则没了');
  assert.ok(
    /color:\s*var\(--text-primary\)/.test(activeBlock[0]),
    '.folder-item.active 的文字色必须回到 --text-primary'
  );
  assert.ok(
    !/color:\s*var\(--accent-blue\)/.test(activeBlock[0]),
    '.folder-item.active 不允许再拿 --accent-blue 当文字色'
  );

  const selectedBlock = css.match(/\.folder-item\.selected\s*\{[^}]*\}/);
  assert.ok(selectedBlock, '.folder-item.selected 规则没了');
  assert.ok(
    /color:\s*var\(--text-primary\)/.test(selectedBlock[0]),
    '.folder-item.selected 的文字色必须回到 --text-primary'
  );
});

test('键盘焦点环对卡片和文件夹项都有显式样式', () => {
  // 这两类元素自带选中描边/底色，不能只靠浏览器默认 outline 混过去。
  const focusBlock = css.match(/\.image-card:focus-visible,\s*\n\.folder-item:focus-visible\s*\{[^}]*\}/);
  assert.ok(focusBlock, '缺少 .image-card/.folder-item 的 :focus-visible 规则');
  assert.ok(
    /outline:\s*2px solid var\(--accent-blue\)/.test(focusBlock[0]),
    '焦点环必须用 2px 实线，保证在选中底色上仍然看得见'
  );
  assert.ok(
    /\.folder-item:focus-visible\s*\{[^}]*outline-offset:\s*-2px/.test(css),
    '文件夹树是窄栏，焦点环要往内收，否则会被相邻项裁掉'
  );
});

test('右键菜单项有键盘焦点态', () => {
  assert.match(
    css,
    /\.context-menu-item:focus-visible\s*\{[^}]*box-shadow:\s*inset 2px 0 0 var\(--accent-blue\)/,
    '菜单项靠 roving tabindex 自管焦点，必须显式画焦点指示'
  );
});

test('卡片量几何尺寸时能临时关掉 content-visibility 的布局跳过', () => {
  // 方向键靠 getBoundingClientRect 找邻居；屏外卡片若被跳过布局，
  // 量到的是 contain-intrinsic-size 占位高度，会跳到错误的卡片上。
  assert.match(
    css,
    /#image-grid\.measuring-geometry \.image-card\s*\{[^}]*content-visibility:\s*visible/,
    '缺少 measureCardRects 需要的 .measuring-geometry 逃生门'
  );
});

test('Toast 容器与错误态样式齐全', () => {
  assert.match(css, /#toast-host\s*\{/, '缺少 #toast-host');
  assert.match(css, /\.toast-error\s*\{[^}]*var\(--danger\)/, '.toast-error 必须用 --danger 标识');
  assert.match(css, /\.toast-text\s*\{[^}]*white-space:\s*pre-line/, '批量失败信息是多行的，需要 pre-line');
});

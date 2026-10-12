'use strict';

/**
 * 轻量操作反馈。
 *
 * 之前所有文件操作的失败分支都是静默的：renameFile / moveFile / deleteFiles /
 * toggleFavorite 都返回 { success, error }，但调用方一律只写 `if (result.success)`，
 * else 分支什么都不做。于是"重命名成已存在的名字""拖到已有同名文件的目录"
 * "删除被占用的文件"这些情况在界面上完全没有提示，用户只会觉得"点了没反应"。
 *
 * 这里提供统一的可见反馈，并带 aria-live 让屏幕阅读器也能播报。
 */
const Toast = {
  host: null,
  MAX_VISIBLE: 3,
  DURATION: 4000,

  init() {
    this.host = document.getElementById('toast-host');
    if (this.host) return;
    this.host = document.createElement('div');
    this.host.id = 'toast-host';
    // polite：不打断用户当前操作，但会在朗读队列里播报操作结果
    this.host.setAttribute('aria-live', 'polite');
    this.host.setAttribute('aria-atomic', 'false');
    document.body.appendChild(this.host);
  },

  show(message, type = 'info', duration = this.DURATION) {
    if (!message) return null;
    if (!this.host) this.init();

    const el = document.createElement('div');
    el.className = `toast toast-${type}`;

    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = message;
    el.appendChild(text);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', '关闭提示');
    close.textContent = '✕';
    close.addEventListener('click', () => this.dismiss(el));
    el.appendChild(close);

    this.host.appendChild(el);
    // 只保留最近几条，避免连续失败时糊满屏幕
    while (this.host.children.length > this.MAX_VISIBLE) {
      this.dismiss(this.host.firstElementChild);
    }
    if (duration > 0) {
      el._timer = setTimeout(() => this.dismiss(el), duration);
    }
    return el;
  },

  info(message, duration) { return this.show(message, 'info', duration); },
  success(message, duration) { return this.show(message, 'success', duration); },
  error(message, duration) { return this.show(message, 'error', duration); },

  dismiss(el) {
    if (!el || !el.parentElement) return;
    if (el._timer) clearTimeout(el._timer);
    el.classList.add('toast-leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    // 动画被 prefers-reduced-motion 关掉时兜底移除
    setTimeout(() => { if (el.parentElement) el.remove(); }, 400);
  },

  clear() {
    if (!this.host) return;
    Array.from(this.host.children).forEach((el) => this.dismiss(el));
  },

  /**
   * 统一的 IPC 结果处理：调用方只关心"成功了要做什么"，失败时由这里负责显示原因。
   * 返回 true 表示成功，便于写成 `if (!Toast.report(r)) return;`。
   */
  report(result, successMessage) {
    if (result && result.success) {
      if (successMessage) this.success(successMessage);
      return true;
    }
    this.error((result && result.error) ? result.error : '操作失败');
    return false;
  }
};

window.Toast = Toast;

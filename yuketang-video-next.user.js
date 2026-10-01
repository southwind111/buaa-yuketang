// ==UserScript==
// @name         雨课堂：视频播完后切换下一段视频
// @namespace    codex.local.yuketang
// @version      1.0.0
// @description  只点击左侧目录中标记为“视频”的项目，不点击作业或题目。
// @match        https://buaa.yuketang.cn/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const KEY_ON = 'codex.yuketang.autoNext.on';
  const KEY_TITLE = 'codex.yuketang.autoNext.title';
  const KEY_PENDING = 'codex.yuketang.autoNext.pending';
  const KEY_SOURCE = 'codex.yuketang.autoNext.source';
  const marked = new WeakSet();
  let enabled = sessionStorage.getItem(KEY_ON) === '1';
  let pending = sessionStorage.getItem(KEY_PENDING) === '1';
  let sourceAtEnd = sessionStorage.getItem(KEY_SOURCE) || '';
  let currentVideo = null;
  let lastEnd = 0;

  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;background:#18334d;color:white;padding:10px 12px;border-radius:8px;box-shadow:0 2px 12px #0005;font:13px/1.5 sans-serif';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.style.cssText = 'cursor:pointer;padding:4px 8px;margin-right:8px';
  const choice = document.createElement('select');
  choice.title = '当前视频';
  choice.style.cssText = 'max-width:190px;margin-right:8px';
  const message = document.createElement('div');
  message.style.marginTop = '6px';
  panel.append(toggle, choice, message);
  document.documentElement.append(panel);

  function status(text) {
    toggle.textContent = enabled ? '停止' : '开始';
    message.textContent = text;
  }

  function stop(text) {
    enabled = false;
    pending = false;
    sessionStorage.removeItem(KEY_ON);
    sessionStorage.removeItem(KEY_PENDING);
    sessionStorage.removeItem(KEY_SOURCE);
    status(text);
  }

  function normalized(text) {
    return String(text || '').replace(/\s+/g, '').replace(/[（）()]/g, '').trim();
  }

  function exactTag(element, word) {
    return element.textContent?.trim() === word &&
      ![...element.children].some(child => child.textContent?.trim() === word);
  }

  function displayed(element) {
    return element.getClientRects().length > 0;
  }

  function rowFor(tag) {
    let element = tag.parentElement;
    for (let depth = 0; element && depth < 6; depth++, element = element.parentElement) {
      const text = element.innerText?.replace(/\s+/g, ' ').trim() || '';
      if (text.length < 4 || text.length > 140 || !/\d/.test(text)) continue;
      const tags = [...element.querySelectorAll('*')];
      const videos = tags.filter(item => exactTag(item, '视频'));
      const assignments = tags.filter(item => exactTag(item, '作业'));
      if (videos.length === 1 && assignments.length === 0) return element;
    }
    return null;
  }

  function videoRows() {
    const tags = [...document.querySelectorAll('*')]
      .filter(element => exactTag(element, '视频'))
      .filter(element => displayed(element) && element.getBoundingClientRect().left < Math.min(innerWidth * 0.28, 480));
    const rows = [];
    for (const tag of tags) {
      const row = rowFor(tag);
      if (!row || rows.some(item => item.element === row)) continue;
      const title = row.innerText.replace(/\s+/g, ' ').trim().replace(/^视频\s*/, '');
      if (title) rows.push({ element: row, title });
    }
    return rows;
  }

  function isSelected(element) {
    const className = String(element.className || '');
    if (element.getAttribute('aria-current') === 'true' || /(^|\s)(active|current|selected)(\s|$)/i.test(className)) return true;
    const color = getComputedStyle(element).backgroundColor.match(/\d+/g)?.map(Number);
    return !!color && color.length >= 3 && color[2] > 150 && color[2] > color[0] * 1.45 && color[2] > color[1] * 1.2;
  }

  function refreshChoice() {
    const rows = videoRows();
    const previous = choice.value || sessionStorage.getItem(KEY_TITLE) || '';
    choice.replaceChildren();
    for (const row of rows) {
      const option = document.createElement('option');
      option.value = normalized(row.title);
      option.textContent = row.title;
      choice.append(option);
    }
    const selected = rows.find(row => isSelected(row.element));
    const preferred = rows.find(row => normalized(row.title) === previous) || selected;
    if (preferred) choice.value = normalized(preferred.title);
    return rows;
  }

  function tryPlay(video) {
    if (!enabled || !pending || !video || document.hidden) return;
    if (video.readyState === 0) return;
    if (sourceAtEnd && (video.currentSrc || video.src) === sourceAtEnd) return;
    video.play().then(() => {
      pending = false;
      sessionStorage.removeItem(KEY_PENDING);
      sessionStorage.removeItem(KEY_SOURCE);
      sourceAtEnd = '';
      status('正在播放；播完后进入下一段视频');
    }).catch(() => status('浏览器阻止自动播放，请手动点播放'));
  }

  function bindVideo() {
    const video = [...document.querySelectorAll('video')].find(displayed);
    if (!video) return;
    currentVideo = video;
    if (!marked.has(video)) {
      marked.add(video);
      video.addEventListener('ended', onEnded);
      video.addEventListener('loadedmetadata', () => tryPlay(video));
      video.addEventListener('canplay', () => tryPlay(video));
    }
    tryPlay(video);
  }

  function onEnded(event) {
    if (!enabled || document.hidden || event.currentTarget !== currentVideo || !currentVideo.ended) return;
    if (Date.now() - lastEnd < 1500) return;
    lastEnd = Date.now();

    const rows = refreshChoice();
    const title = sessionStorage.getItem(KEY_TITLE) || choice.value;
    const index = rows.findIndex(row => normalized(row.title) === normalized(title));
    if (index < 0) return stop('无法确认当前目录位置，已停止');
    if (index + 1 >= rows.length) return stop('目录中没有下一段可见的视频，已停止');

    const next = rows[index + 1];
    sessionStorage.setItem(KEY_TITLE, normalized(next.title));
    sourceAtEnd = currentVideo.currentSrc || currentVideo.src || '';
    sessionStorage.setItem(KEY_SOURCE, sourceAtEnd);
    sessionStorage.setItem(KEY_PENDING, '1');
    pending = true;
    status(`视频结束，切换到：${next.title}`);
    setTimeout(() => {
      if (!enabled || document.hidden) return;
      // next.element 是含有单个“视频”标记、且不含“作业”标记的目录行。
      next.element.click();
    }, 500);
  }

  toggle.addEventListener('click', () => {
    if (enabled) return stop('已停止');
    const rows = refreshChoice();
    if (!currentVideo) return status('未找到网页视频播放器，请保持视频页打开');
    if (!rows.some(row => normalized(row.title) === choice.value)) return status('未找到左侧视频目录');
    enabled = true;
    sessionStorage.setItem(KEY_ON, '1');
    sessionStorage.setItem(KEY_TITLE, choice.value);
    status('正在等待当前视频播放结束');
  });

  const observer = new MutationObserver(bindVideo);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(bindVideo, 1000);
  refreshChoice();
  bindVideo();
  status(enabled ? '正在等待视频播放结束' : '选择当前视频，然后点击开始');
})();

(() => {
  'use strict';
  const extensionVersion = globalThis.chrome?.runtime?.getManifest?.().version || 'unknown';
  console.info('[雨课堂 Edge] content.js 已注入 v' + extensionVersion);

  const courseId = location.pathname.match(/\/lms-graph\/([^/]+)/)?.[1] || 'default';
  const keyPrefix = `codex.yuketang.edge.${courseId}.`;
  const KEY_ON = keyPrefix + 'on';
  const KEY_TITLE = keyPrefix + 'title';
  const KEY_PENDING = keyPrefix + 'pending';
  const KEY_SOURCE = keyPrefix + 'source';
  const KEY_DONE = keyPrefix + 'done';
  const KEY_SINCE = keyPrefix + 'pendingSince';
  const marked = new WeakSet();
  // Edge does not preserve a page's user-activation permission across reloads.
  // Keep the automation intent so the user can restart it with an in-page click.
  const resumeRequired = sessionStorage.getItem(KEY_ON) === '1';
  let enabled = false;
  let pending = sessionStorage.getItem(KEY_PENDING) === '1';
  let sourceAtSwitch = sessionStorage.getItem(KEY_SOURCE) || '';
  let pendingSince = Number(sessionStorage.getItem(KEY_SINCE) || 0);
  let currentVideo = null;
  let lastEndedAt = 0;
  let lastPlayAttempt = 0;
  let awaitingGesture = false;
  let completed;
  try {
    completed = new Set(JSON.parse(sessionStorage.getItem(KEY_DONE) || '[]'));
  } catch {
    completed = new Set();
  }

  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:380px;background:#18334d;color:white;padding:10px 12px;border-radius:8px;box-shadow:0 2px 12px #0005;font:13px/1.5 sans-serif';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.style.cssText = 'cursor:pointer;padding:4px 8px;margin-right:8px';
  const choice = document.createElement('select');
  choice.title = '播放起始视频';
  choice.style.cssText = 'max-width:190px;margin-right:8px';
  const versionTag = document.createElement('span');
  versionTag.textContent = 'v' + extensionVersion;
  versionTag.style.cssText = 'font-size:11px;color:#c8d8e8';
  const authorizeButton = document.createElement('button');
  authorizeButton.type = 'button';
  authorizeButton.textContent = '授权播放';
  authorizeButton.title = '在 Edge 拒绝自动播放后，点击此按钮继续播放';
  authorizeButton.style.cssText = 'display:none;cursor:pointer;padding:4px 8px;margin-left:8px';
  const message = document.createElement('div');
  message.style.marginTop = '6px';
  panel.append(toggle, choice, versionTag, authorizeButton, message);
  document.documentElement.append(panel);

  function status(text) {
    toggle.textContent = enabled ? '停止' : '开始';
    authorizeButton.style.display = awaitingGesture ? 'inline-block' : 'none';
    message.textContent = text;
  }

  function stop(text) {
    enabled = false;
    pending = false;
    awaitingGesture = false;
    sourceAtSwitch = '';
    sessionStorage.removeItem(KEY_ON);
    sessionStorage.removeItem(KEY_PENDING);
    sessionStorage.removeItem(KEY_SOURCE);
    sessionStorage.removeItem(KEY_SINCE);
    console.info('[雨课堂 Edge] 已停止：' + text);
    status(text);
  }

  function normalized(text) {
    return String(text || '').replace(/\s+/g, '').replace(/（/g, '(').replace(/）/g, ')').trim();
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
      const children = [...element.querySelectorAll('*')];
      const videoLabels = children.filter(item => exactTag(item, '视频'));
      const assignmentLabels = children.filter(item => exactTag(item, '作业'));
      if (videoLabels.length === 1 && assignmentLabels.length === 0) return element;
    }
    return null;
  }

  function videoRows() {
    const labels = [...document.querySelectorAll('*')]
      .filter(element => exactTag(element, '视频'))
      .filter(element => displayed(element) &&
        element.getBoundingClientRect().left < Math.min(innerWidth * 0.28, 480));
    const rows = [];
    for (const label of labels) {
      const element = rowFor(label);
      if (!element || rows.some(row => row.element === element)) continue;
      const title = element.innerText.replace(/\s+/g, ' ').trim().replace(/^视频\s*/, '');
      if (title) rows.push({ element, title });
    }
    return rows;
  }

  function isSelected(element) {
    let node = element;
    for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
      const className = String(node.className || '');
      if (node.getAttribute('aria-current') === 'true' ||
          /(^|\s)(active|current|selected)(\s|$)/i.test(className)) return true;
      const rgb = getComputedStyle(node).backgroundColor.match(/\d+/g)?.map(Number);
      if (rgb && rgb.length >= 3 &&
          rgb[2] > 150 && rgb[2] > rgb[0] * 1.45 && rgb[2] > rgb[1] * 1.2) return true;
    }
    return false;
  }

  function inferCurrentIndex(rows) {
    const selected = rows.findIndex(row => isSelected(row.element));
    if (selected >= 0) return selected;
    const mainLeft = Math.min(innerWidth * 0.25, 500);
    const headings = [...document.querySelectorAll('*')]
      .filter(element => displayed(element))
      .filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.left > mainLeft && rect.top >= 0 && rect.top < 190;
      })
      .map(element => element.innerText?.replace(/\s+/g, ' ').trim() || '')
      .filter(text => text.length > 4 && text.length < 180);
    return rows.findIndex(row =>
      headings.some(text => normalized(text).includes(normalized(row.title))));
  }

  function headerShows(title) {
    const key = normalized(title);
    if (!key) return false;
    const mainLeft = Math.min(innerWidth * 0.25, 500);
    return [...document.querySelectorAll('*')].some(element => {
      if (!displayed(element)) return false;
      const rect = element.getBoundingClientRect();
      if (rect.left <= mainLeft || rect.top < 0 || rect.top >= 190) return false;
      const text = element.innerText?.replace(/\s+/g, ' ').trim() || '';
      return text.length > 4 && text.length < 180 && normalized(text).includes(key);
    });
  }

  function confirmedCurrentIndex(rows, inferredIndex = inferCurrentIndex(rows)) {
    const matches = rows
      .map((row, index) => headerShows(row.title) ? index : -1)
      .filter(index => index >= 0);
    if (matches.length === 1) return matches[0];
    return matches.includes(inferredIndex) ? inferredIndex : -1;
  }

  function currentCompletionPercent() {
    const nodes = [...document.querySelectorAll('*')]
      .filter(element => displayed(element))
      .filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.left > innerWidth * 0.35 && rect.top >= 0 && rect.top < 200;
      });
    for (const element of nodes.reverse()) {
      const text = element.innerText?.replace(/\s+/g, ' ').trim() || '';
      if (text.length > 35) continue;
      const match = text.match(/完成度\s*[:：]?\s*(\d{1,3}(?:\.\d+)?)\s*%/);
      if (match) return Number(match[1]);
    }
    return null;
  }

  function progressOf(row, selectedRow) {
    const element = row.element;
    const evidence = [
      element.innerText, element.className, element.getAttribute('title'),
      element.getAttribute('aria-label'), element.getAttribute('data-status')
    ].filter(Boolean).join(' ');
    if (/未观看|未学习|未开始|未完成|待学习|(^|\D)0\s*%/.test(evidence)) return 'todo';
    if (/已完成|已学完|学习完成|(^|\D)100\s*%|(^|\W)(completed|finished|done)(\W|$)/i.test(evidence)) return 'done';
    if (selectedRow && row.element === selectedRow.element) {
      const percent = currentCompletionPercent();
      if (percent === 100) return 'done';
      if (percent !== null && percent < 100) return 'todo';
      // The page's live player state outranks a session cache. In particular,
      // a paused, non-ended current video must remain playable even if an old
      // `ended` event left this title in KEY_DONE.
      if (currentVideo && !currentVideo.ended) return 'todo';
    }
    if (completed.has(normalized(row.title))) return 'done';
    return 'unknown';
  }

  function refreshChoice() {
    const rows = videoRows();
    // Only preserve a live selection in this document. KEY_TITLE is a saved
    // navigation target and must never seed the dropdown after a reload.
    const previousIndex = choice.value === '' ? -1 : Number(choice.value);
    choice.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '选择开始播放的视频';
    choice.append(placeholder);
    for (const [index, row] of rows.entries()) {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = row.title;
      choice.append(option);
    }
    const inferredIndex = inferCurrentIndex(rows);
    const currentIndex = confirmedCurrentIndex(rows, inferredIndex);
    const selectedIndex = previousIndex >= 0 && previousIndex < rows.length
      ? previousIndex : currentIndex;
    choice.value = selectedIndex >= 0 ? String(selectedIndex) : '';
    console.info('[雨课堂 Edge] 视频目录映射', {
      currentIndex,
      currentTitle: rows[currentIndex]?.title || '',
      inferredIndex,
      rows: rows.map((row, index) => ({ index, title: row.title }))
    });
    return rows;
  }

  function markDone(title) {
    completed.add(normalized(title));
    sessionStorage.setItem(KEY_DONE, JSON.stringify([...completed]));
  }

  function clearPending() {
    pending = false;
    sourceAtSwitch = '';
    sessionStorage.removeItem(KEY_PENDING);
    sessionStorage.removeItem(KEY_SOURCE);
    sessionStorage.removeItem(KEY_SINCE);
  }

  function chooseRemaining(rows, startIndex) {
    if (!rows.length) return null;
    const inferredIndex = inferCurrentIndex(rows);
    const actualIndex = confirmedCurrentIndex(rows, inferredIndex);
    const selected = actualIndex >= 0 ? rows[actualIndex] : null;
    const ordered = [];
    for (let offset = 0; offset < rows.length; offset++) {
      ordered.push(rows[(startIndex + offset + rows.length) % rows.length]);
    }
    return ordered.find(row => progressOf(row, selected) === 'todo') ||
      ordered.find(row => progressOf(row, selected) === 'unknown') || null;
  }

  function playVideo(video) {
    if (!enabled || !video || document.hidden || awaitingGesture) return;
    const source = video.currentSrc || video.src || '';
    if (pending) {
      const targetTitle = sessionStorage.getItem(KEY_TITLE) || '';
      if (!headerShows(targetTitle)) {
        if (Date.now() - pendingSince > 15000) stop('目录项点击后，页面标题仍未切换到目标视频');
        return;
      }
      const percent = currentCompletionPercent();
      console.info('[雨课堂 Edge] 已确认目标视频', {
        title: targetTitle,
        mediaSourceChanged: !sourceAtSwitch || source !== sourceAtSwitch,
        completion: percent
      });
      if (percent >= 100) {
        console.info('[雨课堂 Edge] 跳过已完成视频', targetTitle, percent + '%');
        if (!video.paused) video.pause();
        markDone(targetTitle);
        const rows = refreshChoice();
        const index = rows.findIndex(row => normalized(row.title) === normalized(targetTitle));
        const next = index >= 0 ? chooseRemaining(rows, index + 1) : null;
        if (next) switchTo(next);
        else stop('可见目录中的视频都已完成');
        return;
      }
      clearPending();
    }
    if (video.ended) return;
    if (!video.paused) {
      clearPending();
      status('正在播放；播完后继续选择未完成的视频');
      return;
    }
    if (Date.now() - lastPlayAttempt < 2500) return;
    lastPlayAttempt = Date.now();
    console.info('[雨课堂 Edge] 调用 video.play()', { paused: video.paused, readyState: video.readyState });
    Promise.resolve(video.play()).then(() => {
      awaitingGesture = false;
      clearPending();
      status('正在播放；播完后继续选择未完成的视频');
    }).catch(error => {
      console.warn('[雨课堂 Edge] 播放失败', error?.name || '', error?.message || error);
      if (error?.name === 'NotAllowedError') {
        // Keep the playlist running; only the explicit Stop button may turn
        // the run state off. Ask for a separate user gesture to resume media.
        awaitingGesture = true;
        console.info('[雨课堂 Edge] 自动播放被拦截；运行状态保持开启');
        status('Edge 已拦截自动播放；任务仍在运行。点击“授权播放”继续');
      } else {
        status('播放失败：' + (error?.name || '未知错误'));
      }
    });
  }

  authorizeButton.addEventListener('click', () => {
    if (!enabled) return status('请先点击“开始”运行');
    if (!currentVideo) return status('未找到当前视频播放器');
    awaitingGesture = false;
    status('正在授权播放');
    playVideo(currentVideo);
  });

  function bindVideo() {
    const video = [...document.querySelectorAll('video')].find(displayed);
    if (!video) return;
    const changed = video !== currentVideo;
    currentVideo = video;
    if (!marked.has(video)) {
      marked.add(video);
      video.addEventListener('ended', onEnded);
      video.addEventListener('loadedmetadata', () => {
        if (enabled) playVideo(video);
      });
      video.addEventListener('canplay', () => {
        if (enabled && pending) playVideo(video);
      });
    }
    if (enabled && (pending || changed)) playVideo(video);
  }

  function switchTo(row) {
    if (!row || !enabled) return stop('没有找到未完成的视频');
    const rows = videoRows();
    const rowIndex = rows.findIndex(item => item.element === row.element);
    if (rowIndex >= 0) choice.value = String(rowIndex);
    pending = true;
    pendingSince = Date.now();
    sourceAtSwitch = currentVideo?.currentSrc || currentVideo?.src || '';
    sessionStorage.setItem(KEY_TITLE, normalized(row.title));
    sessionStorage.setItem(KEY_PENDING, '1');
    sessionStorage.setItem(KEY_SOURCE, sourceAtSwitch);
    sessionStorage.setItem(KEY_SINCE, String(pendingSince));
    console.info('[雨课堂 Edge] 切换到目录视频', row.title);
    status('正在切换到：' + row.title);
    setTimeout(() => {
      if (!enabled || document.hidden) return;
      // 只点击已确认含单个“视频”标签、且不含“作业”标签的目录行。
      row.element.click();
    }, 400);
  }

  function onEnded(event) {
    if (!enabled || document.hidden || event.currentTarget !== currentVideo ||
        !currentVideo.ended || Date.now() - lastEndedAt < 1500) return;
    lastEndedAt = Date.now();
    console.info('[雨课堂 Edge] 收到视频 ended 事件');
    const rows = refreshChoice();
    const choiceIndex = choice.value === '' ? -1 : Number(choice.value);
    const title = sessionStorage.getItem(KEY_TITLE) || rows[choiceIndex]?.title || '';
    const index = rows.findIndex(row => normalized(row.title) === normalized(title));
    if (index < 0) return stop('无法确认当前视频，已停止');
    markDone(rows[index].title);
    const next = chooseRemaining(rows, index + 1);
    if (!next) return stop('可见目录中的视频都已完成');
    switchTo(next);
  }

  toggle.addEventListener('click', () => {
    if (enabled) return stop('已停止');
    awaitingGesture = false;
    const rows = refreshChoice();
    bindVideo();
    console.info('[雨课堂 Edge] 点击开始', { videoRows: rows.length, videoElements: document.querySelectorAll('video').length, completion: currentCompletionPercent() });
    if (!rows.length) return status('未找到左侧视频目录');
    const inferredIndex = inferCurrentIndex(rows);
    const actualIndex = confirmedCurrentIndex(rows, inferredIndex);
    const selected = actualIndex >= 0 ? rows[actualIndex] : null;
    const chosenIndex = choice.value === '' ? -1 : Number(choice.value);
    const startIndex = chosenIndex >= 0 && chosenIndex < rows.length
      ? chosenIndex : actualIndex;
    enabled = true;
    sessionStorage.setItem(KEY_ON, '1');
    status('已启动；正在准备所选视频');
    const requestedTitle = startIndex >= 0 ? normalized(rows[startIndex].title) : '';
    if (pending && requestedTitle &&
        normalized(sessionStorage.getItem(KEY_TITLE)) !== requestedTitle) {
      pending = false;
      sourceAtSwitch = '';
      sessionStorage.removeItem(KEY_PENDING);
      sessionStorage.removeItem(KEY_SOURCE);
      sessionStorage.removeItem(KEY_SINCE);
    }
    console.info('[雨课堂 Edge] 播放起点', {
      selectedIndex: startIndex,
      selectedTitle: rows[startIndex]?.title || '',
      actualIndex,
      actualTitle: rows[actualIndex]?.title || '',
      inferredIndex
    });
    if (startIndex >= 0) {
      sessionStorage.setItem(KEY_TITLE, normalized(rows[startIndex].title));
    }

    // Start from the chosen row. If the player is already on it, call play()
    // directly in this click gesture; otherwise navigate to that exact row.
    if (startIndex >= 0 && startIndex === actualIndex) {
      if (!currentVideo) return stop('未找到当前视频播放器，无法续播');
      if (currentCompletionPercent() !== 100 && !currentVideo.ended) {
        // This button click is the fresh user gesture Edge requires. Clear any
        // stale navigation wait for this same, already-visible title first.
        clearPending();
        playVideo(currentVideo);
        return;
      }
    }

    if (startIndex < 0) {
      const explicitTodo = rows.find(row => progressOf(row, null) === 'todo');
      if (explicitTodo) switchTo(explicitTodo);
      else stop('无法识别当前视频，请在下拉框选择播放起始视频');
      return;
    }

    if (progressOf(rows[startIndex], selected) !== 'done') {
      switchTo(rows[startIndex]);
      return;
    }

    const next = chooseRemaining(rows, startIndex + 1);
    if (next) switchTo(next);
    else stop('可见目录中没有未完成的视频');
  });

  const observer = new MutationObserver(bindVideo);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(bindVideo, 1000);
  const initialRows = refreshChoice();
  bindVideo();
  console.info('[雨课堂 Edge] 初始化完成', { videoRows: initialRows.length, videoElements: document.querySelectorAll('video').length, visiblePlayer: !!currentVideo, completion: currentCompletionPercent(), resumeRequired });
  status(resumeRequired
    ? '续播状态已保留；请在本页点击“开始”允许播放'
    : '选择播放起始视频，点击开始');
})();

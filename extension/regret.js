(() => {
  const BUTTON_ID = 'yt-regret-btn';
  const MAX_HISTORY_PAGES = 4;
  const DEEP_HISTORY_PAGES = 10;
  const DEEP_AFTER = 10 * 60_000;
  const LABEL = 'Regret';
  const QUEUE_KEY = 'ytRegret.queue';
  const ACTIVITY_KEY = 'ytRegret.activity';
  const ACTIVITY_MAX = 50;
  const AUTO_FIRST_DELAY = 2_000;
  const AUTO_RETRY_DELAY = 10_000;
  const AUTO_MAX_DELAY = 30 * 60_000;
  const AUTO_GIVE_UP = 3 * 24 * 60 * 60_000;
  const DEFAULTS = YT_REGRET_DEFAULTS;

  const cfg = (key) => window.ytcfg?.get?.(key);
  const log = (...args) => console.info('[YT Regret]', ...args);

  const isShorts = () => location.pathname.startsWith('/shorts/');

  function currentVideoId() {
    if (location.pathname === '/watch') return new URLSearchParams(location.search).get('v');
    if (isShorts()) return location.pathname.split('/')[2] || null;
    return null;
  }

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }

  // --- Settings arrive from bridge.js (chrome.storage); until then nothing is mounted.

  let settings = { ...DEFAULTS };
  let settingsReady = false;

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.ytRegret !== 'settings') return;
    settings = { ...DEFAULTS, ...event.data.settings };
    settingsReady = true;
    document.querySelectorAll('.yt-regret-auto').forEach(setAutoState);
    document.querySelectorAll('.yt-regret-channel').forEach(setChannelState);
    mount();
  });

  window.postMessage({ ytRegret: 'hello' }, location.origin);
  // Fall back to defaults if the bridge never answers (e.g. the extension was reloaded under the page).
  setTimeout(() => {
    settingsReady = true;
    mount();
  }, 3_000);

  // --- YouTube internal API

  async function authHeaders() {
    const sapisid = document.cookie.match(/(?:^|;\s*)SAPISID=([^;]+)/)?.[1]
      ?? document.cookie.match(/(?:^|;\s*)__Secure-3PAPISID=([^;]+)/)?.[1];
    if (!sapisid) throw new Error('Not signed in');

    const ts = Math.floor(Date.now() / 1000);
    const digest = await crypto.subtle.digest('SHA-1',
      new TextEncoder().encode(`${ts} ${sapisid} ${location.origin}`));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `SAPISIDHASH ${ts}_${hex}`,
      'X-Origin': location.origin,
      'X-Goog-AuthUser': String(cfg('SESSION_INDEX') ?? 0),
      'X-Youtube-Client-Name': String(cfg('INNERTUBE_CONTEXT_CLIENT_NAME') ?? 1),
      'X-Youtube-Client-Version': String(cfg('INNERTUBE_CLIENT_VERSION') ?? ''),
    };
    const pageId = cfg('DELEGATED_SESSION_ID');
    if (pageId) headers['X-Goog-PageId'] = pageId;
    return headers;
  }

  async function innertube(endpoint, body) {
    const res = await fetch(`/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: await authHeaders(),
      body: JSON.stringify({ context: cfg('INNERTUBE_CONTEXT'), ...body }),
    });
    if (!res.ok) throw new Error(`${endpoint} failed: HTTP ${res.status}`);
    return res.json();
  }

  // Finds the feedback token of the smallest subtree that mentions only this video, so a
  // token belonging to a neighbouring history entry can never be picked up.
  function findRemovalToken(root, videoId) {
    let found = null;
    const walk = (node) => {
      const ids = new Set();
      const tokens = [];
      for (const [key, value] of Object.entries(node)) {
        if (found) break;
        if ((key === 'videoId' || key === 'contentId') && typeof value === 'string') ids.add(value);
        else if (key === 'feedbackToken' && typeof value === 'string') tokens.push(value);
        else if (value && typeof value === 'object') {
          const child = walk(value);
          child.ids.forEach((id) => ids.add(id));
          tokens.push(...child.tokens);
        }
      }
      if (!found && ids.size === 1 && ids.has(videoId) && tokens.length) found = tokens[0];
      return { ids, tokens };
    };
    walk(root);
    return found;
  }

  function findContinuation(root) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      const token = node.continuationCommand?.token;
      if (typeof token === 'string') return token;
      for (const value of Object.values(node)) {
        if (value && typeof value === 'object') stack.push(value);
      }
    }
    return null;
  }

  async function sendRemoval(token) {
    const res = await innertube('feedback', {
      feedbackTokens: [token],
      isFeedbackTokenUnencrypted: false,
      shouldMerge: false,
    });
    if (res.feedbackResponses?.[0]?.isProcessed === false) throw new Error('YouTube rejected the removal');
  }

  // Removes every id it can find in recent history; returns the ids that were removed.
  async function removeFromHistory(videoIds, maxPages = MAX_HISTORY_PAGES) {
    const pending = new Set(videoIds);
    const removed = new Set();
    let page = await innertube('browse', { browseId: 'FEhistory' });
    for (let i = 0; i < maxPages && page && pending.size; i++) {
      for (const id of [...pending]) {
        const token = findRemovalToken(page, id);
        if (!token) continue;
        await sendRemoval(token);
        pending.delete(id);
        removed.add(id);
      }
      if (!pending.size) break;
      const continuation = findContinuation(page);
      page = continuation ? await innertube('browse', { continuation }) : null;
    }
    return removed;
  }

  // --- Removal queue: videos are queued when you leave them (or a manual Regret fails) and retried
  // with backoff until they are removed or AUTO_GIVE_UP passes.

  let processing = false;
  const regretted = new Set();

  // Recent removals and give-ups, shown on the options page (mirrored there by bridge.js).
  function logActivity(event, item) {
    const entries = load(ACTIVITY_KEY, []);
    entries.unshift({ event, id: item.id, title: item.title ?? null, reason: item.reason ?? null, at: Date.now() });
    save(ACTIVITY_KEY, entries.slice(0, ACTIVITY_MAX));
  }

  function enqueue(id, reason, title = null) {
    if (!id || regretted.has(id)) return;
    const queue = load(QUEUE_KEY, []);
    if (queue.some((item) => item.id === id)) return;
    const now = Date.now();
    queue.push({ id, title, reason, queuedAt: now, due: now + AUTO_FIRST_DELAY, tries: 0 });
    save(QUEUE_KEY, queue);
    log(`queued ${id} (${reason}, ${queue.length} waiting)`);
    setTimeout(processQueue, AUTO_FIRST_DELAY);
  }

  const retryDelay = (tries) => Math.min(AUTO_MAX_DELAY, AUTO_RETRY_DELAY * 2 ** (tries - 1));

  function markButtonDone(ids) {
    const button = document.querySelector(`#${BUTTON_ID} .yt-regret-btn, .yt-regret-btn#${BUTTON_ID}`);
    if (button && ids.has(button.dataset.videoId)) setState(button, 'done', 'Removed from history');
  }

  async function processQueue() {
    if (processing || cfg('LOGGED_IN') === false) return;
    const now = Date.now();
    const queue = load(QUEUE_KEY, []);
    const due = queue.filter((item) => item.due <= now);
    if (!due.length) return;

    // One history lookup serves the whole queue, so items not yet due are checked for free.
    const deep = queue.some((item) => now - (item.queuedAt ?? now) > DEEP_AFTER);
    processing = true;
    let removed = new Set();
    let error = 'Not found in watch history yet';
    try {
      removed = await removeFromHistory(queue.map((item) => item.id), deep ? DEEP_HISTORY_PAGES : MAX_HISTORY_PAGES);
      removed.forEach((id) => regretted.add(id));
      if (removed.size) {
        log(`removed from history: ${[...removed].join(', ')}`);
        markButtonDone(removed);
        queue.filter((item) => removed.has(item.id)).forEach((item) => logActivity('removed', item));
      }
      const missing = due.filter((item) => !removed.has(item.id));
      if (missing.length) log(`not found in history yet: ${missing.map((item) => item.id).join(', ')}`);
    } catch (err) {
      error = err.message;
      console.warn('[YT Regret] queued removal', err);
    } finally {
      // Re-read the queue: videos may have been added while the requests were in flight.
      const dueIds = new Set(due.map((item) => item.id));
      const later = Date.now();
      const next = load(QUEUE_KEY, []).flatMap((item) => {
        if (removed.has(item.id)) return [];
        if (!dueIds.has(item.id)) return [item];
        const queuedAt = item.queuedAt ?? later;
        if (later - queuedAt > AUTO_GIVE_UP) {
          log(`gave up on ${item.id}: not removable for ${Math.round(AUTO_GIVE_UP / 86_400_000)} days`);
          logActivity('gave up', item);
          return [];
        }
        const tries = item.tries + 1;
        return [{ ...item, queuedAt, tries, lastError: error, due: later + retryDelay(tries) }];
      });
      save(QUEUE_KEY, next);
      processing = false;
    }
  }

  // --- Watch tracking: which video is open, its channel, and how long it actually played.

  let watching = null;

  function playerDetails(videoId) {
    for (const selector of ['#movie_player', '#shorts-player']) {
      const details = document.querySelector(selector)?.getPlayerResponse?.()?.videoDetails;
      if (details?.videoId === videoId) return details;
    }
    const initial = window.ytInitialPlayerResponse?.videoDetails;
    return initial?.videoId === videoId ? initial : null;
  }

  function autoRegretReason(entry) {
    const channel = entry.channelId && settings.channels.find((c) => c.id === entry.channelId);
    if (channel) return `Always regret: ${channel.name}`;
    if (entry.short) return settings.autoShorts ? 'Auto-regret Shorts' : null;
    if (settings.abandonEnabled && entry.watched > 0 && entry.watched < settings.abandonSeconds) {
      return `Left after ${entry.watched}s (rule: under ${settings.abandonSeconds}s)`;
    }
    return null;
  }

  function leave(entry) {
    const reason = autoRegretReason(entry);
    if (reason) enqueue(entry.id, reason, entry.title);
  }

  function trackWatching(countSecond) {
    const id = currentVideoId();
    if (watching?.id !== id) {
      if (watching) leave(watching);
      watching = id ? { id, short: isShorts(), channelId: null, title: null, watched: 0 } : null;
    }
    if (!watching) return;
    const details = watching.channelId && watching.title ? null : playerDetails(id);
    watching.channelId ??= details?.channelId ?? null;
    watching.title ??= details?.title ?? null;

    const playing = [...document.querySelectorAll('video')].some((video) => !video.paused && !video.ended);
    if (countSecond && playing && !document.querySelector('#movie_player.ad-showing')) watching.watched++;
  }

  // --- Buttons

  const SHORT_LABELS = { idle: LABEL, busy: '…', done: 'Removed', queued: 'Queued' };

  function setState(button, state, text, title = '') {
    button.dataset.state = state;
    button.querySelector('.yt-regret-label').textContent = button.dataset.short ? SHORT_LABELS[state] : text;
    button.title = title || text;
    button.disabled = state === 'busy' || state === 'done';
  }

  function isQueued(videoId) {
    return load(QUEUE_KEY, []).some((item) => item.id === videoId);
  }

  async function onRegret(event) {
    const button = event.currentTarget;
    const videoId = button.dataset.videoId;

    // Playback that continues after removal (or a Short looping) would add the view straight back.
    document.querySelectorAll('video').forEach((video) => video.pause());

    setState(button, 'busy', 'Removing…');
    try {
      const removed = await removeFromHistory([videoId]);
      if (!removed.size) throw new Error('Video not found in recent watch history');
      regretted.add(videoId);
      save(QUEUE_KEY, load(QUEUE_KEY, []).filter((item) => item.id !== videoId));
      logActivity('removed', { id: videoId, title: playerDetails(videoId)?.title, reason: 'Regret button' });
      setState(button, 'done', 'Removed from history');
    } catch (err) {
      console.warn('[YT Regret]', err);
      enqueue(videoId, 'Regret button (retried)', playerDetails(videoId)?.title);
      setState(button, 'queued', 'Queued — retrying',
        `${err.message}. It will keep retrying in the background while YouTube is open; click to try again now.`);
    }
  }

  function setAutoState(toggle) {
    toggle.setAttribute('aria-pressed', String(settings.autoShorts));
    toggle.title = settings.autoShorts
      ? 'Auto-regret is on: Shorts are removed from history after you swipe past them'
      : 'Auto-regret is off: click to remove every Short from history after you swipe past it';
  }

  function onAutoToggle(event) {
    settings.autoShorts = !settings.autoShorts;
    setAutoState(event.currentTarget);
    window.postMessage({ ytRegret: 'set', autoShorts: settings.autoShorts }, location.origin);
    log(`auto-regret for Shorts ${settings.autoShorts ? 'on' : 'off'}`);
  }

  // Built with DOM calls because YouTube's Trusted Types policy rejects innerHTML.
  function createIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'yt-regret-icon');
    for (const d of ['M4 12a8 8 0 1 0 2.3-5.6', 'M4 4v4h4', 'M12 8v4l2.5 2.5', 'M3 21 21 3']) {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }

  function createButton(videoId, short) {
    const button = document.createElement('button');
    button.className = short ? 'yt-regret-btn yt-regret-btn--short' : 'yt-regret-btn';
    button.dataset.videoId = videoId;
    if (short) {
      button.dataset.short = '1';
      const circle = document.createElement('span');
      circle.className = 'yt-regret-circle';
      circle.appendChild(createIcon());
      button.appendChild(circle);
    }
    const label = document.createElement('span');
    label.className = 'yt-regret-label';
    button.appendChild(label);
    button.addEventListener('click', onRegret);
    if (regretted.has(videoId)) setState(button, 'done', 'Removed from history');
    else if (isQueued(videoId)) setState(button, 'queued', 'Queued — retrying', 'Waiting to be removed; click to try again now.');
    else setState(button, 'idle', LABEL, 'Remove this video from your watch history');
    return button;
  }

  function createShortsControls(videoId) {
    const wrap = document.createElement('div');
    wrap.className = 'yt-regret-shorts';
    wrap.appendChild(createButton(videoId, true));

    const toggle = document.createElement('button');
    toggle.className = 'yt-regret-auto';
    toggle.textContent = 'Auto';
    toggle.addEventListener('click', onAutoToggle);
    setAutoState(toggle);
    wrap.appendChild(toggle);
    return wrap;
  }

  const SHORTS_BAR_SELECTORS = [
    'reel-action-bar-view-model',
    'ytd-reel-player-overlay-renderer #actions',
    'ytd-reel-video-renderer #actions',
    'ytd-shorts #actions',
  ].join(',');

  // Several Shorts stay rendered while scrolling; the active one is the bar nearest the viewport centre.
  function centeredVisible(elements) {
    const mid = window.innerHeight / 2;
    let best = null;
    let bestDistance = Infinity;
    for (const el of elements) {
      let rect = el.getBoundingClientRect();
      // Custom elements styled display: contents report an empty box; measure their content instead.
      if (!rect.width && el.firstElementChild) rect = el.firstElementChild.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > window.innerHeight) continue;
      const distance = Math.abs((rect.top + rect.bottom) / 2 - mid);
      if (distance < bestDistance) {
        best = el;
        bestDistance = distance;
      }
    }
    return best;
  }

  function findHost() {
    if (isShorts()) {
      const bar = centeredVisible(document.querySelectorAll(SHORTS_BAR_SELECTORS));
      return { host: bar ?? document.body, short: true, floating: !bar };
    }
    const host = document.querySelector('ytd-watch-metadata #top-level-buttons-computed')
      ?? document.querySelector('ytd-watch-metadata #actions-inner')
      ?? document.querySelector('ytd-watch-metadata #owner');
    return host ? { host, short: false } : null;
  }

  // --- Channel pages: "Always regret" toggles the channel in the auto-regret list.

  const CHANNEL_BUTTON_ID = 'yt-regret-channel-btn';
  const CHANNEL_PATH = /^\/(@[^/]+|channel\/(UC[\w-]{22})|c\/[^/]+|user\/[^/]+)(\/|$)/;
  const CHANNEL_HEADER_SELECTORS = [
    'yt-page-header-view-model yt-flexible-actions-view-model',
    '#page-header yt-flexible-actions-view-model',
    'ytd-c4-tabbed-header-renderer #buttons',
    '#channel-header #buttons',
  ];

  // The page data lags behind the URL during in-app navigation, so it is only trusted once it matches.
  function currentChannel() {
    const match = location.pathname.match(CHANNEL_PATH);
    if (!match) return null;
    const responses = [document.querySelector('ytd-app')?.data?.response, window.ytInitialData];
    for (const response of responses) {
      const meta = response?.metadata?.channelMetadataRenderer;
      if (!meta?.externalId) continue;
      const segment = decodeURIComponent(match[1]).toLowerCase();
      const fits = match[2] ? meta.externalId === match[2]
        : segment.startsWith('@') ? decodeURIComponent(meta.vanityChannelUrl ?? '').toLowerCase().endsWith(`/${segment}`)
        : true;
      if (fits) return { id: meta.externalId, name: meta.title || meta.externalId };
    }
    return null;
  }

  const isAlwaysRegretted = (id) => settings.channels.some((channel) => channel.id === id);

  function setChannelState(button) {
    const on = isAlwaysRegretted(button.dataset.channelId);
    button.setAttribute('aria-pressed', String(on));
    button.querySelector('.yt-regret-label').textContent = on ? 'Always regretting' : 'Always regret';
    button.title = on
      ? `Videos from ${button.dataset.channelName} are removed from your history after you watch them. Click to stop.`
      : `Remove every video from ${button.dataset.channelName} from your history after you watch it`;
  }

  function onChannelToggle(event) {
    const button = event.currentTarget;
    const { channelId: id, channelName: name } = button.dataset;
    const on = isAlwaysRegretted(id);
    settings.channels = on
      ? settings.channels.filter((channel) => channel.id !== id)
      : [...settings.channels, { id, name }];
    setChannelState(button);
    window.postMessage({ ytRegret: on ? 'removeChannel' : 'addChannel', id, name }, location.origin);
    log(`${on ? 'stopped' : 'started'} always regretting ${name}`);
  }

  function createChannelButton(channel) {
    const button = document.createElement('button');
    button.id = CHANNEL_BUTTON_ID;
    button.className = 'yt-regret-btn yt-regret-channel';
    button.dataset.channelId = channel.id;
    button.dataset.channelName = channel.name;
    button.appendChild(createIcon());
    const label = document.createElement('span');
    label.className = 'yt-regret-label';
    button.appendChild(label);
    button.addEventListener('click', onChannelToggle);
    setChannelState(button);
    return button;
  }

  function mountChannel() {
    const existing = document.getElementById(CHANNEL_BUTTON_ID);
    const channel = cfg('LOGGED_IN') === false ? null : currentChannel();
    if (!channel) {
      existing?.remove();
      return;
    }
    const host = CHANNEL_HEADER_SELECTORS.map((selector) => document.querySelector(selector)).find(Boolean);
    if (!host) return;
    if (existing?.dataset.channelId === channel.id && host.contains(existing)) return;
    existing?.remove();
    host.appendChild(createChannelButton(channel));
  }

  // --- Watch history page: a Regret pill on every entry's thumbnail.

  const HISTORY_ITEM_SELECTORS = [
    'ytd-video-renderer',
    'yt-lockup-view-model',
    'ytm-shorts-lockup-view-model-v2',
    'ytm-shorts-lockup-view-model',
    'ytd-reel-item-renderer',
  ].join(',');
  const HISTORY_MARK = 'ytRegretItem';

  function itemVideoId(item) {
    for (const link of item.querySelectorAll('a[href]')) {
      const url = new URL(link.getAttribute('href'), location.origin);
      if (url.pathname === '/watch' && url.searchParams.get('v')) return url.searchParams.get('v');
      const short = url.pathname.match(/^\/shorts\/([\w-]{11})/);
      if (short) return short[1];
    }
    return null;
  }

  // Prefer the token YouTube attached to the rendered entry or page; fetching history is the fallback.
  function localRemovalToken(item, videoId) {
    const sources = [];
    for (let node = item, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
      sources.push(node.data, node.__data?.data);
    }
    sources.push(document.querySelector('ytd-app')?.data?.response);
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      const token = findRemovalToken(source, videoId);
      if (token) return token;
    }
    return null;
  }

  async function onHistoryRegret(event) {
    event.preventDefault();
    event.stopPropagation();
    const button = event.currentTarget;
    const item = button.closest(HISTORY_ITEM_SELECTORS);
    const videoId = button.dataset.videoId;
    const title = item.querySelector('h3')?.textContent.trim() || null;

    setState(button, 'busy', '…');
    try {
      const token = localRemovalToken(item, videoId);
      if (token) await sendRemoval(token);
      else if (!(await removeFromHistory([videoId], DEEP_HISTORY_PAGES)).size) {
        throw new Error('Video not found in watch history');
      }
      regretted.add(videoId);
      logActivity('removed', { id: videoId, title, reason: 'History page' });
      setState(button, 'done', 'Removed');
      item.classList.add('yt-regret-removed');
      setTimeout(() => { item.style.display = 'none'; }, 400);
    } catch (err) {
      console.warn('[YT Regret]', err);
      enqueue(videoId, 'History page (retried)', title);
      setState(button, 'queued', 'Queued', `${err.message}. It will keep retrying in the background.`);
    }
  }

  function mountHistory() {
    const enabled = location.pathname === '/feed/history' && settings.buttonHistory && cfg('LOGGED_IN') !== false;
    if (!enabled) {
      document.querySelectorAll('.yt-regret-hist').forEach((button) => button.remove());
      document.querySelectorAll(`[data-yt-regret-item]`).forEach((item) => delete item.dataset[HISTORY_MARK]);
      return;
    }
    for (const item of document.querySelectorAll(HISTORY_ITEM_SELECTORS)) {
      if (item.dataset[HISTORY_MARK] || item.parentElement?.closest(HISTORY_ITEM_SELECTORS)) continue;
      const videoId = itemVideoId(item);
      const slot = historySlot(item);
      if (!videoId || !slot) continue;
      item.dataset[HISTORY_MARK] = videoId;

      const button = document.createElement('button');
      button.className = `yt-regret-btn yt-regret-hist ${slot.inline ? 'yt-regret-hist--inline' : 'yt-regret-hist--overlay'}`;
      button.dataset.videoId = videoId;
      const label = document.createElement('span');
      label.className = 'yt-regret-label';
      button.appendChild(label);
      button.addEventListener('click', onHistoryRegret);
      setState(button, 'idle', LABEL, 'Remove from watch history');
      if (!slot.inline) slot.el.classList.add('yt-regret-hist-host');
      slot.el.appendChild(button);
    }
  }

  // Below the title and channel lines when the entry has them; otherwise over the thumbnail.
  function historySlot(item) {
    const title = item.querySelector('h3');
    const text = item.querySelector('#meta') ?? title?.parentElement;
    if (text && text !== item && !text.closest('a')) return { el: text, inline: true };
    const thumb = item.querySelector('a[href] img')?.closest('a')?.parentElement;
    return thumb ? { el: thumb, inline: false } : null;
  }

  function mount() {
    trackWatching(false);
    if (!settingsReady) return;
    mountChannel();
    mountHistory();

    const videoId = currentVideoId();
    const existing = document.getElementById(BUTTON_ID);
    const enabled = isShorts() ? settings.buttonShorts : settings.buttonVideos;
    if (!videoId || !enabled || cfg('LOGGED_IN') === false) {
      existing?.remove();
      return;
    }

    const target = findHost();
    if (!target) return;
    if (existing && existing.dataset.videoId === videoId && target.host.contains(existing)) return;
    existing?.remove();

    const el = target.short ? createShortsControls(videoId) : createButton(videoId, false);
    if (target.floating) el.classList.add('yt-regret-floating');
    el.id = BUTTON_ID;
    el.dataset.videoId = videoId;
    target.host.appendChild(el);
  }

  // YouTube re-renders the action bars as it hydrates, on in-app navigation and on every Shorts swipe.
  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      mount();
    });
  }).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['is-active'],
  });

  // Closing the tab still queues the open video; the queue is picked up on the next YouTube visit.
  window.addEventListener('pagehide', () => {
    if (watching) leave(watching);
    watching = null;
  });

  document.addEventListener('yt-navigate-finish', mount);
  setInterval(() => {
    trackWatching(true);
    mount();
  }, 1_000);
  setInterval(processQueue, 2_000);
  log('loaded');
})();

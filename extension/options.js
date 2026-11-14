const $ = (id) => document.getElementById(id);
const CHECKBOXES = ['buttonVideos', 'buttonShorts', 'buttonHistory', 'autoShorts', 'abandonEnabled'];

let channels = [];
let statusTimer;

function flashSaved() {
  $('status').textContent = 'Saved';
  $('status').classList.add('visible');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => $('status').classList.remove('visible'), 1200);
}

async function save(patch) {
  await chrome.storage.sync.set(patch);
  flashSaved();
}

function renderChannels() {
  const list = $('channelList');
  list.replaceChildren(...channels.map((channel) => {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = `https://www.youtube.com/channel/${channel.id}`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = channel.name;
    link.title = channel.id;

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      channels = channels.filter((c) => c.id !== channel.id);
      renderChannels();
      save({ channels });
    });

    item.append(link, remove);
    return item;
  }));
  $('channelEmpty').hidden = channels.length > 0;
}

function toYouTubeUrl(input) {
  const text = input.trim();
  if (/^UC[\w-]{22}$/.test(text)) return `https://www.youtube.com/channel/${text}`;
  if (/^@[\w.-]+$/.test(text)) return `https://www.youtube.com/${text}`;
  try {
    const url = new URL(text.includes('://') ? text : `https://${text}`);
    if (url.hostname === 'youtu.be') return `https://www.youtube.com/watch?v=${url.pathname.slice(1)}`;
    if (/(^|\.)youtube\.com$/.test(url.hostname)) return `https://www.youtube.com${url.pathname}${url.search}`;
  } catch {}
  return null;
}

function decodeEntities(text) {
  return new DOMParser().parseFromString(text, 'text/html').documentElement.textContent;
}

async function resolveChannel(input) {
  const url = toYouTubeUrl(input);
  if (!url) throw new Error('Enter a @handle, a channel URL, or a YouTube video URL.');

  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`YouTube returned HTTP ${res.status} for that address.`);
  const html = await res.text();

  if (/\/(watch|shorts)\b/.test(new URL(url).pathname)) {
    const match = html.match(/"videoDetails":\{[\s\S]*?"channelId":"(UC[\w-]{22})"[\s\S]*?"author":"((?:[^"\\]|\\.)*)"/);
    if (match) return { id: match[1], name: JSON.parse(`"${match[2]}"`) };
  }

  const id = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)?.[1]
    ?? html.match(/"externalId":"(UC[\w-]{22})"/)?.[1];
  if (!id) throw new Error("Couldn't find a channel at that address.");
  const name = html.match(/<meta property="og:title" content="([^"]*)"/)?.[1];
  return { id, name: name ? decodeEntities(name) : id };
}

async function onAddChannel(event) {
  event.preventDefault();
  const input = $('channelInput');
  if (!input.value.trim()) return;

  $('addButton').disabled = true;
  $('channelError').hidden = true;
  try {
    const channel = await resolveChannel(input.value);
    if (channels.some((c) => c.id === channel.id)) throw new Error(`${channel.name} is already in the list.`);
    channels = [...channels, channel];
    renderChannels();
    await save({ channels });
    input.value = '';
  } catch (err) {
    $('channelError').textContent = err.message;
    $('channelError').hidden = false;
  } finally {
    $('addButton').disabled = false;
  }
}

// --- Queue and activity, mirrored from youtube.com by bridge.js

let mirror = null;

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86_400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} d`;
}

function videoLink(item) {
  const link = document.createElement('a');
  link.className = 'title';
  link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(item.id)}`;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = item.title || item.id;
  link.title = item.title ? `${item.title} (${item.id})` : item.id;
  return link;
}

// Older versions stored short codes; show them the way new entries are written.
const LEGACY_REASONS = {
  short: 'Auto-regret Shorts',
  channel: 'Always regret: channel',
  'manual regret failed': 'Regret button (retried)',
  'history page regret failed': 'History page (retried)',
  'history page': 'History page',
};

function describeReason(reason) {
  if (!reason) return 'Unknown rule';
  if (LEGACY_REASONS[reason]) return LEGACY_REASONS[reason];
  const left = reason.match(/^left after (\d+)s$/);
  return left ? `Left after ${left[1]}s` : reason;
}

function ruleLabel(reason) {
  const span = document.createElement('span');
  span.className = 'rule';
  span.textContent = describeReason(reason);
  const wrap = document.createDocumentFragment();
  wrap.append(span, ' · ');
  return wrap;
}

function smallButton(text, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  button.addEventListener('click', onClick);
  return button;
}

async function sendCommand(command) {
  const { queueCommands = [] } = await chrome.storage.local.get('queueCommands');
  await chrome.storage.local.set({ queueCommands: [...queueCommands, command] });
}

function renderQueue() {
  const now = Date.now();
  const queue = mirror?.queue ?? [];
  const seen = $('queueSeen');
  if (!mirror) seen.textContent = 'No data from YouTube yet. Open (or reload) a YouTube tab to load the queue and activity.';
  else if (now - mirror.seenAt > 90_000) {
    seen.textContent = `Last updated from YouTube ${ago(now - mirror.seenAt)} ago. If a YouTube tab is open, reload it: `
      + 'tabs opened before the extension was reloaded or updated stop reporting here. '
      + 'Removals only run while a YouTube tab is open.';
  } else seen.textContent = '';

  $('queueList').replaceChildren(...queue.map((item) => {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'info';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const parts = [`waiting ${ago(now - (item.queuedAt ?? now))}`];
    if (item.tries) parts.push(`${item.tries} ${item.tries === 1 ? 'attempt' : 'attempts'}`);
    parts.push(item.due <= now ? 'retrying now' : `next try in ${ago(item.due - now)}`);
    meta.append(ruleLabel(item.reason), parts.join(' · '));
    if (item.lastError) {
      const problem = document.createElement('div');
      problem.className = 'problem';
      problem.textContent = item.lastError;
      meta.appendChild(problem);
    }
    info.append(videoLink(item), meta);
    li.append(info,
      smallButton('Retry now', () => sendCommand({ op: 'retry', id: item.id })),
      smallButton('Discard', () => sendCommand({ op: 'discard', id: item.id })));
    return li;
  }));
  $('queueEmpty').hidden = queue.length > 0 || !mirror;
  $('retryAll').disabled = $('clearQueue').disabled = queue.length === 0;
}

function renderActivity() {
  const now = Date.now();
  const activity = mirror?.activity ?? [];
  $('activityList').replaceChildren(...activity.map((entry) => {
    const li = document.createElement('li');
    const badge = document.createElement('span');
    badge.className = `badge ${entry.event === 'removed' ? 'removed' : 'gave-up'}`;
    badge.textContent = entry.event === 'removed' ? 'Removed' : 'Gave up';
    const info = document.createElement('div');
    info.className = 'info';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.append(ruleLabel(entry.reason), `${ago(now - entry.at)} ago`);
    info.append(videoLink(entry), meta);
    li.append(badge, info);
    return li;
  }));
  $('activityEmpty').hidden = activity.length > 0;
  $('clearActivity').disabled = activity.length === 0;
}

async function initQueue() {
  ({ queueMirror: mirror = null } = await chrome.storage.local.get('queueMirror'));
  renderQueue();
  renderActivity();

  $('retryAll').addEventListener('click', () => sendCommand({ op: 'retryAll' }));
  $('clearQueue').addEventListener('click', () => {
    if (confirm('Stop trying to remove every waiting video? They stay in your watch history.')) sendCommand({ op: 'clear' });
  });
  $('clearActivity').addEventListener('click', () => sendCommand({ op: 'clearActivity' }));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.queueMirror) return;
    mirror = changes.queueMirror.newValue ?? null;
    renderQueue();
    renderActivity();
  });
  setInterval(() => {
    renderQueue();
    renderActivity();
  }, 5_000);
}

async function init() {
  const version = chrome.runtime?.getManifest?.().version;
  if (version) $('version').textContent = `v${version}`;
  initQueue();
  const settings = await chrome.storage.sync.get(YT_REGRET_DEFAULTS);

  for (const key of CHECKBOXES) {
    $(key).checked = settings[key];
    $(key).addEventListener('change', () => {
      save({ [key]: $(key).checked });
      if (key === 'abandonEnabled') $('abandonSeconds').disabled = !$(key).checked;
    });
  }

  $('abandonSeconds').value = settings.abandonSeconds;
  $('abandonSeconds').disabled = !settings.abandonEnabled;
  $('abandonSeconds').addEventListener('change', () => {
    const seconds = Math.min(600, Math.max(5, Math.round(Number($('abandonSeconds').value) || 30)));
    $('abandonSeconds').value = seconds;
    save({ abandonSeconds: seconds });
  });

  channels = settings.channels;
  renderChannels();
  $('addChannel').addEventListener('submit', onAddChannel);

  // Keep in sync with the Auto toggle on Shorts and other open option pages.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const key of CHECKBOXES) if (changes[key]) $(key).checked = changes[key].newValue;
    if (changes.channels) {
      channels = changes.channels.newValue ?? [];
      renderChannels();
    }
  });
}

init();

// Runs in the extension's isolated world: relays settings between chrome.storage and regret.js,
// which runs in the page's world and cannot reach extension APIs.
(() => {
  const LEGACY_AUTO_KEY = 'ytRegret.autoShorts';
  const CHANNEL_ID = /^UC[\w-]{22}$/;

  const send = (settings) => window.postMessage({ ytRegret: 'settings', settings }, location.origin);

  async function current() {
    return chrome.storage.sync.get(YT_REGRET_DEFAULTS);
  }

  async function migrate() {
    try {
      if (localStorage.getItem(LEGACY_AUTO_KEY) === 'true') {
        await chrome.storage.sync.set({ autoShorts: true });
      }
      localStorage.removeItem(LEGACY_AUTO_KEY);
    } catch {}
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const msg = event.data;
    try {
      if (msg?.ytRegret === 'hello') send(await current());
      // The page may only flip the Shorts toggle and add/remove channels; the rest lives in the options page.
      else if (msg?.ytRegret === 'set' && typeof msg.autoShorts === 'boolean') {
        await chrome.storage.sync.set({ autoShorts: msg.autoShorts });
      } else if (msg?.ytRegret === 'addChannel' && CHANNEL_ID.test(msg.id) && typeof msg.name === 'string') {
        const { channels } = await chrome.storage.sync.get({ channels: [] });
        if (!channels.some((c) => c.id === msg.id)) {
          await chrome.storage.sync.set({ channels: [...channels, { id: msg.id, name: msg.name.trim().slice(0, 200) || msg.id }] });
        }
      } else if (msg?.ytRegret === 'removeChannel' && CHANNEL_ID.test(msg.id)) {
        const { channels } = await chrome.storage.sync.get({ channels: [] });
        await chrome.storage.sync.set({ channels: channels.filter((c) => c.id !== msg.id) });
      }
    } catch {}
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'sync') return;
    try {
      send(await current());
    } catch {}
  });

  migrate().then(current).then(send).catch(() => {});

  // --- Queue mirror: regret.js keeps its queue in youtube.com's localStorage, which the options page
  // can't read. Copy it to chrome.storage.local, and apply the options page's commands to it.

  const QUEUE_KEY = 'ytRegret.queue';
  const ACTIVITY_KEY = 'ytRegret.activity';
  const HEARTBEAT = 30_000;
  let lastMirror = '';
  let lastSeen = 0;

  const read = (key) => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '[]');
    } catch {
      return [];
    }
  };

  async function mirror() {
    const queue = localStorage.getItem(QUEUE_KEY) ?? '[]';
    const activity = localStorage.getItem(ACTIVITY_KEY) ?? '[]';
    const snapshot = queue + activity;
    const now = Date.now();
    if (snapshot === lastMirror && now - lastSeen < HEARTBEAT) return;
    lastMirror = snapshot;
    lastSeen = now;
    await chrome.storage.local.set({ queueMirror: { queue: read(QUEUE_KEY), activity: read(ACTIVITY_KEY), seenAt: now } });
  }

  function applyCommand(command) {
    if (!command?.op) return;
    const queue = read(QUEUE_KEY);
    const now = Date.now();
    let next = queue;
    if (command.op === 'retry') next = queue.map((item) => (item.id === command.id ? { ...item, due: now } : item));
    else if (command.op === 'retryAll') next = queue.map((item) => ({ ...item, due: now }));
    else if (command.op === 'discard') next = queue.filter((item) => item.id !== command.id);
    else if (command.op === 'clear') next = [];
    else if (command.op === 'clearActivity') localStorage.setItem(ACTIVITY_KEY, '[]');
    if (next !== queue) localStorage.setItem(QUEUE_KEY, JSON.stringify(next));
  }

  async function takeCommands() {
    const { queueCommands = [] } = await chrome.storage.local.get('queueCommands');
    if (!queueCommands.length) return;
    await chrome.storage.local.remove('queueCommands');
    queueCommands.forEach(applyCommand);
    lastMirror = '';
    await mirror();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.queueCommands?.newValue?.length) takeCommands().catch(() => {});
  });

  // Stops by itself once the extension is reloaded and this script's chrome.* access is revoked.
  const timer = setInterval(() => {
    mirror().catch(() => clearInterval(timer));
  }, 2_000);
  takeCommands().then(mirror).catch(() => {});
})();

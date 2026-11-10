// jo's latest Instagram posts, for the Contact section of the site. Two ways in, whichever jo set up on Render:
//   INSTAGRAM_FEED_URL: a JSON feed from behold.so. Free, and there's nothing secret in it.
//   INSTAGRAM_TOKEN: a token for Instagram's own API (the "Generate token" button in a Meta app). Tokens last 60 days,
//     so the server renews it about once a week and keeps the new one in the orders repo, where it survives restarts.
// Either way the server asks at most every half hour and hands everyone the saved answer, so a busy day can't run
// into Instagram's rate limits or Behold's monthly view cap. Behold's pictures are made to be shown on other sites;
// Instagram's own picture links expire and may refuse other sites, so with a token the server keeps copies of the
// pictures and hands them out itself, at /instagram/img/<id>.

const crypto = require('crypto');

const FRESH_MS = 30 * 60 * 1000; // how long a fetched feed is reused
const RETRY_MS = 5 * 60 * 1000; // after a failure, wait this long before asking again
const RENEW_MS = 7 * 24 * 60 * 60 * 1000; // renew the token about once a week
const RENEW_RETRY_MS = 24 * 60 * 60 * 1000; // a token can only be renewed once it's a day old, so a failed try waits a day

const https = (u) => (typeof u === 'string' && /^https:\/\//.test(u) ? u : null);
const instagramUrl = (u) => (typeof u === 'string' && /^https:\/\/(www\.)?instagram\.com\//.test(u) ? u : null);
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const TYPES = { IMAGE: 'image', VIDEO: 'video', CAROUSEL_ALBUM: 'carousel' };

// Behold's feed: { username, posts: [{ permalink, mediaType, mediaUrl, thumbnailUrl, sizes: { medium: { mediaUrl } }, caption, timestamp }] }
function fromBehold(feed) {
  return {
    username: text(feed && feed.username, 60),
    posts: ((feed && feed.posts) || []).map((p) => ({
      id: text(p.id, 40),
      url: instagramUrl(p.permalink),
      image: https(p.sizes && p.sizes.medium && p.sizes.medium.mediaUrl) || https(p.mediaType === 'VIDEO' ? p.thumbnailUrl : p.mediaUrl),
      type: TYPES[p.mediaType] || 'image',
      caption: text(p.prunedCaption || p.caption, 300),
      alt: text(p.altText, 300),
      date: text(p.timestamp, 40)
    }))
  };
}

// Instagram's API: { data: [{ permalink, media_type, media_url, thumbnail_url, caption, timestamp }] }
function fromInstagram(page) {
  return {
    username: '',
    posts: ((page && page.data) || []).map((p) => ({
      id: text(p.id, 40),
      url: instagramUrl(p.permalink),
      // Videos have a still in thumbnail_url. media_url is left out for posts with licensed music, so those get skipped.
      image: https(p.media_type === 'VIDEO' ? p.thumbnail_url : p.media_url),
      type: TYPES[p.media_type] || 'image',
      caption: text(p.caption, 300),
      alt: '',
      date: text(p.timestamp, 40)
    }))
  };
}

function instagramFeed({ feedUrl, token, count = 3, store, fetch: f = fetch, log = console, now = Date.now }) {
  if (!feedUrl && !token) return null;
  let cache = null, cachedAt = 0, failedAt = 0, pending = null;
  let pictures = new Map(); // with a token: id -> { content, contentType }, for the posts in the cache

  // The token from Render, or the renewed one saved from it. If jo pastes a new token into Render, that one wins.
  const from = token ? crypto.createHash('sha256').update(token).digest('hex').slice(0, 16) : '';
  let current = null; // { token, from, renewedAt, triedAt }

  async function getJson(url, what) {
    const res = await f(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      const err = new Error(`${what} said ${res.status}: ${(await res.text()).slice(0, 200).replace(/access_token=[^&\s"]+/g, 'access_token=…')}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async function loadToken() {
    if (current) return current;
    let saved = null;
    try { saved = store && store.getSetting ? await store.getSetting('instagram') : null; } catch (err) { log.warn('Could not read the saved Instagram token:', err.message); }
    current = saved && saved.from === from && saved.token ? saved : { token, from, renewedAt: 0, triedAt: 0 };
    return current;
  }

  async function renew() {
    const t = now();
    if (t - (current.renewedAt || 0) < RENEW_MS || t - (current.triedAt || 0) < RENEW_RETRY_MS) return;
    current.triedAt = t;
    try {
      const out = await getJson(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(current.token)}`, 'Instagram (renewing the token)');
      if (!out.access_token) throw new Error('Instagram sent back no token');
      current = { token: out.access_token, from, renewedAt: t, triedAt: t };
      if (store && store.putSetting) await store.putSetting('instagram', current);
      log.info('Renewed the Instagram token.');
    } catch (err) {
      log.warn('Could not renew the Instagram token (it has to be a day old first):', err.message);
    }
  }

  async function fromApi() {
    const { token: t } = await loadToken();
    const fields = ['id', 'media_type', 'media_url', 'thumbnail_url', 'permalink', 'timestamp'];
    const ask = (withCaption) => getJson(`https://graph.instagram.com/me/media?fields=${[...fields, ...(withCaption ? ['caption'] : [])].join(',')}&limit=${count + 3}&access_token=${encodeURIComponent(t)}`, 'Instagram');
    let page;
    try { page = await ask(true); } catch (err) {
      if (err.status !== 400) throw err;
      page = await ask(false); // in case captions aren't allowed with this kind of token
    }
    renew().catch(() => {});
    return fromInstagram(page);
  }

  // Keep a copy of each picture. If one won't download, that post links to Instagram's own copy instead.
  async function keepPictures(posts) {
    const kept = new Map();
    await Promise.all(posts.map(async (p) => {
      if (!/^[0-9A-Za-z_]+$/.test(p.id)) return;
      try {
        const res = await f(p.image);
        const contentType = (res.headers && res.headers.get && res.headers.get('content-type')) || 'image/jpeg';
        if (!res.ok || !/^image\//.test(contentType)) throw new Error(`${res.status} ${contentType}`);
        const content = Buffer.from(await res.arrayBuffer());
        if (content.length > 8 * 1024 * 1024) throw new Error('too big');
        kept.set(p.id, { content, contentType });
        p.image = `/instagram/img/${p.id}`;
      } catch (err) {
        log.warn(`Could not copy the picture for Instagram post ${p.id}:`, err.message);
      }
    }));
    return kept;
  }

  async function fetchFeed() {
    const feed = feedUrl ? fromBehold(await getJson(feedUrl, 'Behold')) : await fromApi();
    const posts = feed.posts.filter((p) => p.url && p.image).slice(0, count);
    if (!feedUrl) pictures = await keepPictures(posts);
    return { username: feed.username, posts };
  }

  return {
    picture(id) { return pictures.get(id) || null; },
    async latest() {
      const t = now();
      if (cache && t - cachedAt < FRESH_MS) return cache;
      if (!cache && t - failedAt < RETRY_MS) throw new Error('Instagram failed a moment ago');
      if (!pending) {
        pending = fetchFeed()
          .then((feed) => { cache = feed; cachedAt = now(); return feed; })
          .catch((err) => { failedAt = now(); if (cache) cachedAt = now() - FRESH_MS + RETRY_MS; throw err; })
          .finally(() => { pending = null; });
      }
      try { return await pending; } catch (err) {
        if (cache) { log.warn('Using the last Instagram posts I had:', err.message); return cache; }
        throw err;
      }
    }
  };
}

module.exports = { instagramFeed, fromBehold, fromInstagram };

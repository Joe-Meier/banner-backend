// Where orders and live ads are kept. Both stores below have the same shape.
//   Orders: every checkout and its ad, with a status: unpaid → paid → live (or refunded, removed, expired).
//   Ads: what's on the banner right now. The site reads them from banner/ads.json.
//
// memoryStore() is for tests and trying things locally. githubStore() is for real: Render's free plan forgets
// everything whenever the server goes to sleep, so orders live in a private GitHub repo, and approved ads are
// committed straight into the site's repo (which also means the banner never waits on this server to show them).

const EXT_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

function memoryStore() {
  const orders = new Map(), images = new Map(), adImages = new Map();
  let ads = [];
  const copy = (o) => (o ? JSON.parse(JSON.stringify(o)) : null);
  return {
    async listOrders() { return [...orders.values()].map(copy); },
    async getOrder(id) { return copy(orders.get(id)); },
    async saveOrder(order) { orders.set(order.id, copy(order)); return copy(order); },
    async updateOrder(id, change) {
      if (!orders.has(id)) return null;
      const next = { ...orders.get(id), ...change };
      orders.set(id, copy(next));
      return copy(next);
    },
    async putImage(order, image) { images.set(order.id, image); },
    async getImage(order) { return images.get(order.id) || null; },
    async listAds() { return ads.map(copy); },
    async publishAd(ad, image) { adImages.set(ad.id, image); ads = [...ads.filter((a) => a.id !== ad.id), copy(ad)]; return ad; },
    async removeAd(id) { ads = ads.filter((a) => a.id !== id); adImages.delete(id); },
    adImages
  };
}

function githubStore({ token, ordersRepo, siteRepo, ordersBranch = 'main', siteBranch = 'main', fetch: f = fetch }) {
  if (!token || !ordersRepo || !siteRepo) throw new Error('githubStore needs a token, ordersRepo and siteRepo');
  const route = (repo, path) => `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  const api = (method, url, body, accept = 'application/vnd.github+json') => f('https://api.github.com' + url, {
    method,
    headers: {
      authorization: `Bearer ${token}`, accept, 'x-github-api-version': '2022-11-28', 'user-agent': 'banner-backend',
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const fail = async (res, what) => {
    const err = new Error(`GitHub said ${res.status} ${what}: ${(await res.text()).slice(0, 200)}`);
    err.status = res.status;
    return err;
  };

  async function readJson(repo, branch, path, fallback) {
    const res = await api('GET', `${route(repo, path)}?ref=${encodeURIComponent(branch)}`);
    if (res.status === 404) return { data: fallback, sha: undefined };
    if (!res.ok) throw await fail(res, `reading ${repo}/${path}`);
    const meta = await res.json();
    let text = meta.content != null && meta.encoding === 'base64' ? Buffer.from(meta.content, 'base64').toString('utf8') : null;
    if (text == null) text = await (await api('GET', `${route(repo, path)}?ref=${encodeURIComponent(branch)}`, null, 'application/vnd.github.raw+json')).text();
    return { data: JSON.parse(text), sha: meta.sha };
  }

  async function readRaw(repo, branch, path) {
    const res = await api('GET', `${route(repo, path)}?ref=${encodeURIComponent(branch)}`, null, 'application/vnd.github.raw+json');
    if (res.status === 404) return null;
    if (!res.ok) throw await fail(res, `reading ${repo}/${path}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async function write(repo, branch, path, content, message, sha) {
    const res = await api('PUT', route(repo, path), { message, content: content.toString('base64'), branch, ...(sha ? { sha } : {}) });
    if (!res.ok) throw await fail(res, `writing ${repo}/${path}`);
  }

  async function remove(repo, branch, path, message) {
    const res = await api('GET', `${route(repo, path)}?ref=${encodeURIComponent(branch)}`);
    if (res.status === 404) return;
    if (!res.ok) throw await fail(res, `finding ${repo}/${path}`);
    const { sha } = await res.json();
    const del = await api('DELETE', route(repo, path), { message, sha, branch });
    if (!del.ok && del.status !== 404) throw await fail(del, `deleting ${repo}/${path}`);
  }

  // Read, change, write back. If someone else wrote in between (GitHub answers 409), start over with the fresh copy.
  async function editJson(repo, branch, path, fallback, change, message) {
    for (let attempt = 0; ; attempt++) {
      const { data, sha } = await readJson(repo, branch, path, fallback);
      const next = change(data);
      if (next === undefined) return data;
      try {
        await write(repo, branch, path, Buffer.from(JSON.stringify(next, null, 2) + '\n'), message, sha);
        return next;
      } catch (err) {
        if (!(err.status === 409 || err.status === 422) || attempt >= 3) throw err;
      }
    }
  }

  const ORDERS = 'orders.json';
  const imagePath = (order) => `images/${order.id}.${order.image.ext}`;

  return {
    async listOrders() { return (await readJson(ordersRepo, ordersBranch, ORDERS, [])).data; },
    async getOrder(id) { return (await this.listOrders()).find((o) => o.id === id) || null; },
    async saveOrder(order) {
      await editJson(ordersRepo, ordersBranch, ORDERS, [], (all) => [...all.filter((o) => o.id !== order.id), order], `Order ${order.id}`);
      return order;
    },
    async updateOrder(id, change) {
      let found = null;
      await editJson(ordersRepo, ordersBranch, ORDERS, [], (all) => {
        const i = all.findIndex((o) => o.id === id);
        if (i < 0) return undefined;
        found = { ...all[i], ...change };
        return all.map((o, j) => (j === i ? found : o));
      }, `Order ${id}: ${change.status || 'update'}`);
      return found;
    },
    async putImage(order, image) {
      await write(ordersRepo, ordersBranch, imagePath(order), image.content, `Ad for order ${order.id}`);
    },
    async getImage(order) {
      const content = await readRaw(ordersRepo, ordersBranch, imagePath(order));
      return content && { content, contentType: EXT_TYPES[order.image.ext], ext: order.image.ext };
    },
    async listAds() { return (await readJson(siteRepo, siteBranch, 'banner/ads.json', [])).data; },
    async publishAd(ad, image) {
      try {
        await write(siteRepo, siteBranch, ad.image, image.content, `Banner: ${ad.name || ad.id}'s ad`);
      } catch (err) {
        if (err.status !== 422) throw err; // 422: already there from an earlier try
      }
      await editJson(siteRepo, siteBranch, 'banner/ads.json', [], (ads) => [...ads.filter((a) => a.id !== ad.id), ad], `Banner: put up ${ad.name || ad.id}`);
      return ad;
    },
    async removeAd(id) {
      let gone = null;
      await editJson(siteRepo, siteBranch, 'banner/ads.json', [], (ads) => {
        gone = ads.find((a) => a.id === id);
        return gone ? ads.filter((a) => a.id !== id) : undefined;
      }, `Banner: take down ${id}`);
      if (gone && gone.image) await remove(siteRepo, siteBranch, gone.image, `Banner: remove ${id}'s image`);
    }
  };
}

module.exports = { memoryStore, githubStore, EXT_TYPES };

// GrowthZone REST client: ApiKey auth, throttling, retry with backoff, and paging.
// Docs: https://integration.growthzone.com/growthzone-api/  (base: https://{db}.growthzoneapp.com/api)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GrowthZoneClient {
  constructor({ baseUrl, apiKey, requestsPerSecond = 5, fetchImpl = fetch, maxRetries = 4 } = {}) {
    if (!baseUrl) throw new Error('GZ_BASE_URL is not set');
    if (!apiKey) throw new Error('GZ_API_KEY is not set (see .env.example)');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.minGapMs = Math.ceil(1000 / requestsPerSecond);
    this.fetch = fetchImpl;
    this.maxRetries = maxRetries;
    this.last = 0;
    this.calls = 0;
  }

  async request(method, path, { query, body } = {}) {
    const url = new URL(this.baseUrl + (path.startsWith('/') ? path : `/${path}`));
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined) url.searchParams.set(k, v);

    for (let attempt = 0; ; attempt++) {
      const wait = this.last + this.minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      this.calls++;

      const res = await this.fetch(url, {
        method,
        headers: {
          Authorization: `ApiKey ${this.apiKey}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (res.status === 429 || res.status >= 500) {
        if (attempt >= this.maxRetries) throw new Error(`GrowthZone ${method} ${path}: HTTP ${res.status} after ${attempt + 1} attempts`);
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
        continue;
      }
      if (res.status === 404) return null;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`GrowthZone ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }
  }

  get(path, query) { return this.request('GET', path, { query }); }
  post(path, body, query) { return this.request('POST', path, { body, query }); }

  /** Collect every page of a paged endpoint ({ TotalRecordAvailable, Results }). */
  async all(fetchPage, pageSize = 100) {
    const out = [];
    for (let page = 1; page < 10_000; page++) {
      const data = await fetchPage(page, pageSize);
      const rows = Array.isArray(data) ? data : data?.Results || [];
      out.push(...rows);
      const total = data?.TotalRecordAvailable;
      if (rows.length < pageSize || (Number.isFinite(total) && out.length >= total)) break;
    }
    return out;
  }
}

export function clientFromEnv(cfg = {}) {
  return new GrowthZoneClient({
    baseUrl: process.env.GZ_BASE_URL,
    apiKey: process.env.GZ_API_KEY,
    requestsPerSecond: cfg.requestsPerSecond,
  });
}

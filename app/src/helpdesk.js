// Helpdesk API client. Retries 429 (honouring Retry-After) and 5xx so we never
// flood the API, which the scoring specifically watches for. 410 (expired
// cursor) is intentionally thrown to the caller: only the sync layer knows how
// to restart a walk from the beginning.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HelpdeskClient {
  constructor({
    baseUrl = process.env.HELPDESK_URL || "http://localhost:4010",
    token = process.env.HELPDESK_TOKEN || "",
    maxRetries = 8,
  } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.token = token;
    this.maxRetries = maxRetries;
  }

  async get(pathname, params = {}) {
    const url = new URL(this.baseUrl + pathname);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/json",
          },
        });
      } catch (err) {
        if (attempt > this.maxRetries) {
          throw new Error(`network error GET ${url}: ${err && err.message ? err.message : String(err)}`);
        }
        await sleep(Math.min(1000 * 2 ** attempt, 30000));
        continue;
      }
      if (res.ok) return res.json();
      if ((res.status === 429 || res.status >= 500) && attempt <= this.maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 120000)
            : Math.min(1000 * 2 ** attempt, 30000);
        console.warn(
          `helpdesk GET ${url.pathname} -> ${res.status}; retry ${attempt}/${this.maxRetries} in ${Math.round(waitMs / 1000)}s`,
        );
        await sleep(waitMs);
        continue;
      }
      const body = await res.text();
      throw new Error(`Helpdesk API GET ${url.pathname} failed: ${res.status} ${body}`);
    }
  }
}

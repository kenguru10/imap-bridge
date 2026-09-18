class WorkerClient {
  constructor(baseUrl) {
    this.baseUrl = (baseUrl || '').replace(/\/$/, '');
    this.token = null;
  }

  async login(email, password) {
    const res = await fetch(`${this.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const json = await res.json();
    if (json.code !== 200) {
      throw new Error(json.message || 'Login failed');
    }

    this.token = json.data.token;
    return json.data;
  }

  async request(path, opts = {}) {
    if (!this.token) {
      throw new Error('Not authenticated');
    }

    const url = `${this.baseUrl}/api${path}`;
    const res = await fetch(url, {
      ...opts,
      headers: {
        Authorization: this.token,
        ...(opts.headers || {}),
      },
    });

    const json = await res.json();
    if (json.code !== 200) {
      throw new Error(json.message || `API error: ${path}`);
    }

    return json.data;
  }

  async fetchBuffer(url) {
    const res = await fetch(url, {
      headers: this.token ? { Authorization: this.token } : {},
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch attachment: ${res.status} ${url}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  // Fetch every page of accounts.
  async listAllAccounts() {
    const accounts = [];
    let accountId = 0;
    let lastSort = 9999999999;
    while (true) {
      const page = await this.request(`/account/list?accountId=${accountId}&size=30&lastSort=${lastSort}`);
      if (!page || !page.length) break;
      accounts.push(...page);
      const last = page[page.length - 1];
      accountId = last.accountId;
      lastSort = last.sort;
      if (page.length < 30) break;
    }
    return accounts;
  }

  async listEmails(params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    return this.request(`/email/list?${qs.toString()}`);
  }

  async latestEmails(params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    return this.request(`/email/latest?${qs.toString()}`);
  }

  async readEmails(emailIds) {
    return this.request('/email/read', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailIds: emailIds.join(',') }),
    });
  }

  async deleteEmails(emailIds) {
    return this.request(`/email/delete?emailIds=${emailIds.join(',')}`, {
      method: 'DELETE',
    });
  }

  async sendEmail(payload) {
    return this.request('/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }
}

module.exports = WorkerClient;

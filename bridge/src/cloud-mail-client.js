import config from './config.js';

// One client (and one cached token) per Cloud Mail login.
// Single-login setups keep using the default `cloudMail` export.
export class CloudMailClient {
  constructor(credentials) {
    const creds = credentials || config.cloudMail;
    this.apiBaseUrl = (creds.apiBaseUrl || config.cloudMail.apiBaseUrl).replace(/\/$/, '');
    this.baseUrl = (creds.baseUrl || config.cloudMail.baseUrl || this.apiBaseUrl.replace(/\/api$/, '')).replace(/\/$/, '');
    this.email = creds.email;
    this.password = creds.password;
    this.token = null;
    this.tokenExpiry = 0;
  }

  async request(path, options = {}) {
    const url = `${this.apiBaseUrl}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers
    };

    if (options.requireAuth !== false) {
      const token = await this.getToken();
      headers['Authorization'] = token;
    }

    const response = await fetch(url, {
      ...options,
      headers
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Cloud Mail API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    if (data && data.code !== undefined && data.code !== 200) {
      throw new Error(`Cloud Mail business error: ${data.message || JSON.stringify(data)}`);
    }
    return data;
  }

  async getToken() {
    if (this.token && this.tokenExpiry > Date.now() + 60000) {
      return this.token;
    }

    const result = await this.request('/login', {
      method: 'POST',
      body: JSON.stringify({ email: this.email, password: this.password }),
      requireAuth: false
    });

    this.token = result.data?.token || result.token;
    if (!this.token) {
      throw new Error(`Login failed for ${this.email}: no token in response`);
    }

    // Tokens are typically valid for 24h; refresh after 23h
    this.tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
    return this.token;
  }

  async listAccounts(params = {}) {
    const query = new URLSearchParams({ size: '30', ...params }).toString();
    return this.request(`/account/list?${query}`);
  }

  async listEmails(params = {}) {
    const query = new URLSearchParams({ size: '50', type: '0', ...params }).toString();
    return this.request(`/email/list?${query}`);
  }

  async latestEmails(params = {}) {
    const query = new URLSearchParams({ size: '50', type: '0', ...params }).toString();
    return this.request(`/email/latest?${query}`);
  }

  async markRead(emailIds) {
    return this.request('/email/read', {
      method: 'PUT',
      body: JSON.stringify({ emailIds: emailIds.map(id => Number(id)) })
    });
  }

  async deleteEmail(emailIds) {
    return this.request('/email/delete', {
      method: 'DELETE',
      body: JSON.stringify({ emailIds: emailIds.join(',') })
    });
  }

  async sendEmail(body) {
    return this.request('/email/send', {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }

  async listAttachments(params) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/email/attList?${query}`);
  }

  async fetchAttachment(key) {
    const url = `${this.baseUrl}/oss/${encodeURIComponent(key)}`;
    const token = await this.getToken();
    const response = await fetch(url, {
      headers: { Authorization: token }
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch attachment ${key}: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

// Default client for the primary (config.cloudMail) login
export const cloudMail = new CloudMailClient();

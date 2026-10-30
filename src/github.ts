import { createSign } from "node:crypto";

// Pushes from builds go through a GitHub App the developer installs on their repository. For each build
// Mynt mints an installation token limited to that one repository, with contents and pull-request write
// access, valid for an hour; no long-lived credential reaches the build sandbox.

export interface RepoAccess {
  installationFor(repo: string): Promise<number | null>;
  tokenFor(repo: string, installationId: number): Promise<{ token: string; expires_at: string }>;
  installUrl(): string;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

export class GitHubApp implements RepoAccess {
  constructor(
    private readonly appId: string,
    private readonly privateKey: string,
    private readonly slug: string,
    private readonly api = "https://api.github.com",
  ) {}

  static fromEnv(env = process.env): GitHubApp | null {
    if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY || !env.GITHUB_APP_SLUG) return null;
    return new GitHubApp(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"), env.GITHUB_APP_SLUG);
  }

  private jwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.appId }));
    const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(this.privateKey);
    return `${head}.${body}.${b64url(sig)}`;
  }

  private async call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${this.api}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.jwt()}`, Accept: "application/vnd.github+json", "User-Agent": "mynt", "X-GitHub-Api-Version": "2022-11-28" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: res.status === 204 ? {} : await res.json() };
  }

  async installationFor(repo: string) {
    const r = await this.call("GET", `/repos/${repo}/installation`);
    return r.status === 200 ? (r.data as { id: number }).id : null;
  }

  async tokenFor(repo: string, installationId: number) {
    const name = repo.split("/")[1];
    const r = await this.call("POST", `/app/installations/${installationId}/access_tokens`, {
      repositories: [name],
      permissions: { contents: "write", pull_requests: "write" },
    });
    if (r.status !== 201) throw new Error(`GitHub refused a token for ${repo} (${r.status})`);
    return r.data as { token: string; expires_at: string };
  }

  installUrl() {
    return `https://github.com/apps/${this.slug}/installations/new`;
  }
}

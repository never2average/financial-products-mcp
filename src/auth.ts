import { createClerkClient } from "@clerk/backend";
import type { Store, User } from "./store.js";

// The parts of Clerk's backend client this server uses, so tests can provide a stand-in.
export interface ClerkLike {
  idPOAuthAccessToken: {
    verify(token: string, options?: { audience?: string | string[] }): Promise<{ subject: string; revoked: boolean; expired: boolean }>;
  };
  users: {
    getUser(userId: string): Promise<{
      firstName: string | null;
      lastName: string | null;
      primaryEmailAddressId: string | null;
      emailAddresses: { id: string; emailAddress: string; verification: { status: string } | null }[];
    }>;
  };
}

export interface ClerkAuthConfig {
  secretKey: string;
  publishableKey: string;
  publicUrl: string; // e.g. https://mcp.example.com
  requireAudience: boolean; // tokens must be issued for this server's /mcp resource
}

export type AuthResult =
  | { ok: true; user: User }
  | { ok: false; status: 401 | 403; error: "invalid_token" | "not_whitelisted"; message: string };

// pk_test_<base64("<frontend-api-host>$")>
export function frontendApiFromPublishableKey(publishableKey: string): string {
  const encoded = publishableKey.split("_")[2] ?? "";
  const host = Buffer.from(encoded, "base64").toString("utf8").replace(/\$$/, "");
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error("CLERK_PUBLISHABLE_KEY is not a valid Clerk publishable key");
  return host;
}

export function clerkConfigFromEnv(env = process.env): ClerkAuthConfig | null {
  if (!env.CLERK_SECRET_KEY) return null;
  if (!env.CLERK_PUBLISHABLE_KEY || !env.PUBLIC_URL) throw new Error("Clerk auth needs CLERK_PUBLISHABLE_KEY and PUBLIC_URL as well");
  return {
    secretKey: env.CLERK_SECRET_KEY,
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
    publicUrl: env.PUBLIC_URL.replace(/\/+$/, ""),
    requireAudience: env.MCP_REQUIRE_AUDIENCE !== "false",
  };
}

// Whitelist auth: Clerk proves who the caller is (OAuth access token); the invites table decides
// whether they may use the server and with which roles. Clerk's own allowlist is kept in step by
// the CLI so people who aren't invited can't sign up in the first place.
export class ClerkAuth {
  readonly issuer: string;
  readonly resource: string;

  constructor(
    private readonly config: ClerkAuthConfig,
    private readonly store: Store,
    private readonly clerk: ClerkLike = createClerkClient({ secretKey: config.secretKey, publishableKey: config.publishableKey }) as never,
  ) {
    this.issuer = `https://${frontendApiFromPublishableKey(config.publishableKey)}`;
    this.resource = `${config.publicUrl}/mcp`;
  }

  get resourceMetadataUrl(): string {
    return `${this.config.publicUrl}/.well-known/oauth-protected-resource/mcp`;
  }

  // RFC 9728: tells MCP clients that Clerk is the authorization server for this resource.
  protectedResourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["openid", "profile", "email"],
      resource_name: "financial-products MCP",
    };
  }

  async authenticate(token: string): Promise<AuthResult> {
    let subject: string;
    try {
      const t = await this.clerk.idPOAuthAccessToken.verify(token, this.config.requireAudience ? { audience: this.resource } : undefined);
      if (t.revoked || t.expired) throw new Error("token revoked or expired");
      subject = t.subject;
    } catch {
      return { ok: false, status: 401, error: "invalid_token", message: "The access token is invalid, expired or not issued for this server" };
    }

    const linked = await this.store.userByClerkId(subject);
    let email = linked?.email ?? null;
    let name = linked?.name ?? "";
    if (!email) {
      const u = await this.clerk.users.getUser(subject);
      // Only a verified address counts, primary first.
      const verified = u.emailAddresses.filter((e) => e.verification?.status === "verified");
      const primary = verified.find((e) => e.id === u.primaryEmailAddressId) ?? verified[0];
      email = primary?.emailAddress.toLowerCase() ?? null;
      name = [u.firstName, u.lastName].filter(Boolean).join(" ") || email || "user";
    }

    const invite = email ? await this.store.getInvite(email) : undefined;
    if (!email || !invite) {
      return { ok: false, status: 403, error: "not_whitelisted", message: "Your account is not on this server's whitelist" };
    }
    if (linked && linked.roles.join() === invite.roles.join()) return { ok: true, user: linked };
    return { ok: true, user: await this.store.upsertClerkUser(subject, email, name, invite.roles) };
  }
}

// Clerk Backend API calls used by `clerk setup` and the whitelist CLI.
export class ClerkAdmin {
  private readonly api = "https://api.clerk.com/v1";
  constructor(private readonly secretKey: string) {}

  private async call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${this.api}${path}`, {
      method,
      // Clerk's edge refuses some default client User-Agents.
      headers: { Authorization: `Bearer ${this.secretKey}`, "Content-Type": "application/json", "User-Agent": "financial-products-mcp" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error(data?.errors?.[0]?.long_message ?? data?.errors?.[0]?.message ?? `Clerk API ${res.status}`);
      (err as Error & { status?: number; code?: string }).status = res.status;
      (err as Error & { status?: number; code?: string }).code = data?.errors?.[0]?.code;
      throw err;
    }
    return data;
  }

  // Idempotent: allowlist on, dynamic client registration (how MCP clients register), PKCE required,
  // and audience claims so a token is bound to the resource it was issued for.
  // Returns warnings: Clerk's allowlist is a second layer (the invites table always decides), so a plan
  // without it doesn't stop the setup.
  async setup(): Promise<string[]> {
    const warnings: string[] = [];
    try {
      await this.call("PATCH", "/instance/restrictions", { allowlist: true });
    } catch (e) {
      warnings.push(`Clerk allowlist not enabled (${(e as Error).message}); the server's own whitelist still applies`);
    }
    await this.call("PATCH", "/instance/oauth_application_settings", {
      dynamic_oauth_client_registration: true,
      pkce_required: true,
      aud_claim_enabled: true,
    });
    return warnings;
  }

  // Best effort: the invite is what grants access; Clerk's allowlist only stops other sign-ups.
  async allow(email: string): Promise<string | null> {
    try {
      await this.call("POST", "/allowlist_identifiers", { identifier: email.toLowerCase(), notify: false });
      return null;
    } catch (e) {
      // Clerk reports an existing entry with varying status codes; the message is what's stable.
      if ((e as { status?: number }).status === 409 || /already exists|taken|duplicate/i.test((e as Error).message)) return null;
      return `not added to Clerk's allowlist (${(e as Error).message})`;
    }
  }

  async disallow(email: string): Promise<void> {
    const list = (await this.call("GET", "/allowlist_identifiers?limit=500")) as { id: string; identifier: string }[] | { data: { id: string; identifier: string }[] };
    const items = Array.isArray(list) ? list : list.data;
    for (const item of items.filter((i) => i.identifier.toLowerCase() === email.toLowerCase())) {
      await this.call("DELETE", `/allowlist_identifiers/${item.id}`);
    }
  }
}

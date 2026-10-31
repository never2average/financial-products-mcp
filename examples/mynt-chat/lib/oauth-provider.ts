import { randomBytes } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Session, SessionStore } from "./session-store";

// The MCP SDK's OAuth hooks, backed by one server-side session.
//
// The SDK does the protocol: it reads Mynt's protected-resource metadata, finds the
// authorization server (Clerk), registers this app dynamically, and runs the authorization-code
// flow with PKCE. This class only stores what the SDK hands it. Instead of redirecting a
// browser itself (there is none on the server), it remembers the authorization URL so the
// login route can send a 302.
export class SessionOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL;

  constructor(
    private session: Session,
    private store: SessionStore,
    readonly redirectUrl: string,
    private scope: string,
  ) {}

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Mynt chat (sample)",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none", // a public client: PKCE, no client secret
      scope: this.scope,
    };
  }

  state(): string {
    this.session.oauthState = randomBytes(24).toString("base64url");
    return this.session.oauthState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.store.clientInformation(this.redirectUrl);
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.store.saveClientInformation(this.redirectUrl, info);
  }

  tokens(): OAuthTokens | undefined {
    return this.session.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.session.tokens = tokens;
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string): void {
    this.session.codeVerifier = verifier;
  }

  codeVerifier(): string {
    if (!this.session.codeVerifier) throw new Error("No PKCE code verifier for this session; start sign-in again");
    return this.session.codeVerifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "client") this.store.forgetClient(this.redirectUrl);
    if (scope === "all" || scope === "tokens") this.session.tokens = undefined;
    if (scope === "all" || scope === "verifier") this.session.codeVerifier = undefined;
  }
}

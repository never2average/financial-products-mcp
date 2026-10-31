import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import { appUrl, oauthRedirectUrl, oauthScope, secureCookies } from "./config";
import { SessionOAuthProvider } from "./oauth-provider";
import { SESSION_COOKIE, sessionStore, type Session } from "./session-store";

export async function currentSession(): Promise<Session | undefined> {
  const jar = await cookies();
  return sessionStore().get(jar.get(SESSION_COOKIE)?.value);
}

export async function currentOrNewSession(): Promise<{ session: Session; isNew: boolean }> {
  const existing = await currentSession();
  if (existing) return { session: existing, isNew: false };
  return { session: sessionStore().create(), isNew: true };
}

export function setSessionCookie(res: NextResponse, session: Session): void {
  res.cookies.set(SESSION_COOKIE, session.id, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax", // sent on the top-level redirect back from the authorization server
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure: secureCookies(), sameSite: "lax", path: "/", maxAge: 0 });
}

// State-changing requests must come from this app's own pages. SameSite=Lax already keeps the
// cookie off cross-site POSTs; this also rejects a request whose Origin is someone else's.
export function fromOwnOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  return origin === null || origin === appUrl().origin;
}

// Tells Claude about something the user did outside the chat (tapped Accept, sent a
// request). Queued and sent with the next message rather than written into the history now, so
// it can never land in the middle of a turn's tool calls.
export function queueAppEvent(session: Session, text: string): void {
  session.pendingEvents.push(`[App event, not typed by the user] ${text}`);
}

export function oauthProviderFor(session: Session): SessionOAuthProvider {
  return new SessionOAuthProvider(session, sessionStore(), oauthRedirectUrl(), oauthScope());
}

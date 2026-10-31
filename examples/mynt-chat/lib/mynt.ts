import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { myntMcpUrl } from "./config";
import { oauthProviderFor } from "./session";
import type { Session } from "./session-store";

export class NotSignedInError extends Error {
  constructor() {
    super("Sign in to Mynt to continue");
  }
}

// Mynt tools this app offers to Claude. Tools that act for the user are deliberately absent:
// enrolment (enroll_in_product and friends) only happens when the user taps "Accept" on a
// card, and request_product only when they tap "Send request" on a proposed request, never on
// the model's say-so. Tools the signed-in user doesn't have are simply not listed by Mynt.
export const CHAT_TOOLS = new Set([
  "whoami",
  "list_products",
  "get_product",
  "get_product_regime",
  "list_categories",
  "list_regions",
  "list_product_categories",
  "list_offers",
  "list_my_enrollments",
  "list_my_product_requests",
]);

// A connected MCP client for this session, using its stored OAuth tokens (refreshed by the SDK
// when they expire). Call close() when done.
export async function connectMynt(session: Session): Promise<Client> {
  if (!session.tokens) throw new NotSignedInError();
  const transport = new StreamableHTTPClientTransport(myntMcpUrl(), { authProvider: oauthProviderFor(session) });
  const client = new Client({ name: "mynt-chat", version: "0.1.0" });
  try {
    await client.connect(transport);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      session.tokens = undefined;
      throw new NotSignedInError();
    }
    throw err;
  }
  return client;
}

export async function listChatTools(client: Client): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools.filter((t) => CHAT_TOOLS.has(t.name)));
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

export interface ToolOutcome {
  isError: boolean;
  text: string; // the tool's text content, as Mynt returned it
}

export async function callMyntTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const result = await client.callTool({ name, arguments: args });
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((c: { type: string; text?: string }) => (c.type === "text" && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
  return { isError: result.isError === true, text: text || JSON.stringify(result.structuredContent ?? {}) };
}

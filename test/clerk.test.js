import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { ClerkAuth, frontendApiFromPublishableKey } from "../dist/auth.js";
import { createMcpHttpServer } from "../dist/http.js";
import { Store } from "../dist/store.js";

const PUBLISHABLE_KEY = `pk_test_${Buffer.from("fpm-test.clerk.accounts.dev$").toString("base64")}`;
const PUBLIC_URL = "https://mcp.example.com";

// A stand-in for Clerk: tokens map to Clerk users; verify records the audience it was asked for.
function fakeClerk() {
  const tokens = new Map();
  const users = new Map();
  const audiences = [];
  return {
    audiences,
    addUser(id, email, { verified = true, token = `oat_${id}` } = {}) {
      users.set(id, {
        firstName: id,
        lastName: null,
        primaryEmailAddressId: `e_${id}`,
        emailAddresses: [{ id: `e_${id}`, emailAddress: email, verification: { status: verified ? "verified" : "unverified" } }],
      });
      tokens.set(token, { subject: id, revoked: false, expired: false });
      return token;
    },
    idPOAuthAccessToken: {
      async verify(token, options) {
        audiences.push(options?.audience);
        const t = tokens.get(token);
        if (!t) throw new Error("invalid");
        return t;
      },
    },
    users: {
      async getUser(id) {
        return users.get(id);
      },
    },
  };
}

async function setup() {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() });
  const clerk = fakeClerk();
  const auth = new ClerkAuth({ secretKey: "sk_test_x", publishableKey: PUBLISHABLE_KEY, publicUrl: PUBLIC_URL, requireAudience: true }, store, clerk);
  const http = createMcpHttpServer(store, auth).listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  const base = `http://127.0.0.1:${http.address().port}`;
  const rpc = (method, params = {}, token) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  const tools = async (token) => {
    const res = await rpc("tools/list", {}, token);
    assert.equal(res.status, 200);
    const text = await res.text();
    return JSON.parse(text.match(/^data: (.*)$/m)?.[1] ?? text).result.tools.map((t) => t.name);
  };
  return { store, clerk, base, rpc, tools, close: () => http.close() };
}

test("decodes the Clerk frontend API host from the publishable key", () => {
  assert.equal(frontendApiFromPublishableKey(PUBLISHABLE_KEY), "fpm-test.clerk.accounts.dev");
});

test("publishes protected-resource metadata pointing at Clerk", async () => {
  const { base, close } = await setup();
  try {
    const meta = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(meta.resource, `${PUBLIC_URL}/mcp`);
    assert.deepEqual(meta.authorization_servers, ["https://fpm-test.clerk.accounts.dev"]);
  } finally {
    close();
  }
});

test("requests without a token get a 401 that points clients at the metadata", async () => {
  const { rpc, close } = await setup();
  try {
    const res = await rpc("tools/list");
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate"), /resource_metadata="https:\/\/mcp\.example\.com\/\.well-known\/oauth-protected-resource\/mcp"/);
  } finally {
    close();
  }
});

test("invalid tokens and local fpm_ tokens are refused with invalid_token", async () => {
  const { store, rpc, close } = await setup();
  try {
    assert.equal((await rpc("tools/list", {}, "oat_nope")).status, 401);
    const { token } = await store.createUser("Local", ["innovator"]);
    const res = await rpc("tools/list", {}, token);
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate"), /error="invalid_token"/);
  } finally {
    close();
  }
});

test("a signed-in user who is not whitelisted gets 403", async () => {
  const { clerk, rpc, close } = await setup();
  try {
    const token = clerk.addUser("u1", "stranger@example.com");
    const res = await rpc("tools/list", {}, token);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "not_whitelisted");
  } finally {
    close();
  }
});

test("an unverified email does not match the whitelist", async () => {
  const { store, clerk, rpc, close } = await setup();
  try {
    await store.upsertInvite("pending@example.com", ["consumer"]);
    const token = clerk.addUser("u2", "pending@example.com", { verified: false });
    assert.equal((await rpc("tools/list", {}, token)).status, 403);
  } finally {
    close();
  }
});

test("whitelisted users get their invite's roles; changes and revocation apply on the next request", async () => {
  const { store, clerk, tools, rpc, close } = await setup();
  try {
    await store.upsertInvite("Ines@Example.com", ["consumer"]);
    const token = clerk.addUser("u3", "ines@example.com");

    const first = await tools(token);
    assert.ok(first.includes("enroll_in_product"));
    assert.ok(!first.includes("create_app") && !first.includes("create_product"));
    assert.deepEqual(clerk.audiences.at(-1), `${PUBLIC_URL}/mcp`, "tokens must be issued for this resource");

    await store.upsertInvite("ines@example.com", ["innovator"]);
    const promoted = await tools(token);
    assert.ok(["enroll_in_product", "create_app", "create_product"].every((t) => promoted.includes(t)), "innovator includes everything");
    assert.equal((await store.listUsers()).filter((u) => u.email === "ines@example.com").length, 1, "one linked user");

    await store.deleteInvite("ines@example.com");
    assert.equal((await rpc("tools/list", {}, token)).status, 403);
  } finally {
    close();
  }
});

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { seal, open } from "./vault.js";

// Hosted runtime: developers' apps (their financial part: the server that holds the app key, calls
// contract actions and handles webhooks) run on an isolated VM per developer, built from the exact commit
// Mynt verified. A VM is never reachable from the internet and never on the platform's network:
//
// - It boots, installs Docker, gVisor and WireGuard, generates its own WireGuard key (the private key never
//   leaves it), and registers with a one-time bootstrap token. Mynt gives it a tunnel address and an agent
//   token, and locks its cloud firewall down to WireGuard to the gateway, nothing else, in or out.
// - All its traffic goes through the tunnel. The gateway (on the platform host) only routes it to Mynt's
//   runtime API and the hosts the app's products declare (their hand-off URLs): the egress allowlist.
// - Its agent polls its policy over the tunnel: which apps to run, at which verified commit, with a
//   short-lived read-only token to fetch that commit and the app's dedicated key. Apps run under gVisor,
//   read-only, without capabilities, on 127.0.0.1; customers reach them through Mynt's edge and the tunnel.
// - The kill switch (an admin suspends a tenant, or a developer undeploys) drops the tenant from the
//   gateway's peers, routes and allowlist at once and powers its VM off.

export const TENANT_STATUSES = ["provisioning", "running", "suspended", "failed"] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];
const TUNNEL_PREFIX = "10.88"; // tenants get 10.88.x.y/32; the gateway is 10.88.0.1
const GATEWAY_TUNNEL_IP = `${TUNNEL_PREFIX}.0.1`;
const PROXY_PORT = 8888; // the gateway's egress proxy (CONNECT to allowlisted hosts only)

export interface VmSpec {
  name: string;
  region: string;
  size: string;
  userData: string;
  tags: string[];
}
export interface HostingProvider {
  readonly name: string;
  createVm(spec: VmSpec): Promise<{ id: string }>;
  // Inbound: nothing. Outbound: WireGuard (UDP) to the gateway only.
  lockDown(vmId: string, gatewayIp: string, wireguardPort: number): Promise<void>;
  powerOff(vmId: string): Promise<void>;
  powerOn(vmId: string): Promise<void>;
  deleteVm(vmId: string): Promise<void>;
}

// DigitalOcean: one droplet per tenant, tagged, with its own cloud firewall once it has registered.
export class DigitalOceanProvider implements HostingProvider {
  readonly name = "digitalocean";
  constructor(
    private readonly token: string,
    private readonly opts: { image?: string; fetch?: typeof fetch } = {},
  ) {}

  private async call(method: string, path: string, body?: unknown) {
    const res = await (this.opts.fetch ?? fetch)(`https://api.digitalocean.com/v2${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`DigitalOcean ${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }

  async createVm(spec: VmSpec) {
    const r = await this.call("POST", "/droplets", {
      name: spec.name,
      region: spec.region,
      size: spec.size,
      image: this.opts.image ?? "ubuntu-24-04-x64",
      user_data: spec.userData,
      tags: spec.tags,
      ipv6: false,
      monitoring: true,
    });
    return { id: String(r.droplet.id) };
  }

  async lockDown(vmId: string, gatewayIp: string, wireguardPort: number) {
    await this.call("POST", "/firewalls", {
      name: `mynt-tenant-${vmId}`,
      inbound_rules: [],
      outbound_rules: [{ protocol: "udp", ports: String(wireguardPort), destinations: { addresses: [`${gatewayIp}/32`] } }],
      droplet_ids: [Number(vmId)],
    });
  }

  async powerOff(vmId: string) {
    await this.call("POST", `/droplets/${vmId}/actions`, { type: "power_off" });
  }

  async powerOn(vmId: string) {
    await this.call("POST", `/droplets/${vmId}/actions`, { type: "power_on" });
  }

  async deleteVm(vmId: string) {
    await this.call("DELETE", `/droplets/${vmId}`);
  }
}

export interface HostingConfig {
  publicUrl: string; // where VMs reach Mynt (bootstrap, policy) through the tunnel
  gatewayEndpoint: string; // host:port of the gateway's WireGuard
  gatewayPublicKey: string;
  gatewayIp: string; // the gateway's public IP, the only address tenants may send to
  region: string;
  size: string;
  appsDomain: string | null; // apps are served at <app>.<appsDomain>
}

export function hostingConfigFromEnv(env = process.env): HostingConfig | null {
  const need = ["HOSTING_GATEWAY_ENDPOINT", "HOSTING_GATEWAY_PUBLIC_KEY", "PUBLIC_URL"];
  if (need.some((k) => !env[k])) return null;
  const endpoint = env.HOSTING_GATEWAY_ENDPOINT!;
  return {
    publicUrl: env.PUBLIC_URL!.replace(/\/+$/, ""),
    gatewayEndpoint: endpoint,
    gatewayPublicKey: env.HOSTING_GATEWAY_PUBLIC_KEY!,
    gatewayIp: env.HOSTING_GATEWAY_IP ?? endpoint.split(":")[0],
    region: env.HOSTING_REGION ?? "blr1",
    size: env.HOSTING_SIZE ?? "s-1vcpu-2gb",
    appsDomain: env.HOSTING_APPS_DOMAIN ?? null,
  };
}

export function hostingProviderFromEnv(env = process.env): HostingProvider | null {
  return env.HOSTING_DO_TOKEN ? new DigitalOceanProvider(env.HOSTING_DO_TOKEN, { image: env.HOSTING_DO_IMAGE }) : null;
}

export interface Tenant {
  id: string;
  developer_id: string;
  provider: string;
  vm_id: string | null;
  status: TenantStatus;
  tunnel_ip: string | null;
  wg_public_key: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}
export interface HostedApp {
  app_id: string;
  tenant_id: string;
  build_id: string;
  repository: string;
  commit_sha: string;
  port: number;
  status: "deploying" | "running" | "stopped";
  updated_at: string;
}

const TABLES = `
  CREATE TABLE IF NOT EXISTS financial_products.hosting_tenants (
    id uuid PRIMARY KEY,
    developer_id uuid NOT NULL UNIQUE REFERENCES financial_products.users(id),
    provider text NOT NULL,
    vm_id text,
    status text NOT NULL CHECK (status IN ('provisioning', 'running', 'suspended', 'failed')),
    tunnel_index integer UNIQUE,
    wg_public_key text UNIQUE,
    bootstrap_hash text,
    bootstrap_expires_at timestamptz,
    agent_hash text UNIQUE,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS financial_products.hosted_apps (
    app_id uuid PRIMARY KEY REFERENCES financial_products.apps(id),
    tenant_id uuid NOT NULL REFERENCES financial_products.hosting_tenants(id),
    build_id uuid NOT NULL,
    repository text NOT NULL,
    commit_sha text NOT NULL,
    port integer NOT NULL,
    app_key_sealed text NOT NULL,
    status text NOT NULL CHECK (status IN ('deploying', 'running', 'stopped')),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, port)
  );
`;

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const tunnelIp = (index: number | null) => (index == null ? null : `${TUNNEL_PREFIX}.${Math.floor(index / 250) + 1}.${(index % 250) + 2}`);
const toTenant = (r: Record<string, unknown>): Tenant => ({
  id: r.id as string,
  developer_id: r.developer_id as string,
  provider: r.provider as string,
  vm_id: (r.vm_id as string | null) ?? null,
  status: r.status as TenantStatus,
  tunnel_ip: tunnelIp((r.tunnel_index as number | null) ?? null),
  wg_public_key: (r.wg_public_key as string | null) ?? null,
  error: (r.error as string | null) ?? null,
  created_at: iso(r.created_at)!,
  updated_at: iso(r.updated_at)!,
});
const toHostedApp = (r: Record<string, unknown>): HostedApp => ({
  app_id: r.app_id as string,
  tenant_id: r.tenant_id as string,
  build_id: r.build_id as string,
  repository: r.repository as string,
  commit_sha: r.commit_sha as string,
  port: Number(r.port),
  status: r.status as HostedApp["status"],
  updated_at: iso(r.updated_at)!,
});

// What a VM runs at first boot: it installs its runtime, makes its own WireGuard key, registers, brings up
// the tunnel with all traffic through it, and starts the agent loop that reconciles apps from its policy.
export function tenantUserData(cfg: HostingConfig, bootstrapToken: string): string {
  return `#!/bin/bash
# Mynt tenant VM: no inbound access; everything goes through the WireGuard tunnel to the gateway.
set -euo pipefail
exec >>/var/log/mynt-tenant.log 2>&1
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq docker.io wireguard-tools jq curl
curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" >/etc/apt/sources.list.d/gvisor.list
apt-get update -q && apt-get install -yq runsc
runsc install && systemctl restart docker
umask 077
mkdir -p /etc/mynt
wg genkey | tee /etc/mynt/wg.key | wg pubkey >/etc/mynt/wg.pub
REG=$(curl -fsS -X POST ${cfg.publicUrl}/v1/hosting/bootstrap -H 'Content-Type: application/json' \\
  -d "{\\"token\\":\\"${bootstrapToken}\\",\\"wg_public_key\\":\\"$(cat /etc/mynt/wg.pub)\\"}")
echo "$REG" | jq -r .agent_token >/etc/mynt/agent.token
cat >/etc/wireguard/wg0.conf <<WG
[Interface]
Address = $(echo "$REG" | jq -r .tunnel_ip)/32
PrivateKey = $(cat /etc/mynt/wg.key)
[Peer]
PublicKey = ${cfg.gatewayPublicKey}
Endpoint = ${cfg.gatewayEndpoint}
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
WG
systemctl enable --now wg-quick@wg0
# Image builds pull through the gateway's proxy too.
mkdir -p /etc/systemd/system/docker.service.d
printf '[Service]\nEnvironment=HTTPS_PROXY=http://${GATEWAY_TUNNEL_IP}:${PROXY_PORT} HTTP_PROXY=http://${GATEWAY_TUNNEL_IP}:${PROXY_PORT}\n' >/etc/systemd/system/docker.service.d/proxy.conf
systemctl daemon-reload && systemctl restart docker
cat >/usr/local/bin/mynt-agent <<'AGENT'
#!/bin/bash
# Reconciles the apps this VM runs with its policy from Mynt, every 30 seconds.
set -uo pipefail
PROXY=http://${GATEWAY_TUNNEL_IP}:${PROXY_PORT}
while true; do
  POLICY=$(curl -fsS -x "$PROXY" ${cfg.publicUrl}/v1/hosting/policy -H "Authorization: Bearer $(cat /etc/mynt/agent.token)") || { sleep 30; continue; }
  WANT=$(echo "$POLICY" | jq -r '.apps[].name')
  for c in $(docker ps -a --format '{{.Names}}' | grep '^mynt-app-' || true); do
    echo "$WANT" | grep -qx "$c" || docker rm -f "$c"
  done
  echo "$POLICY" | jq -c '.apps[]' | while read -r app; do
    NAME=$(echo "$app" | jq -r .name); SHA=$(echo "$app" | jq -r .commit_sha); IMG="mynt/$NAME:$SHA"
    if ! docker image inspect "$IMG" >/dev/null 2>&1; then
      DIR=$(mktemp -d)
      curl -fsSL -x "$PROXY" -H "Authorization: Bearer $(echo "$app" | jq -r .source_token)" "$(echo "$app" | jq -r .source_url)" | tar -xz -C "$DIR" --strip-components=1
      docker build -q -t "$IMG" "$DIR" && rm -rf "$DIR"
    fi
    if [ "$(docker inspect -f '{{.Config.Image}}' "$NAME" 2>/dev/null)" != "$IMG" ]; then
      docker rm -f "$NAME" >/dev/null 2>&1 || true
      docker run -d --name "$NAME" --restart unless-stopped --runtime runsc --read-only --tmpfs /tmp \\
        --cap-drop ALL --security-opt no-new-privileges --memory 512m --cpus 0.5 \\
        -p "$(echo "$app" | jq -r .tunnel_ip):$(echo "$app" | jq -r .port):8080" \\
        -e HTTPS_PROXY="$PROXY" -e HTTP_PROXY="$PROXY" \\
        -e MYNT_API_KEY="$(echo "$app" | jq -r .app_key)" -e MYNT_BASE_URL="$(echo "$app" | jq -r .mynt_base_url)" "$IMG"
    fi
  done
  sleep 30
done
AGENT
chmod 700 /usr/local/bin/mynt-agent
cat >/etc/systemd/system/mynt-agent.service <<UNIT
[Unit]
After=wg-quick@wg0.service docker.service
[Service]
ExecStart=/usr/local/bin/mynt-agent
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now mynt-agent
`;
}

export class HostingService {
  private constructor(
    private readonly db: Db,
    readonly provider: HostingProvider | null,
    readonly config: HostingConfig | null,
    private readonly sourceToken: (developerId: string, repository: string) => Promise<string | null>,
  ) {}

  static async open(
    db: Db,
    provider: HostingProvider | null,
    config: HostingConfig | null,
    sourceToken: (developerId: string, repository: string) => Promise<string | null> = async () => null,
  ) {
    await db.exec(TABLES);
    return new HostingService(db, provider, config, sourceToken);
  }

  get enabled() {
    return Boolean(this.provider && this.config);
  }

  private async one(sql: string, params: unknown[] = []) {
    return (await this.db.query(sql, params)).rows[0] as Record<string, unknown> | undefined;
  }

  async tenantOf(developerId: string): Promise<Tenant | undefined> {
    const r = await this.one("SELECT * FROM financial_products.hosting_tenants WHERE developer_id = $1", [developerId]);
    return r && toTenant(r);
  }

  async tenants(): Promise<Tenant[]> {
    return (await this.db.query("SELECT * FROM financial_products.hosting_tenants ORDER BY created_at")).rows.map((r) => toTenant(r as Record<string, unknown>));
  }

  async hostedApps(tenantId?: string): Promise<HostedApp[]> {
    const rows = tenantId
      ? (await this.db.query("SELECT * FROM financial_products.hosted_apps WHERE tenant_id = $1 ORDER BY port", [tenantId])).rows
      : (await this.db.query("SELECT * FROM financial_products.hosted_apps ORDER BY tenant_id, port")).rows;
    return rows.map((r) => toHostedApp(r as Record<string, unknown>));
  }

  // A VM for this developer, booting with a one-time bootstrap token (valid an hour).
  async provision(developerId: string): Promise<Tenant> {
    if (!this.provider || !this.config) throw new Error("Hosting isn't configured on this deployment");
    const existing = await this.tenantOf(developerId);
    if (existing && existing.status !== "failed") return existing;
    if (existing) await this.db.query("DELETE FROM financial_products.hosting_tenants WHERE id = $1", [existing.id]);
    const id = randomUUID();
    const bootstrap = randomBytes(24).toString("base64url");
    await this.db.query(
      `INSERT INTO financial_products.hosting_tenants (id, developer_id, provider, status, bootstrap_hash, bootstrap_expires_at)
       VALUES ($1, $2, $3, 'provisioning', $4, now() + interval '1 hour')`,
      [id, developerId, this.provider.name, hash(bootstrap)],
    );
    try {
      const vm = await this.provider.createVm({
        name: `mynt-tenant-${id.slice(0, 8)}`,
        region: this.config.region,
        size: this.config.size,
        userData: tenantUserData(this.config, bootstrap),
        tags: ["mynt-tenant"],
      });
      await this.db.query("UPDATE financial_products.hosting_tenants SET vm_id = $2, updated_at = now() WHERE id = $1", [id, vm.id]);
    } catch (e) {
      await this.db.query("UPDATE financial_products.hosting_tenants SET status = 'failed', error = $2, updated_at = now() WHERE id = $1", [id, (e as Error).message.slice(0, 500)]);
    }
    return (await this.tenantOf(developerId))!;
  }

  // A booting VM registers its WireGuard key with its one-time token; it gets its tunnel address and agent token.
  async bootstrap(token: string, wgPublicKey: string) {
    if (!this.provider || !this.config) throw new Error("Hosting isn't configured on this deployment");
    if (!/^[A-Za-z0-9+/]{43}=$/.test(wgPublicKey)) throw new Error("wg_public_key must be a WireGuard public key");
    const r = await this.one(
      "SELECT * FROM financial_products.hosting_tenants WHERE bootstrap_hash = $1 AND bootstrap_expires_at > now() AND status = 'provisioning'",
      [hash(token)],
    );
    if (!r) return null;
    const used = (await this.db.query("SELECT tunnel_index FROM financial_products.hosting_tenants WHERE tunnel_index IS NOT NULL ORDER BY tunnel_index")).rows.map((x) => Number((x as { tunnel_index: number }).tunnel_index));
    let index = 0;
    while (used.includes(index)) index++;
    const agent = randomBytes(32).toString("base64url");
    await this.db.query(
      `UPDATE financial_products.hosting_tenants SET status = 'running', tunnel_index = $2, wg_public_key = $3, agent_hash = $4,
         bootstrap_hash = NULL, bootstrap_expires_at = NULL, updated_at = now() WHERE id = $1`,
      [r.id, index, wgPublicKey, hash(agent)],
    );
    if (r.vm_id) await this.provider.lockDown(r.vm_id as string, this.config.gatewayIp, Number(this.config.gatewayEndpoint.split(":")[1] ?? 51820));
    return { tunnel_ip: tunnelIp(index)!, gateway_tunnel_ip: GATEWAY_TUNNEL_IP, agent_token: agent };
  }

  async tenantByAgent(token: string): Promise<Tenant | undefined> {
    const r = await this.one("SELECT * FROM financial_products.hosting_tenants WHERE agent_hash = $1", [hash(token)]);
    return r && toTenant(r);
  }

  // Runs an app's verified commit on its developer's VM, with a dedicated app key kept sealed.
  async deploy(tenant: Tenant, app: { id: string }, build: { id: string; repository: string; commit_sha: string }, appKey: string, sandbox: boolean): Promise<HostedApp> {
    const ports = (await this.hostedApps(tenant.id)).filter((h) => h.app_id !== app.id).map((h) => h.port);
    let port = 9000;
    while (ports.includes(port)) port++;
    const r = await this.one(
      `INSERT INTO financial_products.hosted_apps (app_id, tenant_id, build_id, repository, commit_sha, port, app_key_sealed, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'deploying')
       ON CONFLICT (app_id) DO UPDATE SET build_id = EXCLUDED.build_id, repository = EXCLUDED.repository, commit_sha = EXCLUDED.commit_sha,
         app_key_sealed = EXCLUDED.app_key_sealed, status = 'deploying', updated_at = now()
       RETURNING *`,
      [app.id, tenant.id, build.id, build.repository, build.commit_sha, port, seal(appKey, sandbox) + (sandbox ? ":sandbox" : ":live")],
    );
    return toHostedApp(r!);
  }

  async undeploy(appId: string): Promise<boolean> {
    return (await this.db.query("DELETE FROM financial_products.hosted_apps WHERE app_id = $1 RETURNING app_id", [appId])).rows.length > 0;
  }

  // The kill switch: off the gateway at once (peers, routes, allowlist) and powered off.
  async suspend(tenantId: string): Promise<Tenant | undefined> {
    const r = await this.one("UPDATE financial_products.hosting_tenants SET status = 'suspended', updated_at = now() WHERE id = $1 RETURNING *", [tenantId]);
    if (r?.vm_id && this.provider) await this.provider.powerOff(r.vm_id as string).catch(() => undefined);
    return r && toTenant(r);
  }

  async resume(tenantId: string): Promise<Tenant | undefined> {
    const r = await this.one("UPDATE financial_products.hosting_tenants SET status = 'running', updated_at = now() WHERE id = $1 AND status = 'suspended' RETURNING *", [tenantId]);
    if (r?.vm_id && this.provider) await this.provider.powerOn(r.vm_id as string).catch(() => undefined);
    return r && toTenant(r);
  }

  // What a VM's agent runs: each app at its verified commit, with a short-lived token to fetch it.
  async policy(tenant: Tenant, egressFor: (appId: string) => Promise<string[]>) {
    if (tenant.status !== "running") return { apps: [], status: tenant.status };
    const out = [];
    for (const h of await this.hostedApps(tenant.id)) {
      const row = await this.one("SELECT app_key_sealed FROM financial_products.hosted_apps WHERE app_id = $1", [h.app_id]);
      const stored = String(row?.app_key_sealed ?? "");
      const sandbox = stored.endsWith(":sandbox");
      const appKey = open(stored.replace(/:(sandbox|live)$/, ""), sandbox);
      out.push({
        name: `mynt-app-${h.app_id.slice(0, 8)}`,
        app_id: h.app_id,
        commit_sha: h.commit_sha,
        source_url: `https://api.github.com/repos/${h.repository}/tarball/${h.commit_sha}`,
        source_token: await this.sourceToken(tenant.developer_id, h.repository),
        port: h.port,
        tunnel_ip: tenant.tunnel_ip,
        app_key: appKey,
        mynt_base_url: `${this.config?.publicUrl ?? ""}/v1`,
        egress: await egressFor(h.app_id),
      });
    }
    return { apps: out, status: tenant.status };
  }

  // The gateway's WireGuard peers: running tenants only.
  async wireguardPeers(): Promise<string> {
    return (await this.tenants())
      .filter((t) => t.status === "running" && t.wg_public_key && t.tunnel_ip)
      .map((t) => `[Peer]\n# tenant ${t.id}\nPublicKey = ${t.wg_public_key}\nAllowedIPs = ${t.tunnel_ip}/32\n`)
      .join("\n");
  }

  // Where the edge sends each hosted app's traffic: <app>.<appsDomain> to the app on its tenant's tunnel address.
  async routes(): Promise<{ host: string; upstream: string }[]> {
    if (!this.config?.appsDomain) return [];
    const running = new Map((await this.tenants()).filter((t) => t.status === "running").map((t) => [t.id, t]));
    return (await this.hostedApps())
      .filter((h) => running.has(h.tenant_id))
      .map((h) => ({ host: `${h.app_id.slice(0, 8)}.${this.config!.appsDomain}`, upstream: `${running.get(h.tenant_id)!.tunnel_ip}:${h.port}` }));
  }
}

// What developers see of the boxes their work runs on (the build sandbox where the coding agents work, and the
// hosting VM their apps run on): command output, logs and files, capped and with secrets scrubbed.

export const BOX_OUTPUT_LIMIT = 64_000;
export const BOX_TIMEOUT_MAX = 300;

// Credentials a box may hold: GitHub tokens, Mynt app keys, client sessions and webhook secrets, Anthropic keys,
// and anything assigned to a variable whose name says it's secret.
const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bmynt_(?:live|test)_[A-Za-z0-9_-]{8,}\b/g,
  /\bmcs_(?:live|test)_[A-Za-z0-9_-]{8,}\b/g,
  /\bwhsec_[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
  /\b((?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY))\s*[=:]\s*)("?)[^\s"]{6,}\2/gi,
];

export function redact(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("[redacted]");
  for (const p of SECRET_PATTERNS) out = out.replace(p, (m, prefix?: string) => (prefix && /[=:]/.test(prefix) ? `${prefix}[redacted]` : "[redacted]"));
  return out;
}

// Keeps the end of long output (where errors are), says how much was cut.
export function capOutput(text: string, limit = BOX_OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  return `[${text.length - limit} earlier characters cut]\n` + text.slice(-limit);
}

export const boxOutput = (text: string, secrets: string[] = []) => capOutput(redact(text, secrets));

// Quotes a value for a POSIX shell.
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// VS Code in the browser, for the build sandbox: a pinned code-server release, bound to localhost and reached
// only through the sandbox's token-gated URL, with a password on top.
export const CODE_SERVER_VERSION = "4.96.4";
export const EDITOR_PORT = 8443;
export const EDITOR_CONFIG = "/home/user/.config/mynt-editor.yaml";
// The password goes in a config file written over the sandbox API, never on a command line.
export const editorConfig = (password: string) => `bind-addr: 127.0.0.1:${EDITOR_PORT}\nauth: password\npassword: ${password}\ncert: false\n`;
export function editorCommand(workspace: string): string {
  const v = CODE_SERVER_VERSION;
  const dir = `$HOME/.local/code-server-${v}`;
  return [
    `set -e`,
    `chmod 600 ${EDITOR_CONFIG}`,
    `if [ ! -x ${dir}/bin/code-server ]; then mkdir -p $HOME/.local && curl -fsSL https://github.com/coder/code-server/releases/download/v${v}/code-server-${v}-linux-amd64.tar.gz | tar -xz -C $HOME/.local && mv $HOME/.local/code-server-${v}-linux-amd64 ${dir}; fi`,
    `pkill -f "code-server --config ${EDITOR_CONFIG}" || true`,
    `nohup ${dir}/bin/code-server --config ${EDITOR_CONFIG} --disable-telemetry --disable-update-check ${shellQuote(workspace)} >$HOME/.local/code-server.log 2>&1 &`,
  ].join("\n");
}

// Commands the hosting agent runs on the developer's behalf, always against one of the developer's own app
// containers; exec runs inside the container (under gVisor), never on the VM itself.
export const HOSTING_COMMANDS = ["status", "logs", "restart", "exec"] as const;
export type HostingCommandKind = (typeof HOSTING_COMMANDS)[number];

// The script Mynt runs to verify a build, in a fresh sandbox the coding agent never touched. Its
// report, not the agent's own, decides whether a build ships.

export const VERIFY_DIR = "/root/mynt-verify";
export const VERIFY_APP = "/root/app";
const GITLEAKS_VERSION = "8.21.2";
const SYFT_VERSION = "1.18.1";

export const VERIFY_SCRIPT = String.raw`#!/usr/bin/env bash
# Mynt build verification. Usage: verify.sh <source-url> <sha256>   |   verify.sh --rehash
set -uo pipefail
V=${VERIFY_DIR}
APP=${VERIFY_APP}
mkdir -p "$V/bin"

tree_hash() {
  (cd "$APP" && find . -type f -not -path './node_modules/*' -not -path './.git/*' -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
}
if [ "$#" -gt 0 ] && [ "$1" = "--rehash" ]; then tree_hash > "$V/after.sha"; exit 0; fi

URL="$1"; WANT="$2"
CHECKS="$V/checks.jsonl"; : > "$CHECKS"
check() {
  python3 -c 'import json,sys; print(json.dumps({"name": sys.argv[1], "status": sys.argv[2], "detail": sys.argv[3][-1500:]}))' "$1" "$2" "$3" >> "$CHECKS"
}
finish() {
  python3 - "$CHECKS" "$V/report.json" <<'PY'
import json, sys
checks = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
json.dump({"checks": checks}, open(sys.argv[2], "w"), indent=2)
PY
}
trap finish EXIT

# Fetch a release binary and check it against the release's published checksums.
fetch_tool() { # name version url-base asset checksums-asset
  local name=$1 version=$2 base=$3 asset=$4 sums=$5
  curl -fsSL "$base/$asset" -o "$V/$asset" && curl -fsSL "$base/$sums" -o "$V/$sums" || return 1
  (cd "$V" && grep " $asset\$" "$sums" | sha256sum -c - >/dev/null) || return 1
  tar -xzf "$V/$asset" -C "$V/bin" "$name"
}

# --- source ---
curl -fsSL "$URL" -o "$V/app.tgz" || { check source fail "could not download the build's source"; exit 0; }
GOT=$(sha256sum "$V/app.tgz" | cut -d' ' -f1)
[ "$GOT" = "$WANT" ] || { check source fail "source checksum mismatch ($GOT)"; exit 0; }
mkdir -p "$APP" && tar -xzf "$V/app.tgz" -C "$APP"
check source pass "sha256 $GOT"
tree_hash > "$V/before.sha"
cd "$APP"
has_script() { [ -f package.json ] && node -e "process.exit((require('./package.json').scripts||{})['$1'] ? 0 : 1)" 2>/dev/null; }

# --- tests ---
if has_script test; then
  if (npm ci --no-audit --no-fund || npm install --no-audit --no-fund) >"$V/install.log" 2>&1 && npm test >"$V/tests.log" 2>&1; then
    check tests pass "npm test passed"
  else
    check tests fail "$(tail -c 1500 "$V/tests.log" 2>/dev/null || tail -c 1500 "$V/install.log")"
  fi
elif [ -f pyproject.toml ] || [ -f requirements.txt ]; then
  python3 -m venv "$V/venv" && . "$V/venv/bin/activate"
  { [ -f requirements.txt ] && pip install -q -r requirements.txt; [ -f pyproject.toml ] && pip install -q -e .; pip install -q pytest; } >"$V/install.log" 2>&1
  if python -m pytest -q >"$V/tests.log" 2>&1; then check tests pass "pytest passed"; else check tests fail "$(tail -c 1500 "$V/tests.log")"; fi
else
  check tests fail "no test suite found"
fi

# --- lint and types ---
LINT_OK=1; LINT_RAN=0
for s in lint typecheck; do
  if has_script "$s"; then LINT_RAN=1; npm run -s "$s" >"$V/$s.log" 2>&1 || LINT_OK=0; fi
done
if [ "$LINT_RAN" = 0 ] && [ -f tsconfig.json ]; then LINT_RAN=1; npx --yes tsc --noEmit >"$V/typecheck.log" 2>&1 || LINT_OK=0; fi
if [ "$LINT_RAN" = 0 ]; then check lint_typecheck warn "no lint or typecheck configured"
elif [ "$LINT_OK" = 1 ]; then check lint_typecheck pass "lint and types pass"
else check lint_typecheck fail "$(tail -c 1500 "$V"/lint.log "$V"/typecheck.log 2>/dev/null)"; fi

# --- secrets ---
ARCH=$(uname -m); case "$ARCH" in x86_64) GA=x64; SA=amd64;; aarch64|arm64) GA=arm64; SA=arm64;; *) GA=$ARCH; SA=$ARCH;; esac
if fetch_tool gitleaks ${GITLEAKS_VERSION} "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}" "gitleaks_${GITLEAKS_VERSION}_linux_$GA.tar.gz" "gitleaks_${GITLEAKS_VERSION}_checksums.txt"; then
  GIT_FLAG=""; [ -d .git ] || GIT_FLAG="--no-git"
  if "$V/bin/gitleaks" detect --source "$APP" $GIT_FLAG --no-banner --redact --report-path "$V/gitleaks.json" >"$V/gitleaks.log" 2>&1; then
    check secrets_scan pass "no secrets found"
  else
    check secrets_scan fail "$(python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print(len(r), "secret(s):", ", ".join(sorted({x.get("RuleID","?")+" in "+x.get("File","?") for x in r}))[:1200])' "$V/gitleaks.json" 2>/dev/null || tail -c 800 "$V/gitleaks.log")"
  fi
else
  check secrets_scan fail "could not install a verified gitleaks"
fi

# --- dependency audit ---
if [ -f package-lock.json ] || [ -f package.json ]; then
  if npm audit --omit=dev --audit-level=high >"$V/audit.log" 2>&1; then check dependency_audit pass "no high or critical advisories"; else check dependency_audit fail "$(tail -c 1500 "$V/audit.log")"; fi
elif [ -f requirements.txt ] || [ -f pyproject.toml ]; then
  . "$V/venv/bin/activate" 2>/dev/null; pip install -q pip-audit >/dev/null 2>&1
  if pip-audit >"$V/audit.log" 2>&1; then check dependency_audit pass "no known vulnerabilities"; else check dependency_audit fail "$(tail -c 1500 "$V/audit.log")"; fi
else
  check dependency_audit warn "no dependency manifest"
fi

# --- SBOM ---
if fetch_tool syft ${SYFT_VERSION} "https://github.com/anchore/syft/releases/download/v${SYFT_VERSION}" "syft_${SYFT_VERSION}_linux_$SA.tar.gz" "syft_${SYFT_VERSION}_checksums.txt" \
   && "$V/bin/syft" "dir:$APP" -o "cyclonedx-json=$V/sbom.json" -q >"$V/sbom.log" 2>&1 \
   && python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("components") else 1)' "$V/sbom.json"; then
  check sbom pass "CycloneDX SBOM generated"
else
  check sbom fail "$(tail -c 800 "$V/sbom.log" 2>/dev/null || echo "could not generate an SBOM")"
fi

# --- required disclosures ---
python3 - "$V/disclosures.json" "$APP" "$CHECKS" <<'PY'
import json, os, re, sys
wanted, root, out = json.load(open(sys.argv[1])), sys.argv[2], sys.argv[3]
norm = lambda s: re.sub(r"\s+", " ", s).strip().lower()
text = []
for d, dirs, files in os.walk(root):
    dirs[:] = [x for x in dirs if x not in ("node_modules", ".git")]
    for f in files:
        p = os.path.join(d, f)
        try:
            if os.path.getsize(p) < 2_000_000:
                text.append(open(p, encoding="utf-8", errors="ignore").read())
        except OSError:
            pass
corpus = norm("\n".join(text))
missing = [f'{w["product_id"]}: {w["text"]}' for w in wanted if norm(w["text"]) not in corpus]
row = {"name": "disclosures", "status": "fail" if missing else "pass",
       "detail": ("missing: " + " | ".join(missing))[-1500:] if missing else f"{len(wanted)} required disclosure(s) present"}
open(out, "a").write(json.dumps(row) + "\n")
PY
`;

export function auditorPrompt(maxwellRepo: string) {
  return `You are an independent security auditor for a Mynt build. The application under review is in ${VERIFY_APP}; another
agent produced it. Do not modify anything inside ${VERIFY_APP}: no edits, new files or deletions, and no fixes.

1. git clone ${maxwellRepo} /root/maxwell, then in /root/maxwell run: npm ci && npm run validate
2. Register a company "mynt-verify" and an application whose source is the local checkout at ${VERIFY_APP}, with this
   machine as the scan executor.
3. Run only its static workflows, headless: execute-scr, probe-cicd-env, probe-agent-graph and probe-schemas, plus
   probe-iac / probe-app-chart if the application has infrastructure code or charts.
4. Do not connect any external service or sign in anywhere. If a workflow asks for a login or credential, skip that step.
5. Take the counts from Maxwell's own findings records, not your judgement, and write ${VERIFY_DIR}/maxwell.json:
   {"counts": {"critical": n, "high": n, "medium": n, "low": n}, "findings": [{"severity", "title", "file", "workflow"}],
    "workflows_run": [...], "skipped": [...], "summary": "..."}
Then stop.`;
}

# Deploy to claude.parampreetsingh.dev

Target: one Linux server (Ubuntu/Debian below), Caddy in front for HTTPS, gateway as a systemd service.
The existing domain serves both Claude and OpenAI; no new DNS record or proxy route is needed.

```
Internet ──HTTPS:443──▶ Caddy ──HTTP──▶ 127.0.0.1:3000 gateway ──▶ api.anthropic.com / api.openai.com
                       (TLS cert,         (never reachable
                        real client IP)    from outside)
```

## 1. DNS

At your DNS provider add:

| Type | Name | Value |
|---|---|---|
| A | `claude` | server's public IPv4 |
| AAAA | `claude` | server's IPv6 (only if it has one) |

The application accepts admin and client logins from any source IP with valid credentials. There is no application IP allowlist. Keep the reverse proxy configured to supply the real client IP for failed-login lockouts.

Check: `dig +short claude.parampreetsingh.dev` shows your server IP.

## 2. Server packages (once)

```bash
# Node 24+ (needs built-in TypeScript stripping and node:sqlite)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs caddy sqlite3

# Firewall: only SSH + web. Port 3000 stays closed.
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable

# Dedicated user with no login shell
sudo useradd --system --home /opt/claude-gateway --shell /usr/sbin/nologin gateway
sudo mkdir -p /opt/claude-gateway/data
```

If `apt install caddy` finds nothing, add Caddy's repo first: https://caddyserver.com/docs/install#debian-ubuntu-raspbian

## 3. Copy the code (from your Mac)

```bash
rsync -av --exclude node_modules --exclude .env --exclude data --exclude .impeccable \
  /Users/pampi/Workstation/genAI/ you@SERVER_IP:/tmp/claude-gateway/
```

On the server:

```bash
sudo rsync -a /tmp/claude-gateway/ /opt/claude-gateway/
cd /opt/claude-gateway && sudo npm ci --omit=dev
sudo chown -R root:root /opt/claude-gateway
sudo chown gateway:gateway /opt/claude-gateway/data
```

Code is owned by root (the service can't modify it); only `data/` is writable by the service.

## 4. Production `.env`

Create it on the server, never copy your laptop one with test values:

```bash
sudo nano /opt/claude-gateway/.env
sudo chown root:gateway /opt/claude-gateway/.env
sudo chmod 640 /opt/claude-gateway/.env
```

Differences from local:

```ini
HOST=127.0.0.1              # only Caddy can reach the gateway
PORT=3000
TRUST_PROXY=true            # Caddy sends the real client IP
DB_PATH=./data/gateway.db

# Required now that the server is public: run `npm run admin:2fa` and paste the line here
ADMIN_TOTP_SECRET=...

# Fresh values, generated on the server: openssl rand -hex 32
ADMIN_ID=admin
ADMIN_SECRET=...
JWT_SECRET=...

# Optional OpenAI: fill 1–5 real keys, leaving unused slots empty.
OPENAI_KEY_1=
OPENAI_KEY_2=
OPENAI_KEY_3=
OPENAI_KEY_4=
OPENAI_KEY_5=
OPENAI_MODEL=gpt-4.1-mini
OPENAI_MAX_TOKENS=4096
OPENAI_TIMEOUT_MS=60000

# Only browser apps on other sites need listing; the dashboard on this domain is always allowed
ALLOWED_ORIGINS=

REAL_KEY_1=sk-ant-...
REAL_KEY_2=sk-ant-...
REAL_KEY_3=sk-ant-...
```

Copy the rest (model, limits, effort) from [.env.example](.env.example).

Run 2FA setup on the server: `cd /opt/claude-gateway && sudo -u gateway node src/totp.ts`.

## 5. systemd service

`/etc/systemd/system/claude-gateway.service`:

```ini
[Unit]
Description=GenAI Gateway
After=network-online.target
Wants=network-online.target

[Service]
User=gateway
Group=gateway
WorkingDirectory=/opt/claude-gateway
ExecStart=/usr/bin/node --env-file=.env src/server.ts
Restart=on-failure
RestartSec=3

# Hardening: read-only system, writable data dir only
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/claude-gateway/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now claude-gateway
sudo systemctl status claude-gateway          # should be "active (running)"
journalctl -u claude-gateway -n 50            # check startup and 2FA configuration
```

## 6. Caddy (HTTPS)

`/etc/caddy/Caddyfile`:

```caddy
claude.parampreetsingh.dev {
	handle /api/assistant* {
		reverse_proxy 127.0.0.1:3000
	}
	handle {
		respond 404
	}
}
```

```bash
sudo systemctl reload caddy
```

Caddy gets and renews the Let's Encrypt certificate itself (DNS from step 1 must already point here). Keep `TRUST_PROXY=true` only while the gateway is reachable through your controlled reverse proxy, so failed-login lockouts use the client IP.

## 7. Check it

From your laptop:

```bash
curl https://claude.parampreetsingh.dev/api/assistant/health
```

```bash
curl -i http://claude.parampreetsingh.dev/api/assistant/health    # expect redirect to https
```

```bash
curl -i https://claude.parampreetsingh.dev/                       # expect 404
```

Then open `https://claude.parampreetsingh.dev/api/assistant/admin`, sign in with ID + secret + 6-digit code, create a client, and run the two client calls from [CLIENT_GUIDE.md](CLIENT_GUIDE.md).

For OpenAI, fill at least one `OPENAI_KEY_1` through `OPENAI_KEY_5` above and restart. Click **Grant OpenAI** for your client, then use `/api/assistant/openai/send` with its existing token. Confirm provider totals and masked key status appear separately. With no grant the route returns `403`; with a grant but no configured key it returns `503`. Use the [append-only command in README.md](README.md#add-missing-settings-without-replacing-your-existing-env) to add missing settings without replacing your current `.env`.

From a phone on mobile data (different IP), `/admin` must show the sign-in page. Admin APIs still require a valid admin token.

## 8. Day-to-day

| Task | Command |
|---|---|
| Live logs | `journalctl -u claude-gateway -f` |
| Failed admin logins | `journalctl -u claude-gateway \| grep "failed login"` |
| Restart | `sudo systemctl restart claude-gateway` |
| Deploy new code | repeat step 3, then restart |
| Your home IP changed | no application configuration change needed |

**Backups** (the DB holds clients, grants, and usage). Daily at 03:00, keep 14 days, via `sudo crontab -e`:

```cron
0 3 * * * sqlite3 /opt/claude-gateway/data/gateway.db ".backup /var/backups/gateway-$(date +\%F).db" && find /var/backups -name 'gateway-*.db' -mtime +14 -delete
```

Copy a backup off the server now and then (`scp`), or it dies with the disk.
Keep a separate secure backup of `.env`, which contains the actual Claude and OpenAI keys. Key changes require a restart; keep slot numbers stable for reporting.

## 9. Upgrade an existing Claude installation

1. Take a consistent SQLite backup before deploying, using the `.backup` command above. Preserve the current `.env` and old code for rollback.
2. Deploy the new code and restart the existing service. Startup adds the missing client and usage columns without deleting clients or usage. Historical usage becomes `anthropic`; all existing OpenAI grants default to off.
3. Claude remains available without OpenAI configuration. To enable OpenAI, add numbered keys to `.env`, restart, and grant client access. Old database key rows and the old encryption setting are ignored; existing rows are not deleted.
4. Verify both endpoints and reporting. Do not replace the live database with an empty file. Restoring a pre-upgrade backup also discards usage/client changes recorded since that backup.

## Notes

- **Restart effects:** admin session, login lockouts, per-minute counters and key cooldowns reset. Client tokens and OpenAI grants persist in the DB; keys reload from `.env`. Run one process; counters are not coordinated across instances.
- **OpenAI:** allow outbound HTTPS to `api.openai.com`. Use its default base URL in production. Review provider usage and limits/alerts alongside the gateway's estimates; a failed/timed-out request may still be charged. Combined budgets check recorded spend and may be exceeded by in-flight calls.
- **Anthropic Console:** set a monthly spend limit on the workspace as a final backstop.
- **Old configuration:** remove `ADMIN_ALLOWED_IPS` from existing `.env` files; it is no longer used. Source IP changes do not affect valid logins. Authentication, 2FA, and failed-login lockouts remain enabled as configured.

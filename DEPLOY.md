# Deploy to claude.parampreetsingh.dev

Target: one Linux server (Ubuntu/Debian below), Caddy in front for HTTPS, gateway as a systemd service.

```
Internet ──HTTPS:443──▶ Caddy ──HTTP──▶ 127.0.0.1:3000 gateway ──▶ api.anthropic.com
                       (TLS cert,         (never reachable
                        real client IP)    from outside)
```

## 1. DNS

At your DNS provider add:

| Type | Name | Value |
|---|---|---|
| A | `claude` | server's public IPv4 |
| AAAA | `claude` | server's IPv6 (only if it has one) |

Using Cloudflare DNS? Set the record to **DNS only (grey cloud)**. If it's proxied (orange cloud), every request arrives from a Cloudflare IP, which breaks the admin IP allowlist and login lockout.

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

# Your home/office public IP. Find it FROM THAT NETWORK (not the server): curl -s ifconfig.me
ADMIN_ALLOWED_IPS=203.0.113.25

# Required now that the server is public: run `npm run admin:2fa` and paste the line here
ADMIN_TOTP_SECRET=...

# Fresh values, generated on the server: openssl rand -hex 32
ADMIN_SECRET=...
JWT_SECRET=...

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
Description=Claude Gateway
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
journalctl -u claude-gateway -n 50            # warnings about allowlist/2FA must be gone
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

Caddy gets and renews the Let's Encrypt certificate itself (DNS from step 1 must already point here). It replaces any `X-Forwarded-For` the client sends, so nobody can fake their IP to pass the admin allowlist.

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

From a phone on mobile data (different IP), `/admin` must show **404**.

## 8. Day-to-day

| Task | Command |
|---|---|
| Live logs | `journalctl -u claude-gateway -f` |
| Failed admin logins | `journalctl -u claude-gateway \| grep "failed login"` |
| Restart | `sudo systemctl restart claude-gateway` |
| Deploy new code | repeat step 3, then restart |
| Your home IP changed | update `ADMIN_ALLOWED_IPS`, restart |

**Backups** (the DB holds all clients and usage). Daily at 03:00, keep 14 days, via `sudo crontab -e`:

```cron
0 3 * * * sqlite3 /opt/claude-gateway/data/gateway.db ".backup /var/backups/gateway-$(date +\%F).db" && find /var/backups -name 'gateway-*.db' -mtime +14 -delete
```

Copy a backup off the server now and then (`scp`), or it dies with the disk.

## Notes

- **Restart effects:** admin session, login lockouts, per-minute counters and resting keys reset. Client tokens stay valid (they live in the DB).
- **Anthropic Console:** set a monthly spend limit on the workspace as a final backstop.
- **Home IP is dynamic?** Many ISPs change it every few days. Then you'll get 404 on `/admin` until you update `ADMIN_ALLOWED_IPS` over SSH. If that gets annoying, the next step is a VPN (e.g. Tailscale) for admin access.

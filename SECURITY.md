# Security

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository. Include what you found, how to reproduce it and which version or image tag you tested. You will get an answer within a week; fixes are released as a new `latest` image and noted in the [changelog](CHANGELOG.md).

## Supported versions

Only the newest release (`astaldoo/tidewiki:latest`) receives security fixes. Database migrations run automatically on start, so updating is `docker compose -f docker.yaml pull && docker compose -f docker.yaml up -d`.

## Design

### Accounts

| Area            | Implementation                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passwords       | Argon2id, 64 MiB, t = 3, p = 1, applied to an HMAC-SHA256 of the password keyed with a pepper derived from the master key. Old parameters are rehashed on the next sign-in. Concurrency is capped and the queue is bounded (HTTP 503 instead of memory exhaustion).                                                                                                                                        |
| Password policy | Minimum length 10–64 plus optional minimum counts of digits, special characters, upper- and lower-case letters; common passwords and the username/e-mail are rejected. Enforced on the server for registration, reset, change, admin-set and setup.                                                                                                                                                        |
| Unknown users   | A dummy hash is verified so timing doesn't reveal which accounts exist; error messages are identical.                                                                                                                                                                                                                                                                                                      |
| Lock-out        | Per account, escalating 10 min → 24 h. Counters for non-existent names are capped. A CLI unlock exists for the owner.                                                                                                                                                                                                                                                                                      |
| Two-factor      | TOTP (RFC 6238, SHA-1, 6 digits, ±1 step). Up to 10 devices per account; each secret is AES-256-GCM encrypted with associated data bound to the user, and each device has its own atomic replay protection. 10 single-use recovery codes stored as HMACs. Required per role; the last device can't be removed while the role requires it. Only roles below one's own can be changed — except by the owner. |
| Sessions        | 256-bit random tokens; the database stores SHA-256 only. Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` with the `__Host-` prefix on HTTPS. At most 30 sessions per person. Revoked on password change, reset and role change. The account page addresses sessions by a handle derived from the hash, never by the hash.                                                                             |
| Password reset  | Single-use, 30-minute token, stored as a hash, delivered in the URL fragment (never in server logs or `Referer`). A reset never bypasses 2FA.                                                                                                                                                                                                                                                              |
| Profile changes | Username and e-mail changes need the current password; the old address is notified; pending reset links are invalidated.                                                                                                                                                                                                                                                                                   |

### Requests and content

| Area         | Implementation                                                                                                                                                                                                                                                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CSRF         | Every non-GET API request must carry an `Origin` that matches the configured base URL; the `Host` header is checked against an allow-list (DNS-rebinding protection).                                                                                                                                                                                |
| Markdown     | `html: false` in markdown-it, then an allow-list sanitizer. Attributes such as `target` and `rel` are rebuilt, never copied from input. External links get `target="_blank"` plus `rel="noopener noreferrer nofollow ugc"`.                                                                                                                          |
| CSP          | Nonce-based `script-src` with `strict-dynamic`, no `unsafe-inline` scripts, `frame-ancestors 'none'`, frames limited to youtube-nocookie.com and player.vimeo.com, autoplay disabled by Permissions-Policy.                                                                                                                                          |
| Search       | Query terms are data: quoted FTS5 phrases and escaped `LIKE` patterns. Wildcards are matched with a linear scan, never a regular expression built from input. Each search has a time budget, all searches together a CPU budget.                                                                                                                     |
| Uploads      | Type decided by magic bytes, SVG/HTML refused, image metadata stripped, files served from `/media` with `Content-Security-Policy: sandbox` and `nosniff`, concurrency and quota limits.                                                                                                                                                              |
| Import       | Archive paths are only names (no zip-slip); sizes are checked while inflating (zip bombs stop at the limit); everything runs in one transaction.                                                                                                                                                                                                     |
| Mail         | Settings-configured servers are limited to mail ports and may not resolve to link-local, metadata or unspecified addresses. DNS is resolved once and the connection pinned to that address. Header values can't contain line breaks. HTML mails escape every value and only link `http(s)`. The test mail only goes to the requesting administrator. |
| Live updates | Connections are capped globally and per IP.                                                                                                                                                                                                                                                                                                          |

### Data at rest

- The master key is generated with mode `0600` in the data volume unless `WIKI_MASTER_KEY` / `WIKI_MASTER_KEY_FILE` is set. Keep a copy outside the volume; without it, nobody can sign in and all 2FA has to be reset.
- SQLite runs with `secure_delete`; erasure also checkpoints the WAL file.
- The container starts as root only to apply `PUID`/`PGID` to `/data`, then drops privileges. Application files are read-only for the runtime user.

### Testing

The test suites cover these properties directly: XSS corpus against the renderer, CSRF and DNS-rebinding requests, privilege escalation attempts, replay of TOTP codes and recovery codes, IDOR on sessions and devices, a fuzzer that sends malformed bodies to every endpoint, login and connection floods, hostile search queries and archives, and an upgrade from the previous database schema.

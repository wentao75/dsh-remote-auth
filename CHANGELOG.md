# Changelog

## 0.1.2 — 2026-09-17

Documentation-only release (no code changes).

- Record compatibility re-check against dsh **0.1.6-alpha.1**: the extension
  points this plugin relies on (`ctx.webServer.register`, `tapIndex`,
  `ctx.connection.authenticatedUrl` / `authorizeIndex` / `requestRejection` /
  `trustedHosts`) and the browser-auth model are unchanged; the full
  `/mobile-auth` flow was re-verified on that kernel.

## 0.1.1 — 2026-09-11

Security fix.

- **Never render the PIN on the `/mobile-auth` page.** The previous build showed
  the PIN in plaintext whenever the request looked like loopback, which trusted
  the TCP peer address — any local reverse proxy (`tailscale serve`, Caddy,
  gateway plugins) would make remote visitors appear as `127.0.0.1` and leak the
  PIN to them. A screenshot or screen share leaked it too. The page now only
  states that the gate is configured server-side, and `docs/VERIFY.md` asserts
  the page must not contain the PIN.

## 0.1.0 — 2026-09-05

Initial release.

- `GET /mobile-auth`: clickable authorization link + QR code + copy field,
  minted from the current process's browser-session URL via the official
  `ctx.connection.authenticatedUrl()` extension point.
- OR-gate fence over `allowedAuthorities` (Host header) / `allowedSubnets`
  (CIDR); loopback always allowed; fail closed.
- Optional 8-char PIN with constant-time comparison and per-IP rate limiting
  (5 failures → 60 s lock).
- Host-only bundle, zero runtime dependencies (vendored MIT qrcode-generator).

/**
 * dsh-remote-auth — host plugin.
 *
 * Serves an exact route GET /mobile-auth that shows the CURRENT process's
 * browser-authentication URL (clickable link + QR + copy field), minted via
 * the official ctx.connection.authenticatedUrl(baseUrl) extension point.
 *
 * Why this exists: `dsh web` authorizes browsers through a per-process launch
 * token printed on the host (`/?token=...`). Remote devices (iPad/iPhone over
 * Tailscale or home LAN) currently have to dig that URL out of the server
 * log. This page puts it behind an optional authority/source-IP fence and an
 * optional 8-char PIN.
 *
 * Route is intentionally NOT under /api: a device without a session cookie
 * must be able to reach it to mint one. Protection is therefore:
 *   1. OR fence: the request passes when its Host header names an allowed
 *      authority (allowedAuthorities) OR its source IP lies inside an allowed
 *      subnet (allowedSubnets, CIDR). Loopback always allowed. Both lists
 *      empty => loopback only (fail closed). Subnet membership is the
 *      recommended gate for home-LAN / Tailscale IP access; the authority
 *      list additionally allows name-based access (ts.net / mDNS hostnames).
 *   2. Optional PIN with per-IP rate limiting (5 fails -> 60 s lock).
 *
 * The minted link/QR is authority-bound: it is always derived from the Host
 * header the requesting device used (ctx.connection.authenticatedUrl(origin)),
 * so a phone that opens the page over its own authority gets a cookie for
 * that same authority. Fail closed: with empty allow-lists only loopback can
 * ever reach the page.
 */
import { createRequire } from "node:module";
import { timingSafeEqual } from "node:crypto";

const require = createRequire(import.meta.url);
// qrcode-generator (MIT, Kazuhiko Arase) is CommonJS UMD; the .cjs extension
// keeps Node from loading it as ESM under this package's "type": "module".
const qrcode = require("./qrcode.cjs");

export const name = "dsh-remote-auth";
/** Activate only once the webserver and the connection (auth) services exist. */
export const inject = ["webServer", "connection"];

const DEFAULTS = Object.freeze({
  allowedAuthorities: [], // bare host (any port) or exact host:port
  allowedSubnets: [], // CIDR strings; loopback is always allowed
  pin: "", // 8-char alphanumeric gate; "" disables
  lockAfterFails: 5,
  lockSeconds: 60,
  originProtocol: "http", // switch to "https" behind a TLS reverse proxy
});

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function normalizeIp(raw) {
  let ip = String(raw ?? "").trim();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7); // IPv4-mapped IPv6
  if (ip === "::1") ip = "::1";
  return ip;
}

function isLoopbackIp(ip) {
  return ip === "127.0.0.1" || ip === "::1";
}

function isLoopbackHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK_HOSTS.has(h) || /^127\./.test(h);
}

/** Parse dotted-quad IPv4 to a uint32. */
function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

/** True when ip is inside any of the CIDR strings. Supports IPv4 + ::1. */
function ipInSubnets(ip, subnets) {
  const v4 = ipv4ToInt(ip);
  for (const entry of subnets) {
    const cidr = String(entry).trim();
    const slash = cidr.indexOf("/");
    const prefix = slash === -1 ? cidr : cidr.slice(0, slash);
    const bits = slash === -1 ? (cidr.includes(":") ? 128 : 32) : Number(cidr.slice(slash + 1));
    if (prefix === "::1" && ip === "::1") return true;
    if (v4 !== null && !prefix.includes(":")) {
      const base = ipv4ToInt(prefix);
      if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
      const mask = bits === 0 ? 0 : (~0 >>> 0) << (32 - bits);
      if ((v4 & mask) === (base & mask)) return true;
    }
  }
  return false;
}

/** Normalize a bare authority entry: lowercase host, optional :port kept. */
function normalizeEntry(entry) {
  return String(entry).trim().toLowerCase().replace(/\/+$/, "");
}

/**
 * Host-header gate, mirroring core trustedHosts semantics: an entry without a
 * port matches that host on any port; "host:port" must match exactly.
 */
function hostAllowed(hostHeader, authorities) {
  let host = String(hostHeader ?? "").trim().toLowerCase();
  if (!host) return false;
  const hostname = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
  if (isLoopbackHost(hostname)) return true;
  for (const raw of authorities) {
    const entry = normalizeEntry(raw);
    if (entry === host) return true; // exact host:port
    if (!entry.includes(":") && entry === hostname) return true; // bare host
  }
  return false;
}

function peerAllowed(ip, subnets) {
  if (!ip) return false;
  if (isLoopbackIp(ip)) return true;
  return ipInSubnets(ip, subnets);
}

function sendText(res, code, body) {
  res.writeHead(code, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  res.end(body);
}

function sendHtml(res, code, body) {
  res.writeHead(code, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  res.end(body);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

function pinMatches(expected, attempt) {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(attempt));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// rate limiting (per peer IP, in-memory)
// ---------------------------------------------------------------------------

function isLocked(fails, ip) {
  const rec = fails.get(ip);
  if (!rec) return false;
  // Only report a lock; never delete here — recordFail below needs the count.
  return rec.until > Date.now();
}

function recordFail(fails, ip, cfg) {
  const now = Date.now();
  const rec = fails.get(ip) ?? { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= cfg.lockAfterFails) {
    rec.until = now + cfg.lockSeconds * 1000;
    rec.count = 0;
  }
  fails.set(ip, rec);
}

// ---------------------------------------------------------------------------
// pages
// ---------------------------------------------------------------------------

function pinFormHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 远程授权</title>
<style>
body{font-family:system-ui,-apple-system,"PingFang SC",sans-serif;background:#0f1115;color:#e6e6e6;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#171a21;border:1px solid #2a2f3a;border-radius:14px;padding:28px;width:min(92vw,360px)}
h1{font-size:18px;margin:0 0 6px} p{color:#9aa3b2;font-size:13px;line-height:1.6;margin:0 0 16px}
label{font-size:13px;display:block;margin-bottom:6px}
input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #39404d;
background:#0f1115;color:#fff;font-size:16px;letter-spacing:2px;text-align:center}
button{margin-top:12px;width:100%;padding:11px;border:0;border-radius:8px;background:#4d6bfe;color:#fff;
font-size:15px;cursor:pointer}
.err{color:#ff6b6b;font-size:13px;margin-top:10px}
</style></head><body>
<div class="card">
<h1>DSH 远程授权</h1>
<p>请输入 8 位访问码以获取授权链接/二维码。</p>
<form method="get" action="/mobile-auth">
<label for="pin">访问码</label>
<input id="pin" name="pin" inputmode="text" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="16" required autofocus enterkeyhint="go">
<button type="submit">获取授权链接</button>
</form>
</div></body></html>`;
}

function pageHtml({ tokenUrl, hostHeader, peerIsLoopback, cfg }) {
  const svg = qrSvg(tokenUrl);
  const link = escapeHtml(tokenUrl);
  const host = escapeHtml(hostHeader);
  const loopbackNote = peerIsLoopback
    ? `<p style="color:#4ade80">本机回环访问 · 当前 PIN：<code>${escapeHtml(cfg.pin || "(未启用)")}</code></p>`
    : "";
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 远程授权</title>
<style>
body{font-family:system-ui,-apple-system,"PingFang SC",sans-serif;background:#0f1115;color:#e6e6e6;margin:0;
display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#171a21;border:1px solid #2a2f3a;border-radius:14px;padding:28px;width:min(94vw,420px);
text-align:center}
h1{font-size:18px;margin:0 0 4px} .sub{color:#9aa3b2;font-size:13px;margin:0 0 18px}
a.btn{display:block;background:#4d6bfe;color:#fff;text-decoration:none;padding:13px;border-radius:10px;
font-size:15px;margin-bottom:18px}
.qr{background:#fff;border-radius:10px;padding:10px;display:inline-block;margin-bottom:14px}
input{width:100%;box-sizing:border-box;padding:9px 10px;border-radius:8px;border:1px solid #39404d;
background:#0f1115;color:#9aa3b2;font-size:12px}
.note{color:#6b7484;font-size:12px;line-height:1.7;margin-top:14px;text-align:left}
code{background:#0f1115;padding:2px 6px;border-radius:4px}
</style></head><body>
<div class="card">
<h1>DSH 远程授权</h1>
<p class="sub">authority：${host}</p>
${loopbackNote}
<a class="btn" href="${link}">在本设备打开授权链接</a>
<div class="qr">${svg}</div>
<input readonly value="${link}" onclick="this.select()">
<p class="note">· 其他设备：用相机/扫码工具扫上方二维码，或复制链接发给要授权的设备打开。<br>
· 链接含当前进程的一次性授权凭据；打开后浏览器即获得 30 天会话（重启 dsh web 不会失效）。<br>
· 本页与服务重启后链接会轮换——需要时重新打开本页获取。<br>
· 仅应在可信网络中使用本页。</p>
</div></body></html>`;
}

function qrSvg(text) {
  try {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag(4, 8);
  } catch {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220"><text x="110" y="110" font-size="12" text-anchor="middle">QR unavailable</text></svg>`;
  }
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  // Cordis may hand us explicit `undefined` for unset keys; dropping those
  // keeps the DEFAULTS intact (a plain spread would null them out).
  const overrides = Object.fromEntries(
    Object.entries(config ?? {}).filter(([, v]) => v !== undefined),
  );
  const cfg = {
    ...DEFAULTS,
    ...overrides,
    allowedAuthorities: Array.isArray(overrides.allowedAuthorities) ? overrides.allowedAuthorities : DEFAULTS.allowedAuthorities,
    allowedSubnets: Array.isArray(overrides.allowedSubnets) ? overrides.allowedSubnets : DEFAULTS.allowedSubnets,
    lockAfterFails: Number(overrides.lockAfterFails) > 0 ? Number(overrides.lockAfterFails) : DEFAULTS.lockAfterFails,
    lockSeconds: Number(overrides.lockSeconds) > 0 ? Number(overrides.lockSeconds) : DEFAULTS.lockSeconds,
    pin: String(overrides.pin ?? ""),
    originProtocol: overrides.originProtocol === "https" ? "https" : "http",
  };
  const fails = new Map(); // peer ip -> { count, until }

  const handler = (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      res.end("method not allowed");
      return;
    }
    const peer = normalizeIp(req.socket?.remoteAddress);
    const hostHeader = String(req.headers.host ?? "").trim().toLowerCase();
    if (!hostHeader) return sendText(res, 400, "missing Host header");

    // 1) origin fence — fail closed. OR semantics: the request passes when
    //    its Host header names an allowed authority, OR its source IP falls
    //    inside an allowed subnet (home LAN / Tailscale CGNAT). Loopback
    //    always passes both sides. Empty lists => loopback only.
    if (!(hostAllowed(hostHeader, cfg.allowedAuthorities) || peerAllowed(peer, cfg.allowedSubnets))) {
      return sendText(res, 403, "forbidden");
    }

    // 2) PIN gate (query param on GET; the form posts back to the same route).
    const url = new URL(req.url ?? "/", "http://dsh.invalid");
    const wantPlain = url.searchParams.get("plain") === "1";
    if (cfg.pin) {
      if (isLocked(fails, peer)) {
        const wait = Math.ceil((fails.get(peer).until - Date.now()) / 1000);
        return sendText(res, 429, `too many attempts; retry in ${wait}s`);
      }
      const attempt = url.searchParams.get("pin");
      if (!attempt) {
        if (wantPlain) return sendText(res, 401, "pin required (GET /mobile-auth?pin=...)");
        return sendHtml(res, 401, pinFormHtml());
      }
      if (!pinMatches(cfg.pin, attempt)) {
        recordFail(fails, peer, cfg);
        if (wantPlain) return sendText(res, 401, "bad pin");
        return sendHtml(res, 401, pinFormHtml().replace("</body>", '<div class="err">访问码错误</div></body>'));
      }
      fails.delete(peer);
    }

    // 3) mint the current-process token URL for THIS request authority.
    const origin = `${cfg.originProtocol}://${hostHeader}`;
    let tokenUrl;
    try {
      tokenUrl = ctx.connection.authenticatedUrl(origin);
    } catch (err) {
      return sendText(res, 500, `cannot build auth URL: ${String(err)}`);
    }

    if (wantPlain) return sendText(res, 200, tokenUrl);
    return sendHtml(
      res,
      200,
      pageHtml({
        tokenUrl,
        hostHeader,
        peerIsLoopback: isLoopbackIp(peer),
        cfg,
      }),
    );
  };

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/mobile-auth",
        handler,
      }),
    "dsh-remote-auth: /mobile-auth route",
  );
}

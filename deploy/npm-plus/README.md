# NPM Plus proxy setup — two single-lane hosts

Both proxy hosts forward to the **same** origin container on the LAN
(`http://192.168.1.25:<LANport>`). Each host carries exactly one auth method, so
we never need fragile "bearer-OR-session in one nginx location" logic.

> Replace `__LANPORT__` in `arh-api-advanced.conf` with the container's host port,
> and the `REPLACE_WITH_TOKEN_*` placeholders in `http-top.conf` with real
> secrets (`openssl rand -hex 32`). **Back up each proxy host's config before editing.**

## 0. HTTP-level snippet (once)

Install `http-top.conf` where NPM Plus includes http-context custom config
(confirm the exact path for your build). It defines the bearer allowlist
(`$arh_token_ok`) and the rate/conn zones the agent host uses. Reload nginx.

## 1. Host `arh.schmitzplex.com` — humans (Authelia)

- **Details:** Forward `192.168.1.25` : `<LANport>`, scheme `http`.
- **SSL:** wildcard cert, Force SSL + HTTP/2 + HSTS.
- **Auth:** enable NPM Plus's **Authelia** forward-auth (or Access List backed by
  Authelia) for the whole host. Humans log in with their normal session + 2FA
  from any browser, including phones.
- No custom Advanced config needed beyond enabling Authelia. The browser viewer's
  same-origin `/api/...` polling is covered by the same Authelia gate.
- **Session length:** Authelia's defaults are `inactivity: 5m` / `expiration: 1h`,
  which is far too short for a meeting left open in a background tab. Override
  them for this cookie domain in Authelia's `configuration.yml` (the viewer shows
  a "session expired" banner once the cookie dies, but the values below stop
  it happening mid-meeting):

  ```yaml
  session:
    cookies:
      - domain: schmitzplex.com
        authelia_url: https://auth.schmitzplex.com
        inactivity: 2h
        expiration: 12h
        remember_me: 1M
  ```

  Back up `configuration.yml` first; Authelia validates the file on restart.

## 2. Host `arh-api.schmitzplex.com` — agents (bearer)

- **Details:** Forward `192.168.1.25` : `<LANport>`, scheme `http`.
- **SSL:** wildcard cert, Force SSL + HTTP/2 + HSTS.
- **Auth:** do **not** enable Authelia. Paste `arh-api-advanced.conf` into
  **Advanced -> Custom Nginx Configuration**. It returns `401` unless a valid
  per-agent bearer token is present, rate-limits writes, caps concurrent
  long-polls, and raises `proxy_read_timeout` above the CLI's poll window.

## 3. Firewall (critical)

- Only `443 -> NPM Plus` is reachable from WAN.
- The origin `<LANport>` must be reachable **only** from the LAN + the proxy —
  never port-forwarded from the router. Verify from outside (see repo
  `DEPLOY.md`, Verification step 6).
- If the LAN is not fully trusted, put the container on a restricted VLAN: any
  device that can reach `<LANport>` directly can read/inject/close rooms with no
  token.

## DNS / cert

Confirm `arh.schmitzplex.com` and `arh-api.schmitzplex.com` both resolve to the
WAN entrypoint and are covered by the existing `*.schmitzplex.com` wildcard cert.

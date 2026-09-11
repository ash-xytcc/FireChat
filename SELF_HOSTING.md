# FireChat self-hosting contract

FireChat is being kept portable so the current Cloudflare-hosted web client can later move to a conventional VPS without changing the product model.

## Core rule

The FireChat web client must never depend on a specific hosting provider. Its only required service endpoint is the configured Matrix homeserver.

```text
VITE_MATRIX_HOMESERVER=https://matrix.example.org
```

Moving the frontend between Cloudflare, Caddy, nginx, or a container must not change Matrix account identity or encrypted room state.

## Future VPS shape

A normal self-hosted deployment can use separate containers behind one reverse proxy:

```text
Caddy / reverse proxy
├── FireChat static web client
├── Matrix homeserver
└── PostgreSQL
```

Matrix media should live on persistent storage outside the homeserver container. Large deployments may move media to separate object storage later.

## Homeserver requirements

A FireChat-controlled homeserver should provide:

- Matrix Client-Server API over HTTPS
- Matrix federation if federation is enabled for the deployment
- persistent PostgreSQL storage
- persistent Matrix media storage
- end-to-end encryption/device-key support compatible with current `matrix-js-sdk`
- cross-signing and secret-storage support
- recovery-key-based encrypted identity recovery
- registration that does not require email, phone number, legal name, or address-book access
- rate limiting and abuse controls that do not require identity collection

For FireChat native account creation, the server must expose a registration flow the client can complete without an email or phone identity stage. The current client supports direct registration and `m.login.dummy` UIA registration.

If a homeserver requires unsupported identity or anti-abuse stages, FireChat should refuse native signup rather than silently collect personal identity information.

## Identity warning

The Matrix server name becomes part of permanent Matrix user IDs. For example:

```text
@ash:matrix.firechat.example
```

Do not casually change the homeserver `server_name` after accounts are created. Moving the homeserver to a new VPS is normal; changing the Matrix server identity is a different migration problem.

## Moving the homeserver later

A VPS migration should preserve:

1. the same Matrix `server_name`
2. the PostgreSQL database
3. signing keys and homeserver secrets
4. Matrix media
5. TLS/domain routing
6. `.well-known` delegation if used

A normal host migration should therefore be a data-and-DNS move, not an account recreation.

## FireChat web-client migration

The FireChat frontend has no server-side state of its own. To move it to a VPS:

1. build with `npm run build`
2. serve `dist/` from Caddy/nginx or a static container
3. set `VITE_MATRIX_HOMESERVER` at build time
4. keep the same public domain if desired

The browser remains responsible for local session metadata, timeline cache, and local crypto state.

## Shared-hosting principle

FireChat can live on the same physical VPS as Bondfire, REC, Colophon, or Sabot services while remaining a separate application. Keep each service isolated by container, credentials, database/schema, persistent volume, and hostname.

A single VPS is a practical early deployment, but backups should be off-host and each service should remain movable to another machine independently.

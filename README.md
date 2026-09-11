# FireChat

FireChat is a standalone encrypted messaging client built on Matrix. It is extracted from the chat functionality developed inside Bondfire and does not depend on a Bondfire organization, route, account, or deployment.

The intended product is not "another Matrix client" as an end state. FireChat is designed to become a complete pseudonymous messaging service with its own compatible homeserver while still retaining Matrix federation and compatibility underneath.

## Release status

FireChat currently works as a standalone client for an existing Matrix account.

Native **Create account** works only when the configured homeserver permits a FireChat-compatible pseudonymous registration flow. The current public Matrix.org endpoint does not permit normal public registration, so FireChat account creation is not available there.

Until a FireChat-controlled homeserver exists, the practical standalone use case is:

- sign in with an existing Matrix account
- use Matrix rooms and end-to-end encryption through the FireChat interface
- recover/trust a device with the account recovery key
- fall back to emoji/SAS verification when needed

Once the FireChat homeserver is available, normal users should be able to create an account inside FireChat without knowing what Matrix or a homeserver is.

## Current functionality

- Matrix homeserver sign-in
- Pseudonymous account creation when the selected homeserver permits it
- No FireChat requirement for email, phone number, real name, or address-book upload
- Persistent local Matrix session
- IndexedDB timeline storage
- Rust Matrix end-to-end encryption initialization
- Recovery-key-first device trust
- SAS/emoji device verification fallback
- Joined and invited room discovery
- Encrypted-room indicators
- Room timelines and text messaging
- Member display names and avatars
- Optional hiding of undecryptable events
- Oldest-first or newest-first message ordering
- Responsive desktop/mobile interface

## Deployment model

The web client is intentionally provider-neutral. It is a static Vite application and can run on Cloudflare, a conventional web server, or a container on a VPS.

The default homeserver is configured with:

```text
VITE_MATRIX_HOMESERVER=https://matrix.example.org
```

Users can still enter another compatible homeserver in Advanced server settings.

The future FireChat service is expected to be:

```text
FireChat web client
        ↓
FireChat Matrix homeserver
        ↓
PostgreSQL + Matrix media storage
        ↓
Matrix federation
```

The client and homeserver do not need to run on the same machine.

See `SELF_HOSTING.md` for the deployment contract FireChat expects from a future homeserver and VPS migration.

## Run locally

```bash
npm install
npm run dev
```

Copy `.env.example` to `.env` to change the default homeserver:

```bash
cp .env.example .env
```

## Build

```bash
npm run build
```

## Local storage

FireChat stores session metadata in browser local storage and Matrix timeline/crypto state in IndexedDB. Storage names use the `firechat_` namespace and are independent of Bondfire.

Signing out clears the FireChat login session. Browser storage for Matrix timeline and crypto state remains local to that browser profile unless explicitly removed.

## Security notes

Matrix room encryption, cross-signing, recovery, and device verification are provided by `matrix-js-sdk` using the Rust crypto implementation.

A FireChat deployment should not claim stronger security than the underlying implementation has earned through review and operation. The intended privacy advantage is pseudonymous account creation without a phone number, email address, advertising identity, or mandatory contact-book disclosure.

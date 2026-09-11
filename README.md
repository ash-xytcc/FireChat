# FireChat

FireChat is a standalone encrypted Matrix chat client for collectives and communities. It is extracted from the chat functionality developed inside Bondfire and no longer depends on a Bondfire organization, route, account, or deployment.

## Current functionality

- Matrix homeserver sign-in
- Persistent local Matrix session
- IndexedDB timeline storage
- Matrix end-to-end encryption initialization
- SAS device verification
- Joined and invited room discovery
- Encrypted-room indicators
- Room timelines and text messaging
- Member display names and avatars
- Optional hiding of undecryptable events
- Oldest-first or newest-first message ordering
- Local Matrix storage reset
- Responsive desktop/mobile interface

FireChat does not run its own messaging protocol or central chat backend. It connects directly to the Matrix homeserver selected at sign-in.

## Run locally

```bash
npm install
npm run dev
```

The default homeserver is configured with `VITE_MATRIX_HOMESERVER`. Copy `.env.example` to `.env` to change the default for a deployment.

```bash
cp .env.example .env
```

Users can still enter a different homeserver on the sign-in screen.

## Build

```bash
npm run build
```

## Storage

FireChat uses browser local storage for session metadata and IndexedDB for Matrix timeline and crypto stores. Storage keys and database names use the `firechat_` namespace and are independent of Bondfire.

## Security notes

Matrix room encryption and device verification are provided by `matrix-js-sdk`. FireChat initializes Matrix crypto locally and does not proxy room contents through a Bondfire service.

Signing out clears the local FireChat session. **Reset local Matrix storage** also deletes FireChat's local Matrix timeline and crypto databases for the signed-in account.

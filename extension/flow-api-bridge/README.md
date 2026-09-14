# Flow API Bridge Chrome Extension (MV3)

Chrome Manifest V3 bridge extension connecting Google Flow (`labs.google`) to the local `antigravity2api-nodejs` server.

## Overview

The Flow API Bridge runs in Chrome MV3 and bridges generation, upload, polling, and download requests from the Node backend to Google Flow's private endpoints via WebSocket, solving enterprise reCAPTCHA in real-time.

## Security Boundaries & Design Principles

1. **Permission & Host Boundary**:
   - `host_permissions` are strictly restricted to `labs.google/*`, `aisandbox-pa.googleapis.com/*`, `storage.googleapis.com/*`, and `http://127.0.0.1:8045/*`.
   - No external third-party tracking, no `flow.kodelyx.in`, no human telemetry, and no remote HTTP callbacks.

2. **Bearer Token Lifetime & Isolation**:
   - Google Flow OAuth Bearer tokens (`ya29.*`) are kept **only in memory** or `chrome.storage.session`.
   - Google Flow tokens are **never** persisted to `chrome.storage.local`, never logged to console/storage, and never sent back over WebSocket.
   - Extension options (bridge WebSocket URL, `FLOW_EXTENSION_TOKEN`, `clientId`) are safely kept in `chrome.storage.local` as local bridge credentials.

3. **Controlled Endpoints & Path Allowlists**:
   - Only exact allowlisted endpoints under `aisandbox-pa.googleapis.com` and `storage.googleapis.com` are permitted.
   - reCAPTCHA tokens are injected into Node-provided structured payloads before dispatch. Arbitrary URLs are strictly rejected.
   - HTTP 401 unauthenticated responses invalidate cached session tokens and notify Node without blind resubmission.

4. **Resource Bounds**:
   - Downloads (`download_image`, `download_video`) enforce maximum size boundaries (100MB default limit) to prevent browser/Node memory exhaustion.

## Installation & Setup

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** toggle in the top right corner.
3. Click **Load unpacked** and select this directory (`extension/flow-api-bridge`).
4. Click the extension's **Options** page (or right-click extension icon -> Options):
   - **Bridge WebSocket URL**: Defaults to `ws://127.0.0.1:8045/internal/flow/ws`.
   - **FLOW_EXTENSION_TOKEN**: Enter the token matching your Node server's `FLOW_EXTENSION_TOKEN` (leave blank if connecting on loopback without auth).
   - **Client ID**: Stable identifier for your machine (e.g. `macbook-pro`).
5. Open <https://labs.google/fx/tools/flow> and sign in with your Google account.
6. The extension automatically detects your Flow session and projectId, establishing a bridge connection to your Node service.

## Operations Supported

- `get_credits`: Query user credits and paygate tier.
- `generate_image`: Image generation with reCAPTCHA enterprise solving (`batchGenerateImages`).
- `upload_image`: Upload image assets to Flow (`/v1/flow/uploadImage`).
- `submit_video`: Video generation (t2v, i2v, first_last, reference, edit).
- `poll_video`: Check async generation status (`batchCheckAsyncVideoGenerationStatus`).
- `download_image`: Download generated images from Google storage / fifeUrl.
- `download_video`: Download generated videos via `/v1/media/{mediaId}` as base64.
- `refresh_auth`: Trigger tab refresh to obtain a fresh Bearer token upon 401.
- `open_flow_tab`: Open or focus Google Flow tab.
- `get_status`: Inspect extension health, connection state, token presence, and metrics.

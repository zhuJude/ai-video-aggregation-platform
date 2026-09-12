# Browser-generated media fixtures

The commercial mock result in `lib/studio/mock-commercial-store.ts` is an original, locally
generated 64×64 H.264 color-card clip. It contains no third-party footage, audio, logo, or
metadata and is covered by this repository's license.

Audit recipe: Chromium `MediaRecorder` records six alternating color-card frames from a 64×64
`canvas.captureStream(5)` using `video/mp4;codecs=avc1.42E01E` at 64 kbps. The complete resulting
ISO-BMFF payload is stored as base64. Unit tests parse the top-level `ftyp`, `moov`, and `mdat`
boxes; Playwright additionally waits for `loadedmetadata` and asserts non-zero duration, width,
and height through the short-lived authenticated preview URL.

`localhost-cert.pem` and `localhost-key.pem` are a self-signed localhost-only test certificate
and key. They contain no production credential and allow the production build to exercise its
real `Secure`/`__Host-` cookie contract through the E2E HTTPS reverse proxy. They were generated
with OpenSSL 3 using RSA-2048, the `localhost` subject, and SANs for `localhost` and `127.0.0.1`.

# User web runtime configuration

Live authentication requires `USER_WEB_IDENTITY_VERIFY_KEYS_JSON`. It is a JSON array with one to
five entries shaped as `{ "kid": "...", "spki": "..." }`, where `spki` is the canonical base64url
encoding of an Ed25519 public key in DER SubjectPublicKeyInfo format. The key IDs and public material
must be provisioned from the same KMS-backed key set used by WS10 Identity to sign access tokens.

The application rejects missing or malformed keyrings, duplicate or unknown key IDs, non-Ed25519
keys, invalid signatures, and tokens with invalid issuer, audience, subject, session, time, or
not-before claims. Mock identity keys are used only when `USER_WEB_SUPPORT_MODE=mock`; live login
does not read them.

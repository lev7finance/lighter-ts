# Security Policy

`lighter-ts` signs financial transactions. Please treat weaknesses in key handling, signature
validity, transaction encoding, authentication, nonce management, or redaction as security issues.

## Supported versions

Until the first stable release, the latest `0.1.x` release and the current `main` branch receive
security fixes. Older prereleases are not supported.

## Report privately

Use GitHub's private vulnerability reporting flow:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Include the affected version or commit, runtime, reproduction steps, impact, and any suggested
   mitigation.

Do not open a public issue for a vulnerability. Do not include real private keys, auth tokens,
account credentials, or signatures made with production keys. Use newly generated throwaway
credentials and testnet wherever a reproduction needs signed material.

If private vulnerability reporting is unavailable, contact the repository owner through the
contact address on the owner's GitHub profile and ask for a private reporting channel. Do not send
the vulnerability details until that channel is established.

## What to expect

We will acknowledge a complete report, reproduce it, assess affected versions and runtimes, and
coordinate a fix and disclosure. Please allow time for users to update before publishing details.

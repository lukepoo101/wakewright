# 0012 Device passwords encrypted with an instance key

- Status: accepted
- Date: 2026-11-18

## Context

Wakewright logs in to each device with its remote administration password,
so it must keep the password, not a hash. The design rejected the device's
10-year automation token because it cannot be revoked without rotating the
device's signing secret. Backups of the database are copied around more
freely than the server's secrets.

## Decision

- Device passwords are encrypted with AES-256-GCM (`crypto.subtle`), a
  random 96-bit IV per value, and the secret's row id as additional data so
  a ciphertext moved to another row does not decrypt. Rows carry a key
  version for a future rotation.
- The 32-byte key comes from `WAKEWRIGHT__SECRET_KEY` or
  `WAKEWRIGHT__SECRET_KEY_FILE` (base64). Without either, it is generated
  into `<data dir>/secret.key` (mode 0600) on first start, so plain Docker
  works with no set-up; GitOps deployments supply their own.
- No API returns a password. Removing a device or replacing its password
  deletes the old secret.
- If the key changes, decryption fails cleanly: the device reports
  `secret_unreadable` and asks for the password again. Wakewright does not
  refuse to start, so collection from other devices and the clips stay
  available.

## Consequences

A generated key in the data directory protects database copies and
backups but not a copy of the whole volume; the configuration reference
says so. Key rotation (re-encrypting under a new key version) is not built
yet.

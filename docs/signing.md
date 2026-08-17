# Secure update signing

The Tauri desktop updater (added in PR5) refuses to install an update
unless the manifest's per-platform `signature` field verifies against
the embedded `pubkey`. This document explains how to set up that
trust chain end to end.

## Trust model

- One **minisign** Ed25519 keypair per repo. The private key signs
  release artifacts; the public key is embedded into every shipped
  `tauri.conf.json`.
- `release-desktop.yml`'s `sign` job writes the private key to a
  tempfile at build time, runs `minisign -Sm` over every dmg/exe,
  generates `update.json` from the resulting `.minisig` files, and
  uploads the manifest as a release asset.
- The desktop client fetches `update.json` from the **latest** GitHub
  Release, verifies each entry's signature against its embedded
  pubkey, and only then downloads + installs.

Without this chain the updater plugin returns `null` from `check()`
or throws on signature mismatch — UI surfaces the error verbatim.

## One-time setup (operator laptop)

```bash
# 1. Install minisign (macOS: brew install minisign; Linux: apt/dnf
#    equivalent; Windows: scoop install minisign or download the
#    binary from https://jedisct1.github.io/minisign/).

# 2. Generate the keypair. Pick a strong passphrase; losing it means
#    you can't sign future releases, leaking it means anyone can ship
#    a "Taco" update.
minisign -G -p taco-update.pub -s taco-update.key -W
# -W reads the passphrase from stdin so this is non-interactive.

# 3. Inspect the public key.
cat taco-update.pub
# Two lines: a comment + a base64 string. The base64 string is what
# tauri.conf.json wants.
```

## Embed the public key

Replace the `pubkey` placeholder in `clients/taco-desktop/src-tauri/tauri.conf.json`
(the `plugins.updater.pubkey` field) with the base64 string from
`taco-update.pub`. Commit that change to the repo so every shipped
binary carries the matching key.

The `taco-update.pub` and `taco-update.key` files themselves are
**never committed**. `.gitignore` covers `*.key`, `*.pub`, and
`taco-update.*` patterns; verify with `git check-ignore -v taco-update.key`
before adding anything else.

## Add the secrets to GitHub

In **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value |
|---|---|
| `MINISIGN_PRIVATE_KEY` | Full contents of `taco-update.key` (both the `untrusted comment:` header line and the base64 line below it; copy-paste verbatim). |
| `MINISIGN_PRIVATE_KEY_PASSPHRASE` | The passphrase you set in step 2. |

Both secrets are scoped to this repo. They never appear in logs
(GitHub auto-masks them) and only the `sign` job can read them via
`env:` — they're never written to `$GITHUB_ENV` or to artifacts.

To rotate the keypair (lost passphrase, suspected leak): generate a
new pair locally, update `tauri.conf.json`'s `pubkey`, and re-add
the secrets. The next release will then ship binaries signed by the
new key; older binaries still verify against their old pubkey until
they self-update.

## CI behaviour

`release-desktop.yml` adds two new pieces:

1. A **`sign`** job that runs `minisign -Sm` over every dmg/exe
   artifact from the `build` and `build-mac` jobs, producing
   `.minisig` sidecars. It also writes `update.json` containing
   per-platform `signature` (base64 of the `.minisig` file) and
   `url` (the GitHub release asset URL) entries.
2. The **`release`** job attaches `update.json` as a release asset
   alongside the signed artifacts.

After a tag push, `releases/latest/download/update.json` resolves to
the freshly generated manifest and clients pick it up on next launch.

## Verifying a release locally

```bash
# Download the manifest + artifacts for any tag.
gh release download desktop-v0.2.0

# Confirm the embedded pubkey matches your key.
grep pubkey clients/taco-desktop/src-tauri/tauri.conf.json

# Verify a signature by hand (minisign ships a verify command).
minisign -Vm taco-desktop-0.2.0.dmg -p taco-update.pub
```

A green "Signature verification succeeded" line means the artifact
came from whoever holds the private key — i.e., the CI run, given
the secret is properly scoped.

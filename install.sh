#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIN_MAJOR=22
BOOTSTRAP_MAJOR=26 # Current Active LTS line; minimum supported runtime remains Node.js 22+.
version_major() { node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0; }
if ! command -v node >/dev/null 2>&1 || [ "$(version_major)" -lt "$MIN_MAJOR" ]; then
  echo "Node.js 22+ is required. Bootstrapping the current Node.js 26 LTS release into ~/.local/share/motion-studio."
  OS="linux"; [ "$(uname -s)" = "Darwin" ] && OS="darwin"
  case "$(uname -m)" in x86_64|amd64) ARCH="x64" ;; aarch64|arm64) ARCH="arm64" ;; *) echo "Unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;; esac
  if [ "$OS" = "linux" ] && ! command -v tar >/dev/null 2>&1; then echo "tar is required to install Node.js." >&2; exit 1; fi
  command -v curl >/dev/null 2>&1 || { echo "curl is required to download Node.js." >&2; exit 1; }
  BASE="https://nodejs.org/dist/latest-v${BOOTSTRAP_MAJOR}.x"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  FILE="$(awk -v major="$BOOTSTRAP_MAJOR" -v os="$OS" -v arch="$ARCH" '$2 ~ ("^node-v" major "\\.[0-9]+\\.[0-9]+-" os "-" arch "\\.tar\\.xz$") {print $2}' "$TMP/SHASUMS256.txt" | tail -n 1)"
  [ -n "$FILE" ] || { echo "Could not find a Node.js $BOOTSTRAP_MAJOR binary for $OS/$ARCH." >&2; exit 1; }
  EXPECTED="$(awk -v file="$FILE" '$2 == file {print $1}' "$TMP/SHASUMS256.txt")"
  curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"
  if command -v sha256sum >/dev/null 2>&1; then ACTUAL="$(sha256sum "$TMP/$FILE" | awk '{print $1}')"; else ACTUAL="$(shasum -a 256 "$TMP/$FILE" | awk '{print $1}')"; fi
  [ "$EXPECTED" = "$ACTUAL" ] || { echo "Node.js archive checksum mismatch; aborting." >&2; exit 1; }
  INSTALL_ROOT="$HOME/.local/share/motion-studio/toolchain"
  mkdir -p "$INSTALL_ROOT" "$HOME/.local/bin"
  tar -xJf "$TMP/$FILE" -C "$INSTALL_ROOT"
  EXTRACTED="${FILE%.tar.xz}"
  ln -sfn "$INSTALL_ROOT/$EXTRACTED/bin/node" "$HOME/.local/bin/node"
  ln -sfn "$INSTALL_ROOT/$EXTRACTED/bin/npm" "$HOME/.local/bin/npm"
  ln -sfn "$INSTALL_ROOT/$EXTRACTED/bin/npx" "$HOME/.local/bin/npx"
  export PATH="$HOME/.local/bin:$INSTALL_ROOT/$EXTRACTED/bin:$PATH"
  PROFILE="$HOME/.profile"; [ "$OS" = "darwin" ] && PROFILE="$HOME/.zprofile"
  touch "$PROFILE"
  grep -q 'motion-studio local Node toolchain' "$PROFILE" || printf '\n# Motion Studio local Node toolchain\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$PROFILE"
fi
PROFILE="$HOME/.profile"; [ "$(uname -s)" = "Darwin" ] && PROFILE="$HOME/.zprofile"
touch "$PROFILE"
grep -q 'motion-studio local bin' "$PROFILE" || printf '\n# Motion Studio local bin\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$PROFILE"
export PATH="$HOME/.local/bin:$PATH"
cd "$ROOT"
node scripts/install.mjs "$@"

#!/usr/bin/env bash
# Install Glass Shell for the current user and enable it.
#
# Usage: scripts/install.sh [--force] [--no-enable]
#   --force      install on a GNOME version outside the tested list
#   --no-enable  copy the files but leave the extension disabled
#
# Running it twice gives the same result as running it once: the previous
# copy is replaced as a whole. Dock settings are not touched here; the
# extension backs them up itself the first time it changes them.

set -euo pipefail

# shellcheck source=scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

force=false
enable=true
for arg in "$@"; do
    case "$arg" in
        --force) force=true ;;
        --no-enable) enable=false ;;
        *) die "unknown option: $arg" ;;
    esac
done

# Check compatibility before changing anything on the desktop.
has_command gnome-extensions || die "gnome-extensions was not found. Is this a GNOME session?"
has_command glib-compile-schemas || die "glib-compile-schemas is required (package libglib2.0-bin)."

major="$(shell_major)" || die "Cannot read the GNOME Shell version."
if ! is_supported_major "$major"; then
    "$force" || die "GNOME Shell $major is not supported (tested: ${SUPPORTED_SHELL_MAJORS[*]}). Use --force to install anyway."
    warn "GNOME Shell $major is untested; installing because --force was given."
fi
[[ "$(session_type)" == "wayland" ]] || warn "Session is $(session_type); only Wayland has been validated."
extension_is_active "$REFERENCE_DOCK" || warn "Ubuntu Dock is not active; the dock will stay unstyled until it is."
for extension in "${BLUR_EXTENSIONS[@]}"; do
    extension_is_active "$extension" &&
        warn "$extension is active; Glass Shell will leave the surfaces it blurs untouched."
done

# Copy into a sibling directory first, then swap it in, so a failed copy
# never leaves a half-installed extension behind.
mkdir -p "$EXTENSIONS_DIR"
staging="$(mktemp -d "$EXTENSIONS_DIR/.glass-shell.XXXXXX")"
trap 'rm -rf "$staging"' EXIT

for file in "${PACKAGE_FILES[@]}"; do
    cp "$SRC_DIR/$file" "$staging/"
done
mkdir -p "$staging/schemas"
cp "$SRC_DIR/$SCHEMA_FILE" "$staging/schemas/"
glib-compile-schemas --strict "$staging/schemas"
cp "$REPO_ROOT/LICENSE" "$staging/"

rm -rf "$INSTALL_DIR"
mv "$staging" "$INSTALL_DIR"
trap - EXIT
info "Installed into $INSTALL_DIR"

if ! "$enable"; then
    info "Left disabled. Enable later with: gnome-extensions enable $UUID"
    exit 0
fi

# A running Wayland shell only discovers new extensions at login.
if gnome-extensions enable "$UUID" 2>/dev/null; then
    info "Enabled. If the shell had already loaded an older copy, log out and back in to use the new one."
else
    info "GNOME Shell will see the extension after you log out and back in."
    info "Then run: gnome-extensions enable $UUID"
fi

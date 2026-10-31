#!/usr/bin/env bash
# Build the installable extension archive in dist/.
#
# Usage: scripts/package.sh [--ego]
#   --ego  leave out gschemas.compiled, as extensions.gnome.org requires for
#          GNOME 45 and later (the shell compiles the schema on install)

set -euo pipefail

# shellcheck source=scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

for_ego=false
case "${1:-}" in
    --ego) for_ego=true ;;
    "") ;;
    *) die "unknown option: $1" ;;
esac

has_command zip || die "zip is required to build the archive."

# Stage into a fresh directory so files removed from the source tree never
# survive in a later archive.
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

for file in "${PACKAGE_FILES[@]}"; do
    [[ -f "$SRC_DIR/$file" ]] || die "missing source file: src/$file"
    cp "$SRC_DIR/$file" "$stage/"
done
mkdir -p "$stage/schemas"
cp "$SRC_DIR/$SCHEMA_FILE" "$stage/schemas/"
cp "$REPO_ROOT/LICENSE" "$stage/"

if ! "$for_ego"; then
    has_command glib-compile-schemas || die "glib-compile-schemas is required (package libglib2.0-bin)."
    glib-compile-schemas --strict "$stage/schemas"
fi

mkdir -p "$DIST_DIR"
archive="$DIST_DIR/$UUID.shell-extension.zip"
rm -f "$archive"
(cd "$stage" && zip -qr -X "$archive" .)
info "Built $archive"

#!/usr/bin/env bash
# Shared constants and helpers for the Glass Shell maintenance scripts.
# Source this file; it does nothing on its own.

# shellcheck disable=SC2034  # Variables are used by the scripts that source this file.

readonly UUID="glass-shell@finoana-randri.github.io"
readonly SCHEMA_ID="org.gnome.shell.extensions.glass-shell"
readonly SCHEMA_PATH="/org/gnome/shell/extensions/glass-shell/"
readonly DOCK_SCHEMA_ID="org.gnome.shell.extensions.dash-to-dock"
readonly REFERENCE_DOCK="ubuntu-dock@ubuntu.com"
readonly OTHER_DOCKS=("dash-to-dock@micxgx.gmail.com")
readonly BLUR_EXTENSIONS=("blur-my-shell@aunetx")
readonly SUPPORTED_SHELL_MAJORS=(46 47 48 49 50)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT
readonly SRC_DIR="$REPO_ROOT/src"
readonly DIST_DIR="$REPO_ROOT/dist"
readonly EXTENSIONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
readonly INSTALL_DIR="$EXTENSIONS_DIR/$UUID"
readonly STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/glass-shell"
readonly BACKUP_FILE="$STATE_DIR/dock-backup.tsv"

# Only these files are shipped; development files stay in the repository.
readonly PACKAGE_FILES=(
    metadata.json
    extension.js
    prefs.js
    stylesheet.css
    compat.js
    dockAdapter.js
    dockPreset.js
    glassEffect.js
    runtimeStyle.js
    settings.js
    surfaceController.js
)
readonly SCHEMA_FILE="schemas/$SCHEMA_ID.gschema.xml"

info() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

has_command() { command -v "$1" >/dev/null 2>&1; }

shell_version() {
    has_command gnome-shell || return 1
    gnome-shell --version 2>/dev/null | sed -n 's/^GNOME Shell \([0-9][0-9.a-z]*\).*/\1/p'
}

shell_major() {
    local version
    version="$(shell_version)" || return 1
    printf '%s' "${version%%.*}"
}

is_supported_major() {
    local major="$1" candidate
    for candidate in "${SUPPORTED_SHELL_MAJORS[@]}"; do
        [[ "$major" == "$candidate" ]] && return 0
    done
    return 1
}

session_type() { printf '%s' "${XDG_SESSION_TYPE:-unknown}"; }

# Prints the state reported by gnome-extensions (ACTIVE, INACTIVE, ...),
# or "missing" when the extension is not installed.
extension_state() {
    local state
    state="$(gnome-extensions info "$1" 2>/dev/null | sed -n 's/^ *State: *//p')"
    printf '%s' "${state:-missing}"
}

extension_is_active() {
    case "$(extension_state "$1")" in
        ACTIVE | ENABLED) return 0 ;;
        *) return 1 ;;
    esac
}

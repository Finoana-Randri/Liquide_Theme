#!/usr/bin/env bash
# Restore the dock settings Glass Shell changed, then disable and remove it.
#
# Usage: scripts/uninstall.sh [--purge]
#   --purge  also erase the Glass Shell preferences and state
#
# Other extensions and every setting Glass Shell did not change are left as
# they are.

set -euo pipefail

# shellcheck source=scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

purge=false
case "${1:-}" in
    --purge) purge=true ;;
    "") ;;
    *) die "unknown option: $1" ;;
esac

# Restore only settings that still match the values we applied; anything the
# user changed since then is theirs and stays.
restore_dock_settings() {
    if [[ ! -f "$BACKUP_FILE" ]]; then
        info "No dock backup found; dock settings are unchanged."
        return 0
    fi
    has_command gsettings || die "gsettings is required to restore the dock settings."

    local key before applied current
    local -a schemadir=()
    while IFS=$'\t' read -r key before applied; do
        case "$key" in
            '#schemadir')
                [[ -n "$before" ]] && schemadir=(--schemadir "$before")
                continue
                ;;
            '' | '#'*) continue ;;
        esac
        if ! current="$(gsettings "${schemadir[@]}" get "$DOCK_SCHEMA_ID" "$key" 2>/dev/null)"; then
            warn "Cannot read $key; the dock schema is missing. Skipping."
            continue
        fi
        if [[ "$current" == "$applied" ]]; then
            gsettings "${schemadir[@]}" set "$DOCK_SCHEMA_ID" "$key" "$before"
            info "Restored $key to $before"
        else
            info "Kept $key = $current (changed after Glass Shell set it)"
        fi
    done <"$BACKUP_FILE"
    rm -f "$BACKUP_FILE"
}

# Disable first: a running extension would apply the preset again as soon
# as its backup disappears.
if has_command gnome-extensions; then
    gnome-extensions disable "$UUID" 2>/dev/null || true
fi

restore_dock_settings

# Put back the desktop theme settings changed by install-appearance.sh.
"$(dirname "${BASH_SOURCE[0]}")/install-appearance.sh" --restore

if [[ -d "$INSTALL_DIR" ]]; then
    rm -rf "$INSTALL_DIR"
    info "Removed $INSTALL_DIR"
else
    info "Glass Shell was not installed in $INSTALL_DIR"
fi

if "$purge"; then
    if has_command dconf; then
        dconf reset -f "$SCHEMA_PATH"
        info "Erased Glass Shell preferences"
    fi
    rm -rf "$STATE_DIR"
fi

info "On Wayland the shell keeps the old code in memory until you log out."

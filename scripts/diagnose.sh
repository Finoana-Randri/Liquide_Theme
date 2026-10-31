#!/usr/bin/env bash
# Report the machine facts the specification asks for before development and
# before acceptance: system, GNOME, session, dock, GPU, monitors, blur
# extensions and the current dock settings. It changes nothing.
#
# Usage: scripts/diagnose.sh [--check]
#   --check  exit with status 1 when the configuration is not supported

set -euo pipefail

# shellcheck source=scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

check_only=false
case "${1:-}" in
    --check) check_only=true ;;
    "") ;;
    *) die "unknown option: $1" ;;
esac

problems=0
problem() {
    printf '  ! %s\n' "$*"
    problems=$((problems + 1))
}

section() { printf '\n== %s ==\n' "$1"; }

section "System"
if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091  # Provided by the distribution.
    (source /etc/os-release && printf '  OS: %s\n' "${PRETTY_NAME:-unknown}")
fi
printf '  Kernel: %s\n' "$(uname -r)"

section "GNOME Shell"
if version="$(shell_version)" && [[ -n "$version" ]]; then
    printf '  Version: %s\n' "$version"
    is_supported_major "${version%%.*}" ||
        problem "GNOME Shell ${version%%.*} is not in the tested list (${SUPPORTED_SHELL_MAJORS[*]})."
else
    problem "gnome-shell was not found; this does not look like a GNOME session."
fi
printf '  Session: %s\n' "$(session_type)"
[[ "$(session_type)" == "wayland" ]] ||
    problem "The reference configuration is Wayland; X11 has not been validated."

if has_command gsettings && [[ "$(gsettings get org.gnome.shell disable-user-extensions 2>/dev/null)" == "true" ]]; then
    problem "User extensions are disabled (org.gnome.shell disable-user-extensions)."
fi

section "Dock"
if has_command gnome-extensions; then
    printf '  %s: %s\n' "$REFERENCE_DOCK" "$(extension_state "$REFERENCE_DOCK")"
    for dock in "${OTHER_DOCKS[@]}"; do
        printf '  %s: %s\n' "$dock" "$(extension_state "$dock")"
    done
    extension_is_active "$REFERENCE_DOCK" || problem "Ubuntu Dock is not active."
    for dock in "${OTHER_DOCKS[@]}"; do
        if extension_is_active "$dock" && extension_is_active "$REFERENCE_DOCK"; then
            problem "$dock and Ubuntu Dock are both active; keep only one."
        fi
    done
    dock_version="$(gnome-extensions info "$REFERENCE_DOCK" 2>/dev/null | sed -n 's/^ *Version: *//p')"
    printf '  Ubuntu Dock version: %s\n' "${dock_version:-unknown}"
else
    problem "gnome-extensions is not installed."
fi

if has_command gsettings && gsettings list-keys "$DOCK_SCHEMA_ID" >/dev/null 2>&1; then
    for key in dock-position extend-height dock-fixed dash-max-icon-size intellihide autohide multi-monitor; do
        printf '  %s = %s\n' "$key" "$(gsettings get "$DOCK_SCHEMA_ID" "$key" 2>/dev/null || printf 'n/a')"
    done
fi

section "Blur extensions"
for extension in "${BLUR_EXTENSIONS[@]}"; do
    state="$(extension_state "$extension")"
    printf '  %s: %s\n' "$extension" "$state"
    [[ "$state" == "ACTIVE" || "$state" == "ENABLED" ]] &&
        printf '    Glass Shell will skip every surface this extension already blurs.\n'
done

section "Graphics"
if has_command lspci; then
    lspci -nnk | grep -EiA3 'vga|3d controller|display controller' | sed 's/^/  /' || true
else
    printf '  lspci not available\n'
fi
if has_command glxinfo; then
    glxinfo -B 2>/dev/null | grep -E 'OpenGL renderer|OpenGL version' | sed 's/^/  /' || true
fi

section "Monitors"
# Logical monitors are reported as (x, y, scale, transform, primary, ...).
if has_command gdbus; then
    state="$(gdbus call --session --dest org.gnome.Mutter.DisplayConfig \
        --object-path /org/gnome/Mutter/DisplayConfig \
        --method org.gnome.Mutter.DisplayConfig.GetCurrentState 2>/dev/null || true)"
    monitors="$(grep -oE '\(-?[0-9]+, -?[0-9]+, [0-9.]+, (uint32 )?[0-9]+, (true|false)' <<<"$state" || true)"
    if [[ -n "$monitors" ]]; then
        printf '  Count: %s\n' "$(wc -l <<<"$monitors")"
        while IFS=', ' read -r x y scale _ primary; do
            printf '  at %s,%s scale %s primary %s\n' "${x#(}" "$y" "$scale" "$primary"
        done <<<"${monitors//uint32 /}"
    else
        printf '  Not available from Mutter in this session\n'
    fi
fi

section "Glass Shell"
if has_command gnome-extensions; then
    printf '  State: %s\n' "$(extension_state "$UUID")"
fi
printf '  Installed in: %s\n' "$([[ -d "$INSTALL_DIR" ]] && printf '%s' "$INSTALL_DIR" || printf 'not installed')"
printf '  Dock backup: %s\n' "$([[ -f "$BACKUP_FILE" ]] && printf '%s' "$BACKUP_FILE" || printf 'none')"
if [[ -d "$INSTALL_DIR/schemas" ]] && has_command gsettings; then
    gsettings --schemadir "$INSTALL_DIR/schemas" get "$SCHEMA_ID" diagnostics 2>/dev/null |
        sed 's/^/  Messages: /' || true
fi

printf '\n'
if ((problems > 0)); then
    printf '%d problem(s) found.\n' "$problems"
    "$check_only" && exit 1
else
    printf 'Configuration matches the reference target.\n'
fi
exit 0

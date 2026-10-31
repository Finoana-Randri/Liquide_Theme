#!/usr/bin/env bash
# Runs inside the test container: installs Glass Shell and the harness,
# starts a headless GNOME Shell in Ubuntu mode and waits for the harness to
# finish its scenario. Screenshots and logs land in /out.

set -euo pipefail

readonly UUID="glass-shell@finoana-randri.github.io"
readonly HARNESS="glass-shell-harness@test"
readonly EXT_DIR="$HOME/.local/share/gnome-shell/extensions"

export XDG_RUNTIME_DIR=/tmp/runtime
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
export XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=ubuntu:GNOME XDG_SESSION_DESKTOP=ubuntu
export LANG=fr_FR.UTF-8 LC_ALL=fr_FR.UTF-8
export GSK_RENDERER=cairo NO_AT_BRIDGE=1 GLASS_OUT=/out GLASS_SHELL_DEBUG=1
export GLASS_QUICK="${GLASS_QUICK:-}"

rm -rf "${EXT_DIR:?}/$UUID" "${EXT_DIR:?}/$HARNESS"
mkdir -p "$EXT_DIR/$UUID" "$EXT_DIR/$HARNESS"
cp -r /src/. "$EXT_DIR/$UUID/"
glib-compile-schemas "$EXT_DIR/$UUID/schemas"
cp -r /harness/. "$EXT_DIR/$HARNESS/"

wallpaper="$(find /usr/share/backgrounds -maxdepth 1 -type f \( -name '*.png' -o -name '*.jpg' \) ! -name '*dimmed*' | sort | head -n 1)"
export GLASS_WALLPAPER="file://$wallpaper"

gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions "['$UUID', '$HARNESS']"
gsettings set org.gnome.shell favorite-apps "['org.gnome.TextEditor.desktop', 'org.gnome.Calculator.desktop', 'org.gnome.clocks.desktop', 'org.gnome.Characters.desktop']"
gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
gsettings set org.gnome.desktop.interface color-scheme 'prefer-dark'
gsettings set org.gnome.desktop.background picture-uri "$GLASS_WALLPAPER"
gsettings set org.gnome.desktop.background picture-uri-dark "$GLASS_WALLPAPER"

rm -f /out/done /out/harness.log
gnome-shell --headless --virtual-monitor "${GLASS_SIZE:-1600x900}" --mode=ubuntu --no-x11 >/out/shell.log 2>&1 &
shell_pid=$!

for _ in $(seq 600); do
    [[ -f /out/done ]] && break
    kill -0 "$shell_pid" 2>/dev/null || { echo "gnome-shell exited early" >&2; break; }
    sleep 1
done

# The extension writes these; keep a copy for the report.
gsettings --schemadir "$EXT_DIR/$UUID/schemas" get org.gnome.shell.extensions.glass-shell diagnostics >/out/diagnostics.txt 2>&1 || true
cp "$HOME/.local/state/glass-shell/dock-backup.tsv" /out/ 2>/dev/null || true
gsettings list-recursively org.gnome.shell.extensions.dash-to-dock | grep -E 'dock-position|extend-height|dash-max-icon-size' >/out/dock-settings-final.txt || true
kill "$shell_pid" 2>/dev/null || true
wait "$shell_pid" 2>/dev/null || true

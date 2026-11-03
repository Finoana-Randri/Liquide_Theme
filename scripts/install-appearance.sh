#!/usr/bin/env bash
# Install the desktop look that goes with Glass Shell: the WhiteSur icon,
# cursor and GTK/libadwaita themes, window buttons on the left and the Inter
# font when it is installed. WhiteSur is an open-source project with its own
# artwork; nothing from Apple is downloaded or installed.
#
# Usage:
#   scripts/install-appearance.sh [--color light|dark]
#   scripts/install-appearance.sh --restore
#
# Every desktop setting and file this script changes is backed up first and
# put back by --restore (also run by uninstall.sh). A value the user changed
# since then is left alone.

set -euo pipefail

# shellcheck source=scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# Pinned upstream versions, so a reinstall gives the same result.
readonly WHITESUR_GTK_REF="2026-09-10"
readonly WHITESUR_ICONS_REF="2026-09-10"
readonly WHITESUR_CURSORS_REF="e190baf618ed95ee217d2fd45589bd309b37672b"

readonly CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/glass-shell/upstream"
readonly APPEARANCE_BACKUP="$STATE_DIR/appearance-backup.tsv"
readonly GTK4_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/gtk-4.0"
readonly GTK4_BACKUP="$STATE_DIR/gtk-4.0.backup"

color="light"
restore=false
while (($# > 0)); do
    case "$1" in
        --color)
            color="${2:-}"
            shift
            ;;
        --restore) restore=true ;;
        *) die "unknown option: $1" ;;
    esac
    shift
done
[[ "$color" == "light" || "$color" == "dark" ]] || die "--color must be light or dark"

# Lines: schema<TAB>key<TAB>value before<TAB>value applied
restore_appearance() {
    if [[ -f "$APPEARANCE_BACKUP" ]]; then
        local schema key before applied current
        while IFS=$'\t' read -r schema key before applied; do
            [[ -z "$schema" || "$schema" == '#'* ]] && continue
            current="$(gsettings get "$schema" "$key" 2>/dev/null)" || continue
            if [[ "$current" == "$applied" ]]; then
                gsettings set "$schema" "$key" "$before"
                info "Restored $key to $before"
            else
                info "Kept $key = $current (changed after Glass Shell set it)"
            fi
        done <"$APPEARANCE_BACKUP"
        rm -f "$APPEARANCE_BACKUP"
    fi

    # WhiteSur's libadwaita option writes into ~/.config/gtk-4.0.
    if [[ -e "$GTK4_BACKUP" ]]; then
        rm -rf "$GTK4_DIR"
        if [[ -d "$GTK4_BACKUP/gtk-4.0" ]]; then
            cp -a "$GTK4_BACKUP/gtk-4.0" "$GTK4_DIR"
            info "Restored $GTK4_DIR"
        else
            info "Removed $GTK4_DIR (it did not exist before)"
        fi
        rm -rf "$GTK4_BACKUP"
    fi
    info "The WhiteSur themes stay installed; remove them with their own installers if you no longer want them."
}

if "$restore"; then
    restore_appearance
    exit 0
fi

# Check everything before touching the desktop.
for command in git gsettings gresource tar xz; do
    has_command "$command" ||
        die "$command is missing. Install it first: sudo apt install git xz-utils libglib2.0-bin"
done

# Clone or update one upstream repository at a pinned ref. It runs in the
# main shell (not in $(...)) so a failure stops the script.
fetch() {
    local repo="$1" ref="$2" dir="$CACHE_DIR/$1"
    if [[ ! -d "$dir/.git" ]]; then
        rm -rf "$dir"
        git clone --quiet "https://github.com/vinceliuice/$repo.git" "$dir" ||
            die "cannot download $repo; check the network connection."
    fi
    git -C "$dir" fetch --quiet --tags origin || die "cannot update $repo."
    git -C "$dir" checkout --quiet --detach "$ref" || die "$repo has no version $ref."
}

mkdir -p "$CACHE_DIR" "$STATE_DIR"

# Back up ~/.config/gtk-4.0 once, before WhiteSur links its libadwaita files.
if [[ ! -e "$GTK4_BACKUP" ]]; then
    mkdir -p "$GTK4_BACKUP"
    [[ -d "$GTK4_DIR" ]] && cp -a "$GTK4_DIR" "$GTK4_BACKUP/gtk-4.0"
fi

info "Installing WhiteSur icons ($WHITESUR_ICONS_REF)"
fetch WhiteSur-icon-theme "$WHITESUR_ICONS_REF"
(cd "$CACHE_DIR/WhiteSur-icon-theme" && ./install.sh -t default >/dev/null)

info "Installing WhiteSur cursors"
fetch WhiteSur-cursors "$WHITESUR_CURSORS_REF"
(cd "$CACHE_DIR/WhiteSur-cursors" && ./install.sh >/dev/null)

info "Installing WhiteSur GTK and libadwaita theme ($WHITESUR_GTK_REF)"
fetch WhiteSur-gtk-theme "$WHITESUR_GTK_REF"
# The prebuilt archives in release/ need no compiler, never prompt and give
# the same files on every machine, unlike the interactive upstream installer.
themes_dir="${XDG_DATA_HOME:-$HOME/.local/share}/themes"
mkdir -p "$themes_dir"
for variant in Light Dark; do
    rm -rf "${themes_dir:?}/WhiteSur-$variant"
    tar -xJf "$CACHE_DIR/WhiteSur-gtk-theme/release/WhiteSur-$variant.tar.xz" -C "$themes_dir" ||
        die "cannot unpack WhiteSur-$variant."
done

# libadwaita applications ignore the GTK theme setting and only read
# ~/.config/gtk-4.0. The theme ships its GTK 4 files in a resource bundle;
# unpack it there, keeping the relative paths its stylesheet expects.
if [[ "$color" == "dark" ]]; then variant="Dark"; else variant="Light"; fi
bundle="$themes_dir/WhiteSur-$variant/gtk-4.0/gtk.gresource"
mkdir -p "$GTK4_DIR"
rm -rf "${GTK4_DIR:?}/"{gtk.css,gtk-dark.css,assets,windows-assets}
while read -r resource; do
    target="$GTK4_DIR/${resource#/org/gnome/theme/}"
    mkdir -p "$(dirname "$target")"
    gresource extract "$bundle" "$resource" >"$target"
done < <(gresource list "$bundle")

# Remember the previous value of each setting once, then apply ours.
set_desktop() {
    local schema="$1" key="$2" value="$3" before
    before="$(gsettings get "$schema" "$key")"
    if ! grep -q "^$schema"$'\t'"$key"$'\t' "$APPEARANCE_BACKUP" 2>/dev/null; then
        gsettings set "$schema" "$key" "$value"
        printf '%s\t%s\t%s\t%s\n' "$schema" "$key" "$before" "$(gsettings get "$schema" "$key")" >>"$APPEARANCE_BACKUP"
    else
        gsettings set "$schema" "$key" "$value"
        # Keep the original "before" and record the new applied value.
        local tmp
        tmp="$(mktemp)"
        awk -F'\t' -v OFS='\t' -v s="$schema" -v k="$key" -v a="$(gsettings get "$schema" "$key")" \
            '$1 == s && $2 == k { $4 = a } { print }' "$APPEARANCE_BACKUP" >"$tmp"
        mv "$tmp" "$APPEARANCE_BACKUP"
    fi
}

if [[ "$color" == "dark" ]]; then
    gtk_theme="WhiteSur-Dark"
    icon_theme="WhiteSur-dark"
    scheme="prefer-dark"
else
    gtk_theme="WhiteSur-Light"
    icon_theme="WhiteSur"
    scheme="default"
fi

set_desktop org.gnome.desktop.interface gtk-theme "'$gtk_theme'"
set_desktop org.gnome.desktop.interface icon-theme "'$icon_theme'"
set_desktop org.gnome.desktop.interface cursor-theme "'WhiteSur-cursors'"
set_desktop org.gnome.desktop.interface color-scheme "'$scheme'"
set_desktop org.gnome.desktop.wm.preferences button-layout "'close,minimize,maximize:'"
# Day, date and time in the top bar clock.
set_desktop org.gnome.desktop.interface clock-show-weekday "true"
set_desktop org.gnome.desktop.interface clock-show-date "true"

# Original wallpapers made for this project: a light one and a dark one that
# GNOME switches between with the colour scheme.
wallpaper_dir="${XDG_DATA_HOME:-$HOME/.local/share}/backgrounds/glass-shell"
mkdir -p "$wallpaper_dir"
cp "$REPO_ROOT/assets/wallpapers/glass-shell-dawn.jpg" "$REPO_ROOT/assets/wallpapers/glass-shell-dusk.jpg" "$wallpaper_dir/"
set_desktop org.gnome.desktop.background picture-uri "'file://$wallpaper_dir/glass-shell-dawn.jpg'"
set_desktop org.gnome.desktop.background picture-uri-dark "'file://$wallpaper_dir/glass-shell-dusk.jpg'"
set_desktop org.gnome.desktop.background picture-options "'zoom'"
if has_command fc-list && fc-list | grep -qi 'Inter'; then
    set_desktop org.gnome.desktop.interface font-name "'Inter 10'"
    set_desktop org.gnome.desktop.wm.preferences titlebar-font "'Inter Semi-Bold 10'"
else
    info "Inter font not found; keeping the current font (sudo apt install fonts-inter to use it)."
fi

info "Done. Applications already open pick up the new theme when restarted."

# Glass Shell

Liquid glass surfaces for GNOME Shell on Ubuntu, for a desktop in the spirit
of current macOS: a floating, bottom-centred Ubuntu Dock with a magnifying
wave, a slim translucent top bar with the clock on the right, and glass on
every popup menu, quick settings, the calendar, notification banners, the
volume pop-up and the Alt+Tab switcher. The surfaces use a real background
blur, a light tint with a static top reflection, an inner glow and a crisp
specular rim.

An optional script installs the matching application look from the
open-source WhiteSur project (icons, cursors, GTK and libadwaita theme, window
buttons on the left). No Apple artwork, fonts or resources are used anywhere.

> **Status: prototype (0.1.0).** The code has not yet been run on the
> reference machine. Step 1 and 2 of the specification (record the real
> configuration, then validate the dock prototype) come next. See
> [docs/RAPPORT_RECETTE.md](docs/RAPPORT_RECETTE.md).

## Target

| Item | Reference |
| --- | --- |
| System | Ubuntu Desktop |
| Shell | GNOME Shell 46 to 50 (declared in `metadata.json`, to be narrowed after testing) |
| Session | Wayland |
| Dock | Ubuntu Dock (`ubuntu-dock@ubuntu.com`) |
| Optional | Dash to Dock, behind the "Habiller aussi Dash to Dock" switch |

X11, other docks and real refraction (pixel distortion) are out of scope for
version 1.

## Testing with real screenshots

`tests/visual/` runs a real headless GNOME Shell 46 with Ubuntu Dock and the
WhiteSur look in Docker, drives it with a test-only extension (virtual pointer
and keyboard, real windows, menus, notifications, Alt+Tab, 20 enable/disable
cycles) and saves screenshots to `tests/visual/out/`:

```bash
docker build -f tests/visual/Dockerfile -t glass-shell-test:noble .
```

```bash
docker run --rm --user root --shm-size=1g -v "$PWD/src:/src:ro" -v "$PWD/tests/visual/harness:/harness:ro" -v "$PWD/tests/visual/session.sh:/session.sh:ro" -v "$PWD/tests/visual/entrypoint.sh:/entrypoint.sh:ro" -v "$PWD/tests/visual/out:/out" glass-shell-test:noble bash /entrypoint.sh
```

Rendering uses Mesa llvmpipe: the images are faithful, but frame timings from
the container say nothing about real hardware. Selected captures are kept in
[docs/captures](docs/captures).

## Repository layout

```
src/                     Everything that ships in the extension
  extension.js           Lifecycle: enable() builds, disable() tears down
  settings.js            Preferences + desktop accessibility -> one "look"
  glassEffect.js         Glass material: blur layer, tint, rim
  dockAdapter.js         Ubuntu Dock adapter and icon feedback
  dockPreset.js          Backup/restore of the dock settings we change
  surfaceController.js   Top bar, quick settings, calendar, banners
  runtimeStyle.js        Generated stylesheet for numeric preferences
  compat.js              Version-dependent and internal Shell access
  prefs.js               GTK 4 / libadwaita preferences window (French)
  stylesheet.css         Static, prefixed styles
  schemas/               GSettings schema
scripts/                 Development and maintenance only, never shipped
  diagnose.sh            Record the machine configuration
  install.sh             Install for the current user
  uninstall.sh           Restore dock settings, disable, remove
  package.sh             Build dist/<uuid>.shell-extension.zip
docs/                    User guide (French) and acceptance report
```

## Build and lint

```bash
npm install
npm run lint
```

`npm run lint` runs ESLint on the JavaScript and ShellCheck on the scripts.
ShellCheck comes from the `shellcheck` package (`sudo apt install shellcheck`).

```bash
scripts/package.sh
```

Builds `dist/glass-shell@finoana-randri.github.io.shell-extension.zip` with a
compiled schema. Pass `--ego` to build the variant for extensions.gnome.org,
which must not contain `gschemas.compiled`.

## Install

```bash
scripts/diagnose.sh
```

```bash
scripts/install.sh
```

The installer checks the GNOME version, session type, active dock and blur
extensions before copying anything into
`~/.local/share/gnome-shell/extensions/`. It refuses an untested GNOME version
unless `--force` is given. Running it twice gives the same result.

On Wayland the running shell only discovers a new extension at login. Log out,
log back in, then:

```bash
gnome-extensions enable glass-shell@finoana-randri.github.io
```

Preferences:

```bash
gnome-extensions prefs glass-shell@finoana-randri.github.io
```

## Desktop look (icons, windows, cursors)

```bash
scripts/install-appearance.sh --color light
```

Installs, for the current user only, pinned versions of the WhiteSur icon
theme, cursors and GTK theme (from the prebuilt archives of the upstream
repositories, so no compiler and no prompts), unpacks the GTK 4 files into
`~/.config/gtk-4.0` so libadwaita applications follow, puts the window buttons
on the left and uses the Inter font when `fonts-inter` is installed. Use
`--color dark` for the dark variant. Requirements: `git`, `xz-utils`,
`libglib2.0-bin`.

Every setting it changes, and the previous `~/.config/gtk-4.0`, is backed up
first; `scripts/install-appearance.sh --restore` (also run by
`uninstall.sh`) puts them back, except values you changed afterwards.

WhiteSur is a separate project by Vince Liuice (GTK theme: MIT; icons and
cursors: GPL-3.0). Its artwork is original and is downloaded from its own
repositories; it is not part of this repository.

## Disable, recover, uninstall

```bash
gnome-extensions disable glass-shell@finoana-randri.github.io
```

If the shell misbehaves and the desktop is hard to use, switch to a text
console (Ctrl+Alt+F3), log in and turn off every user extension, then return
with Ctrl+Alt+F2 (or F1) and log in again:

```bash
gsettings set org.gnome.shell disable-user-extensions true
```

Turn extensions back on later with the same command and `false`.

To remove the extension and restore the dock settings it changed:

```bash
scripts/uninstall.sh
```

Add `--purge` to also erase the Glass Shell preferences. The uninstaller only
restores dock values that still match what Glass Shell applied; anything you
changed afterwards is kept.

## How it works

### The glass material

Each surface gets three actors placed under its content:

1. **Blur layer**: an empty actor carrying `Shell.BlurEffect` in background
   mode. It blurs what is behind it, never the icons or text, because those
   are not its children.
2. **Tint**: a translucent vertical gradient. The top of the gradient is the
   static reflection; nothing animates in a loop.
3. **Rim**: a 1 px light border and a soft inner glow.

The blur follows windows moving behind the dock because it reads the
framebuffer every frame the surface is painted.

### Rounded corners

`Shell.BlurEffect` only paints rectangles. A CSS radius on the same actor
does not clip it. With the default `inset` strategy, the blurred rectangle is
shrunk by `r × (1 − 1/√2)` on each side, the largest rectangle that fits
inside the rounded shape, so nothing leaks past the corners. The thin band
along the edges that the blur does not cover sits under the rim glow. The
`full` strategy (hidden setting `corner-strategy`) blurs the whole rectangle
and exists to compare both on the prototype. A shader-based mask is a version
2 candidate.

### Where the dock glass goes

Ubuntu Dock's `dash` actor is always redirected offscreen, and a background
blur inside it would read an empty buffer. The glass is therefore inserted as
a zero-sized sibling of the dash in the dock box and follows the dash
allocation. The native dash background is kept for its geometry and made
invisible. Any ancestor that is redirected offscreen permanently disables the
blur for that surface (tint only), and fading ancestors pause it.

### Settings

- Visual values reach our own actors as inline styles.
- Values that apply to dock or shell actors (padding, spacing, margin, menu
  radius) go into a generated stylesheet in `$XDG_RUNTIME_DIR`, because the
  dock overwrites inline styles on its own actors.
- Changes are grouped for 150 ms so a moving slider does not restyle the
  shell on every step.

### Dock settings that Glass Shell changes

Only these keys of `org.gnome.shell.extensions.dash-to-dock`, and only when
"Préréglage bas et centré" is on:

| Key | Value | When |
| --- | --- | --- |
| `dock-position` | `'BOTTOM'` | Once |
| `extend-height` | `false` | Once |
| `dash-max-icon-size` | icon size preference | Once, and whenever that preference changes |
| `show-apps-at-top` | `true` (applications button first) | Once |
| `running-indicator-style`, `custom-theme-*running-dots*` | small neutral dots | Once |

The previous value of each is written to
`~/.local/state/glass-shell/dock-backup.tsv` the first time. A value set once
is never forced again, so changing the dock position in the Ubuntu settings
afterwards sticks. Disabling the extension (which also happens when the
screen locks) does not touch the dock settings; restoring them is an explicit
action in the preferences window or `scripts/uninstall.sh`.

### Conflicts

Before styling a surface, Glass Shell looks for a `Shell.BlurEffect` that
another extension attached to it. If it finds one, it leaves that surface
alone and reports it in the preferences window (Performance → Compatibilité
et conflits). Other extensions are never disabled. If Ubuntu Dock and Dash to
Dock are both active, the dock is left unstyled.

### Internal API

Every access to an undocumented property is listed at the top of the module
that uses it, with what happens when it disappears:

| Module | Internal | Fallback |
| --- | --- | --- |
| dockAdapter.js | `dock._box`, `dock.dash` | Search by actor name |
| dockAdapter.js | `dash._background` | Search by style class |
| dockAdapter.js | `dash._box` | Hover magnification off |
| dockAdapter.js | `dock._slider.slideX` | Blur stays on while hidden |
| surfaceController.js | `Main.messageTray._bannerBin` | Banners unstyled |
| surfaceController.js | `BoxPointer.prototype.open` (wrapped, restored on disable) | Menus unstyled |
| surfaceController.js | `OsdWindow.prototype.show`, `osdWindow._hbox` | Volume pop-up unstyled |
| surfaceController.js | `SwitcherPopup.prototype.show`, `_switcherList` | Alt+Tab unstyled |
| surfaceController.js | `Main.panel._rightBox` | Clock stays centred |

Popup menus are normally always rendered offscreen (`BoxPointer`), which
would hand the background blur an empty buffer. While a menu wears glass it is
only redirected offscreen during its fade animation, and the blur pauses for
that time.

## Performance

Profiles: **Qualité** (full blur), **Équilibré** (default, 75 % blur radius),
**Économie** (no blur, more opaque tint). The blur is removed when it is not
needed (radius 0), paused while a surface fades or the dock is slid out, and
nothing runs between frames. The measurement protocol is in
[docs/RAPPORT_RECETTE.md](docs/RAPPORT_RECETTE.md).

## Accessibility

- GNOME "Animations" off: no magnification and instant transitions.
- High contrast: tint at least 90 % opaque, no reflections, stronger rim.
- Reduced effects / reduced transparency switches in the preferences.
- Text surfaces (top bar, menus, banners) keep a minimum tint for legibility.
- Keyboard focus on dock icons uses an orange ring and a light fill.

## License

GPL-2.0-or-later, see [LICENSE](LICENSE). Ubuntu, Yaru and GNOME are
trademarks of their respective owners; Glass Shell only references the icons
already installed on the system and does not ship any of them.

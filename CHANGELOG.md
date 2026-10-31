# Changelog

## 0.2.0 — 2026-10-31

Design rework towards a current macOS-style desktop, checked with real
screenshots of GNOME Shell 46 in Docker.

- Glass material reworked: whiter and lighter tint, stronger blur, inner
  glow layer and a crisp specular line along the top edge.
- Glass on every popup menu (panel menus, dock context menus, window
  previews), the volume pop-up (lifted above the dock) and Alt+Tab.
- Slim top bar with the clock on the right; notification banners in the
  top-right corner.
- Dock: magnifying wave on neighbouring icons, applications button first,
  small neutral running dots.
- New `scripts/install-appearance.sh`: WhiteSur icons, cursors, GTK and
  libadwaita theme, window buttons on the left, Inter font; fully reversible.
- Fixed: rectangular shadow cut by the dock slide container; dimmed blur edge
  in dark mode; quick settings glass never sized; menus never blurred because
  BoxPointer is always redirected offscreen.
- Visual test harness in `tests/visual/`.

## 0.1.0 — 2026-10-31

First prototype, not yet run on the reference machine.

- Glass material: background blur layer, gradient tint with static top
  reflection, thin rim and soft shadow.
- Ubuntu Dock adapter with bottom-centred preset, backup and restore of the
  three dock settings it changes, hover magnification and press feedback.
- Top bar, quick settings, calendar menu and notification banners, each with
  its own switch.
- Quality, Balanced and Economy profiles; reduced effects and reduced
  transparency; high contrast and GNOME animation settings respected.
- Detection of other blur extensions and of two docks active together.
- French preferences window with Apparence, Dock, Surfaces and Performance.
- Install, uninstall, diagnose and package scripts.

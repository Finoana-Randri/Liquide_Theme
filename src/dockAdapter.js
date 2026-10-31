// Dresses the dock provided by Ubuntu Dock (or, optionally, Dash to Dock) in
// glass. The dock keeps doing everything itself: favourites, launching,
// running indicators, menus, autohide. This module only adds actors and
// classes, and removes them again.
//
// Internal dock API used here, and the fallback when it disappears:
//   dock._box, dock.dash   -> searched by actor name (dashtodockBox, dash)
//   dock._slider.slideX    -> blur simply stays on while the dock is hidden
//   dash._background       -> searched by style class (dash-background)
//   dash._box              -> hover magnification is turned off
//   dash.showAppsButton    -> the show-apps button is not magnified

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {addLater, extensionPath, isExtensionActive, KNOWN_BLUR_EXTENSIONS, removeLater} from './compat.js';
import {DockPreset, lookupDockSettings} from './dockPreset.js';
import {findForeignBlur, GlassSurface} from './glassEffect.js';
import {MAGNIFICATION} from './settings.js';

const DOCK_PROVIDERS = [
    {uuid: 'ubuntu-dock@ubuntu.com', label: 'Ubuntu Dock', reference: true},
    {uuid: 'dash-to-dock@micxgx.gmail.com', label: 'Dash to Dock', reference: false},
];

const DOCK_CONTAINER_NAME = 'dashtodockContainer';
const PRESS_SCALE = 0.94;
const PRESS_DURATION_MS = 80;
// Share of the full magnification given to the hovered icon (distance 0)
// and to its neighbours.
const NEIGHBOUR_WAVE = [1, 0.45, 0.15];

function findDescendant(root, predicate, maxDepth = 8) {
    if (!root)
        return null;
    const stack = [[root, 0]];
    while (stack.length > 0) {
        const [actor, depth] = stack.pop();
        if (predicate(actor))
            return actor;
        if (depth < maxDepth) {
            for (const child of actor.get_children())
                stack.push([child, depth + 1]);
        }
    }
    return null;
}

function findIcon(button) {
    return findDescendant(button, actor => actor instanceof St.Icon, 4);
}

// Hover magnification and press feedback. Only the icon is scaled, around its
// centre, inside the padding of its button: the button allocation, and so the
// click target, never moves.
class IconFeedback {
    constructor(dash) {
        this._dash = dash;
        this._iconBox = dash._box ?? null;
        this._buttons = new Set();
        this._order = [];
        this._options = {magnify: false, durationMs: 0};
        this._scanId = 0;

        const queueScan = () => this._queueScan();
        this._iconBox?.connectObject('child-added', queueScan, 'child-removed', queueScan, this);
        dash.connectObject('icon-size-changed', queueScan, this);
        this._queueScan();
    }

    setOptions(options) {
        this._options = options;
        this._updateAll();
    }

    _queueScan() {
        if (this._scanId)
            return;
        this._scanId = addLater(() => {
            this._scanId = 0;
            this._scan();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scan() {
        const current = [];
        for (const item of this._iconBox?.get_children() ?? []) {
            const button = item.child ?? item.get_first_child();
            if (button instanceof St.Button)
                current.push(button);
        }
        const showApps = this._dash.showAppsButton;
        if (showApps instanceof St.Button)
            current.push(showApps);

        for (const button of [...this._buttons]) {
            if (!current.includes(button))
                this._release(button);
        }
        for (const button of current) {
            if (!this._buttons.has(button))
                this._track(button);
        }
        // Visual order, so neighbours of the hovered icon can be found.
        this._order = current;
        this._updateAll();
    }

    _track(button) {
        this._buttons.add(button);
        button.connectObject(
            'notify::hover', () => this._updateAll(),
            'notify::pressed', () => this._updateAll(),
            'destroy', () => this._buttons.delete(button),
            this);
    }

    _release(button) {
        this._buttons.delete(button);
        button.disconnectObject(this);
        const icon = findIcon(button);
        if (icon) {
            icon.remove_all_transitions();
            icon.set_scale(1, 1);
        }
    }

    // The hovered icon grows the most and its neighbours follow with a
    // smaller wave. Every step stays inside the button padding computed in
    // runtimeStyle.js, so icons never overlap or get clipped.
    _updateAll() {
        const order = (this._order ?? []).filter(button => this._buttons.has(button));
        const hovered = this._options.magnify ? order.findIndex(button => button.hover) : -1;
        order.forEach((button, index) => {
            const distance = hovered < 0 ? Infinity : Math.abs(index - hovered);
            const wave = NEIGHBOUR_WAVE[distance] ?? 0;
            this._update(button, 1 + (MAGNIFICATION - 1) * wave);
        });
    }

    _update(button, target) {
        const icon = findIcon(button);
        if (!icon)
            return;
        const scale = button.pressed ? target * PRESS_SCALE : target;
        if (Math.abs(icon.scale_x - scale) < 0.001 && !icon.get_transition('scale-x'))
            return;
        // The press is shortened so a click is felt immediately.
        const duration = button.pressed
            ? Math.min(PRESS_DURATION_MS, this._options.durationMs)
            : this._options.durationMs;
        icon.set_pivot_point(0.5, 0.5);
        icon.ease({
            scale_x: scale,
            scale_y: scale,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    destroy() {
        removeLater(this._scanId);
        this._scanId = 0;
        this._iconBox?.disconnectObject(this);
        this._dash.disconnectObject(this);
        for (const button of [...this._buttons])
            this._release(button);
    }
}

class DockGlass {
    constructor(dock) {
        const box = dock._box ?? findDescendant(dock, actor => actor.name === 'dashtodockBox');
        const dash = dock.dash ?? findDescendant(box, actor => actor.name === 'dash');
        if (!box || !dash || !box.contains(dash))
            throw new Error('unrecognised dock layout');

        this._dock = dock;
        this._dockDestroyed = false;
        dock.connectObject('destroy', () => {
            this._dockDestroyed = true;
        }, this);

        // The native background stays in place for its geometry and theme
        // logic, but is made invisible: the glass takes its role.
        this._background = dash._background ??
            findDescendant(dash, actor => actor.has_style_class_name?.('dash-background'), 2);
        this._backgroundOpacity = this._background?.opacity ?? 255;
        if (this._background)
            this._background.opacity = 0;

        dock.add_style_class_name('glass-shell-dock');

        // The dash is always redirected offscreen, so the glass goes next to
        // it in the dock box rather than inside it. The dash padding (set by
        // the runtime stylesheet) gives the glass its inner margin.
        this._surface = new GlassSurface({id: 'dock', host: box, target: dash});

        this._slider = dock._slider ?? null;
        if (this._slider && 'slideX' in this._slider) {
            this._slider.connectObject('notify::slide-x', () => this._syncSuspended(), this);
            this._syncSuspended();
        }

        this._icons = new IconFeedback(dash);
    }

    get blurSupported() {
        return this._surface.blurSupported;
    }

    // No blur work for a dock that has fully slid out of view.
    _syncSuspended() {
        this._surface.setSuspended(this._slider.slideX <= 0.001);
    }

    setLook(look) {
        this._surface.setLook(look);
        this._icons.setOptions({magnify: look.magnify, durationMs: look.durationMs});
    }

    destroy() {
        this._icons.destroy();
        this._slider?.disconnectObject(this);
        this._surface.destroy();
        this._dock.disconnectObject(this);
        if (this._dockDestroyed)
            return;
        this._dock.remove_style_class_name('glass-shell-dock');
        if (this._background)
            this._background.opacity = this._backgroundOpacity;
    }
}

export class DockAdapter {
    constructor({diagnostics}) {
        this._diagnostics = diagnostics;
        this._docks = new Map();
        this._look = null;
        this._rescanId = 0;
        this._preset = null;
        this._presetProvider = null;

        const watched = new Set([
            ...DOCK_PROVIDERS.map(provider => provider.uuid),
            ...KNOWN_BLUR_EXTENSIONS.map(extension => extension.uuid),
        ]);
        const queue = () => this._queueRescan();
        Main.extensionManager.connectObject('extension-state-changed', (_manager, extension) => {
            if (watched.has(extension.uuid))
                queue();
        }, this);
        Main.layoutManager.uiGroup.connectObject(
            'child-added', (_group, actor) => actor.name === DOCK_CONTAINER_NAME && queue(),
            'child-removed', (_group, actor) => actor.name === DOCK_CONTAINER_NAME && queue(),
            this);
        Main.layoutManager.connectObject('monitors-changed', queue, this);
    }

    update(look) {
        this._look = look;
        for (const glass of this._docks.values())
            glass.setLook(look);
        this._queueRescan();
    }

    _queueRescan() {
        if (this._rescanId)
            return;
        this._rescanId = addLater(() => {
            this._rescanId = 0;
            this._rescan();
            return GLib.SOURCE_REMOVE;
        });
    }

    _activeProvider(look) {
        const active = DOCK_PROVIDERS.filter(provider => isExtensionActive(provider.uuid));
        if (active.length > 1) {
            this._diagnostics.report('dock',
                `${active.map(p => p.label).join(' et ')} sont actifs en même temps ; ` +
                'désactivez-en un. Le dock n\'est pas habillé.');
            return null;
        }
        const [provider] = active;
        if (!provider) {
            this._diagnostics.report('dock', 'Aucun dock pris en charge n\'est actif ; aucun effet appliqué.');
            return null;
        }
        if (!provider.reference && !look.allowDashToDock) {
            this._diagnostics.report('dock',
                `${provider.label} est détecté mais n'est pas activé dans les préférences (portage non validé).`);
            return null;
        }
        return provider;
    }

    _rescan() {
        const look = this._look;
        if (!look)
            return;

        const provider = look.surfaces.dock ? this._activeProvider(look) : null;
        if (!look.surfaces.dock)
            this._diagnostics.report('dock', null);

        const containers = provider
            ? Main.layoutManager.uiGroup.get_children().filter(actor => actor.name === DOCK_CONTAINER_NAME)
            : [];

        for (const [container, glass] of [...this._docks]) {
            if (!containers.includes(container)) {
                container.disconnectObject(this);
                glass.destroy();
                this._docks.delete(container);
            }
        }

        let conflict = null;
        let failure = null;
        for (const container of containers) {
            // Another extension blurring the dock wins; stacking two blurs on
            // one surface costs twice and looks muddy.
            const foreign = findForeignBlur(container);
            const existing = this._docks.get(container);
            if (foreign) {
                container.disconnectObject(this);
                existing?.destroy();
                this._docks.delete(container);
                conflict = foreign;
                continue;
            }
            if (existing)
                continue;
            try {
                const glass = new DockGlass(container);
                glass.setLook(look);
                this._docks.set(container, glass);
                container.connectObject('destroy', () => {
                    this._docks.get(container)?.destroy();
                    this._docks.delete(container);
                }, this);
            } catch (e) {
                failure = e;
                console.warn(`Glass Shell: dock left unstyled: ${e.message}`);
            }
        }

        if (provider) {
            this._applyPreset(provider, look);
            if (conflict) {
                this._diagnostics.report('dock',
                    'Une autre extension floute déjà le dock (Blur my Shell ?). ' +
                    'L\'habillage du dock est suspendu ; désactivez le flou du dock dans l\'autre extension.');
            } else if (failure) {
                this._diagnostics.report('dock',
                    `${provider.label} utilise une structure inconnue ; le dock reste utilisable sans effet.`);
            } else {
                const unsupported = [...this._docks.values()].some(glass => !glass.blurSupported);
                this._diagnostics.report('dock', unsupported
                    ? `${provider.label} : flou indisponible sur cette version, teinte seule.`
                    : `${provider.label} habillé (${this._docks.size} dock${this._docks.size > 1 ? 's' : ''}).`);
            }
        }
    }

    _applyPreset(provider, look) {
        if (!look.applyDockPreset)
            return;
        if (this._presetProvider !== provider.uuid) {
            const schemaDir = provider.reference ? null : GLib.build_filenamev([extensionPath(provider.uuid) ?? '', 'schemas']);
            const settings = lookupDockSettings(schemaDir);
            this._preset = settings ? new DockPreset(settings, schemaDir) : null;
            this._presetProvider = provider.uuid;
            if (!settings)
                this._diagnostics.report('dock-settings', 'Schéma de réglages du dock introuvable ; préréglage non appliqué.');
        }
        if (!this._preset)
            return;
        this._preset.ensure('dock-position', new GLib.Variant('s', 'BOTTOM'));
        this._preset.ensure('extend-height', new GLib.Variant('b', false));
        this._preset.ensure('dash-max-icon-size', new GLib.Variant('i', look.iconSize), {owned: true});
        // Desktop-style dock: the applications button first, and small
        // neutral dots instead of the coloured running indicators.
        this._preset.ensure('show-apps-at-top', new GLib.Variant('b', true));
        this._preset.ensure('running-indicator-style', new GLib.Variant('s', 'DOT'));
        this._preset.ensure('custom-theme-customize-running-dots', new GLib.Variant('b', true));
        this._preset.ensure('custom-theme-running-dots-color', new GLib.Variant('s', 'rgb(142,142,150)'));
        this._preset.ensure('custom-theme-running-dots-border-color', new GLib.Variant('s', 'rgb(142,142,150)'));
        this._preset.ensure('custom-theme-running-dots-border-width', new GLib.Variant('i', 0));
    }

    destroy() {
        removeLater(this._rescanId);
        this._rescanId = 0;
        Main.extensionManager.disconnectObject(this);
        Main.layoutManager.uiGroup.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        for (const [container, glass] of this._docks) {
            container.disconnectObject(this);
            glass.destroy();
        }
        this._docks.clear();
        this._preset = null;
    }
}

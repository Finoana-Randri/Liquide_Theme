// Dresses the dock provided by Ubuntu Dock (or, optionally, Dash to Dock) in
// glass. The dock keeps doing everything itself: favourites, launching,
// running indicators, menus, autohide. This module only adds actors and
// classes, and removes them again.
//
// Internal dock API used here, and the fallback when it disappears:
//   dock._box, dock.dash   -> searched by actor name (dashtodockBox, dash)
//   dock._slider.slideX    -> blur simply stays on while the dock is hidden
//   dash._background       -> searched by style class (dash-background)
//   dash._box              -> magnification is turned off
//   dash._showAppsIcon     -> the applications button is not magnified

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {addLater, extensionPath, isExtensionActive, KNOWN_BLUR_EXTENSIONS, removeLater} from './compat.js';
import {DockPreset, lookupDockSettings} from './dockPreset.js';
import {findForeignBlur, GlassSurface} from './glassEffect.js';

const DOCK_PROVIDERS = [
    {uuid: 'ubuntu-dock@ubuntu.com', label: 'Ubuntu Dock', reference: true},
    {uuid: 'dash-to-dock@micxgx.gmail.com', label: 'Dash to Dock', reference: false},
];

const DOCK_CONTAINER_NAME = 'dashtodockContainer';
const PRESS_SCALE = 0.94;
const PRESS_DURATION_MS = 80;
// Pointer distance, in icon widths, over which magnification fades out.
const MAGNIFY_REACH = 2.6;
// Set GLASS_SHELL_DEBUG=1 in the shell environment to trace magnification.
const DEBUG = Boolean(GLib.getenv('GLASS_SHELL_DEBUG'));

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
    // Container > button > BaseIcon > box > icon bin > St.Icon: six levels deep.
    return findDescendant(button, actor => actor instanceof St.Icon, 7);
}

// Magnification that follows the pointer along the dock: each icon grows
// with its closeness to the pointer, from its bottom edge, and the items
// move apart so they never overlap. The dock glass widens by the same amount.
// Everything is a transform (scale and translation), so nothing is laid out
// again while the pointer moves.
class IconFeedback {
    constructor(dash, box, onSpread) {
        this._dash = dash;
        this._box = box;
        this._iconBox = dash._box ?? null;
        this._onSpread = onSpread;
        // The icon row sits in a scroll view whose viewports clip to it, which
        // would cut magnified icons. The dock box keeps transparent room
        // around the row (runtime stylesheet), so drawing past it is safe.
        this._unclipped = [];
        for (let actor = this._iconBox; actor && actor !== dash; actor = actor.get_parent()) {
            if ('clip_to_view' in actor && actor.clip_to_view) {
                actor.clip_to_view = false;
                this._unclipped.push(actor);
            }
        }
        this._slots = [];
        this._base = null;
        this._options = {magnify: false, magnification: 1, durationMs: 0};
        this._scanId = 0;

        const queueScan = () => this._queueScan();
        this._iconBox?.connectObject('child-added', queueScan, 'child-removed', queueScan, this);
        dash.connectObject('icon-size-changed', queueScan, this);
        box.connectObject(
            'motion-event', (_actor, event) => {
                this._magnifyAt(event.get_coords()[0]);
                return Clutter.EVENT_PROPAGATE;
            },
            'notify::hover', () => {
                if (!box.hover && !this._pointerInside())
                    this._rest();
            },
            'leave-event', () => {
                if (!this._pointerInside())
                    this._rest();
                return Clutter.EVENT_PROPAGATE;
            },
            this);
        this._queueScan();
    }

    setOptions(options) {
        this._options = options;
        this._rest();
    }

    // Icons moving under a still pointer can make St report that the
    // pointer left the dock; trust the actual pointer position instead.
    _pointerInside() {
        const [x, y] = global.get_pointer();
        const [left, top] = this._box.get_transformed_position();
        const [width, height] = this._box.get_transformed_size();
        return x >= left && x < left + width && y >= top && y < top + height;
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

    // Every visible item of the dock, in screen order: app icons, the
    // separator and the applications button.
    _scan() {
        for (const slot of this._slots)
            this._releaseSlot(slot);
        const actors = [...this._iconBox?.get_children() ?? []];
        if (this._dash._showAppsIcon)
            actors.push(this._dash._showAppsIcon);
        this._slots = actors.filter(actor => actor.visible).map(actor => {
            const button = actor.child instanceof St.Button ? actor.child : null;
            button?.connectObject('notify::pressed', () => this._pressChanged(button), this);
            actor.connectObject('destroy', () => this._queueScan(), this);
            return {actor, button};
        });
        this._base = null;
    }

    _releaseSlot({actor, button}) {
        button?.disconnectObject(this);
        actor.disconnectObject(this);
        actor.remove_all_transitions();
        actor.translation_x = 0;
        const icon = findIcon(actor);
        if (icon) {
            icon.remove_all_transitions();
            icon.set_scale(1, 1);
        }
    }

    // Untransformed position and width of every slot, measured once per hover.
    _measure() {
        const base = this._slots.filter(slot => slot.actor.get_stage()).map(slot => {
            const [x] = slot.actor.get_transformed_position();
            const [width] = slot.actor.get_transformed_size();
            const left = x - slot.actor.translation_x;
            return {slot, left, width, center: left + width / 2};
        }).sort((a, b) => a.left - b.left);
        return base.length > 0 ? base : null;
    }

    _magnifyAt(pointerX) {
        if (DEBUG && !this._base)
            console.log(`Glass Shell: magnify at ${pointerX} options ${JSON.stringify(this._options)} slots ${this._slots.length}`);
        if (!this._options.magnify || this._options.magnification <= 1)
            return;
        this._base ??= this._measure();
        if (!this._base)
            return;

        const base = this._base;
        const iconWidth = Math.max(...base.map(item => item.width));
        const reach = iconWidth * MAGNIFY_REACH;
        const extra = this._options.magnification - 1;
        const scales = base.map(item => {
            const distance = Math.abs(pointerX - item.center);
            if (distance >= reach || !findIcon(item.slot.actor))
                return 1;
            // Cosine falloff: full size under the pointer, smooth to the edge.
            return 1 + extra * (Math.cos(distance / reach * Math.PI) + 1) / 2;
        });

        // Lay the grown items out side by side, keeping the gaps between them,
        // and keep the row centred where it was: the dock grows on both sides.
        const first = base[0].left;
        const growth = base.reduce((sum, item, i) => sum + item.width * (scales[i] - 1), 0);
        let cursor = first - growth / 2;
        base.forEach((item, i) => {
            if (i > 0)
                cursor += item.left - (base[i - 1].left + base[i - 1].width);
            const center = cursor + item.width * scales[i] / 2;
            cursor += item.width * scales[i];
            this._apply(item.slot, scales[i], center - item.center, 0);
        });
        this._onSpread(growth / 2, 0);
        if (DEBUG) {
            console.log(`Glass Shell: pointer ${Math.round(pointerX)} scales ${scales.map(v => v.toFixed(2)).join(',')} ` +
                `icons ${base.map(item => findIcon(item.slot.actor)?.scale_x?.toFixed(2) ?? '-').join(',')}`);
        }
    }

    _rest() {
        if (DEBUG)
            console.log('Glass Shell: magnification rest');
        const duration = this._options.durationMs;
        for (const slot of this._slots)
            this._apply(slot, 1, 0, duration);
        this._onSpread(0, duration);
        this._base = null;
    }

    _pressChanged(button) {
        const icon = findIcon(button);
        if (!icon)
            return;
        // The press is shortened so a click is felt immediately.
        const factor = button.pressed ? PRESS_SCALE : 1 / PRESS_SCALE;
        const scale = icon.scale_x * factor;
        icon.ease({
            scale_x: scale,
            scale_y: scale,
            duration: Math.min(PRESS_DURATION_MS, this._options.durationMs),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _apply({actor}, scale, translation, duration) {
        const icon = findIcon(actor);
        const mode = Clutter.AnimationMode.EASE_OUT_QUAD;
        if (icon) {
            // Grow upwards from the bottom edge, as icons rise out of a dock.
            icon.set_pivot_point(0.5, 1);
            if (duration > 0) {
                icon.ease({scale_x: scale, scale_y: scale, duration, mode});
            } else {
                icon.remove_all_transitions();
                icon.set_scale(scale, scale);
            }
        }
        if (duration > 0) {
            actor.ease({translation_x: translation, duration, mode});
        } else {
            actor.remove_all_transitions();
            actor.translation_x = translation;
        }
    }

    destroy() {
        removeLater(this._scanId);
        this._scanId = 0;
        this._iconBox?.disconnectObject(this);
        this._dash.disconnectObject(this);
        this._box.disconnectObject(this);
        for (const slot of this._slots)
            this._releaseSlot(slot);
        this._slots = [];
        for (const actor of this._unclipped)
            actor.clip_to_view = true;
        this._unclipped = [];
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

        // The dash always renders into an offscreen buffer the size of its
        // allocation, which would crop magnified icons. Keep the buffer for
        // its fade animations only.
        this._dash = dash;
        this._dashRedirect = dash.offscreen_redirect;
        dash.set_offscreen_redirect(Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY);

        this._icons = new IconFeedback(dash, box,
            (spread, duration) => this._surface.setSpread(spread, duration));
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
        // Lets the stylesheet give symbolic dock icons a readable colour.
        this._dock.remove_style_class_name(look.scheme === 'dark' ? 'glass-shell-light' : 'glass-shell-dark');
        this._dock.add_style_class_name(`glass-shell-${look.scheme}`);
        // Only a bottom dock gets headroom inside its icon buttons.
        const bottom = this._dock.has_style_class_name('bottom');
        this._surface.setInsetTop(bottom ? look.magnifyHeadroom : 0);
        this._icons.setOptions({
            magnify: look.magnify,
            magnification: look.magnification,
            durationMs: look.durationMs,
        });
    }

    destroy() {
        this._icons.destroy();
        this._slider?.disconnectObject(this);
        this._surface.destroy();
        this._dock.disconnectObject(this);
        if (this._dockDestroyed)
            return;
        for (const name of ['glass-shell-dock', 'glass-shell-light', 'glass-shell-dark'])
            this._dock.remove_style_class_name(name);
        this._dash.set_offscreen_redirect(this._dashRedirect);
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

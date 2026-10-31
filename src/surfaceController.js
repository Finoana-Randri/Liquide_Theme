// P1 surfaces: top bar, quick settings, calendar menu and notification banners.
// They share the dock's tint, rim and shadow rules, and each one can be
// turned off on its own.
//
// Internal shell API used here, and the fallback when it disappears:
//   Main.layoutManager.panelBox  -> top bar left unstyled
//   statusArea.quickSettings     -> quick settings left unstyled
//   statusArea.dateMenu          -> calendar left unstyled
//   Main.messageTray._bannerBin  -> notification banners left unstyled

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {addLater, KNOWN_BLUR_EXTENSIONS, removeLater} from './compat.js';
import {findForeignBlur, GlassSurface} from './glassEffect.js';

// Text sits directly on these surfaces, so the tint never drops below a
// level that keeps it readable over a busy wallpaper.
const PANEL_MIN_TINT = 0.6;
const MENU_MIN_TINT = 0.65;
const BANNER_MIN_TINT = 0.7;

const SCHEME_CLASSES = ['glass-shell-light', 'glass-shell-dark'];

function setSchemeClass(actor, scheme) {
    for (const name of SCHEME_CLASSES)
        actor.remove_style_class_name(name);
    actor.add_style_class_name(`glass-shell-${scheme}`);
}

class PanelGlass {
    constructor() {
        this._panel = Main.panel;
        this._host = Main.layoutManager.panelBox;
        this._panel.add_style_class_name('glass-shell-panel');
        this._surface = new GlassSurface({id: 'top-bar', host: this._host, target: this._panel});

        // The overview draws its own transparent top bar.
        Main.overview.connectObject(
            'showing', () => this._surface.setHidden(true),
            'hiding', () => this._surface.setHidden(false),
            this);
        this._surface.setHidden(Main.overview.visible);
    }

    get conflictRoot() {
        return this._host;
    }

    setLook(look) {
        setSchemeClass(this._panel, look.scheme);
        this._surface.setLook({
            ...look,
            tintAlpha: Math.max(look.tintAlpha, PANEL_MIN_TINT),
            radius: 0,
            shadow: false,
            rimEdges: 'bottom',
            cornerStrategy: 'full',
        });
    }

    destroy() {
        Main.overview.disconnectObject(this);
        this._surface.destroy();
        this._panel.remove_style_class_name('glass-shell-panel');
        for (const name of SCHEME_CLASSES)
            this._panel.remove_style_class_name(name);
    }
}

class MenuGlass {
    constructor(menu, id) {
        this._menu = menu;
        this._box = menu.box;
        this._box.add_style_class_name('glass-shell-menu');
        this._surface = new GlassSurface({id, host: this._box, target: this._box});
    }

    get conflictRoot() {
        return this._menu.actor;
    }

    setLook(look) {
        setSchemeClass(this._box, look.shellScheme);
        this._surface.setLook({
            ...look,
            scheme: look.shellScheme,
            tintAlpha: Math.max(look.tintAlpha, MENU_MIN_TINT),
            shadow: false,
        });
    }

    destroy() {
        this._surface.destroy();
        this._box.remove_style_class_name('glass-shell-menu');
        for (const name of SCHEME_CLASSES)
            this._box.remove_style_class_name(name);
    }
}

class BannerGlass {
    constructor() {
        this._bin = Main.messageTray?._bannerBin;
        if (!this._bin)
            throw new Error('notification banner container not found');
        this._surfaces = new Map();
        this._look = null;
        this._bin.connectObject(
            'child-added', (_bin, child) => this._attach(child),
            'child-removed', (_bin, child) => this._detach(child),
            this);
        for (const child of this._bin.get_children())
            this._attach(child);
    }

    get conflictRoot() {
        return this._bin;
    }

    _bannerLook() {
        return {
            ...this._look,
            scheme: this._look.shellScheme,
            tintAlpha: Math.max(this._look.tintAlpha, BANNER_MIN_TINT),
            shadow: false,
        };
    }

    _attach(child) {
        if (this._surfaces.has(child) || child.name?.startsWith('glass-shell-'))
            return;
        child.add_style_class_name?.('glass-shell-banner');
        const surface = new GlassSurface({id: 'banner', host: this._bin, target: child, below: child});
        if (this._look)
            surface.setLook(this._bannerLook());
        this._surfaces.set(child, surface);
    }

    _detach(child) {
        const surface = this._surfaces.get(child);
        if (!surface)
            return;
        this._surfaces.delete(child);
        surface.destroy();
        child.remove_style_class_name?.('glass-shell-banner');
    }

    setLook(look) {
        this._look = look;
        for (const surface of this._surfaces.values())
            surface.setLook(this._bannerLook());
    }

    destroy() {
        this._bin.disconnectObject(this);
        for (const child of [...this._surfaces.keys()])
            this._detach(child);
    }
}

const SURFACES = [
    {
        key: 'topBar',
        label: 'Barre supérieure',
        create: () => new PanelGlass(),
    },
    {
        key: 'quickSettings',
        label: 'Réglages rapides',
        create: () => {
            const menu = Main.panel.statusArea.quickSettings?.menu;
            if (!menu?.box)
                throw new Error('quick settings menu not found');
            return new MenuGlass(menu, 'quick-settings');
        },
    },
    {
        key: 'calendar',
        label: 'Calendrier',
        create: () => {
            const menu = Main.panel.statusArea.dateMenu?.menu;
            if (!menu?.box)
                throw new Error('calendar menu not found');
            return new MenuGlass(menu, 'calendar');
        },
    },
    {
        key: 'notifications',
        label: 'Notifications',
        create: () => new BannerGlass(),
    },
];

export class SurfaceController {
    constructor({diagnostics}) {
        this._diagnostics = diagnostics;
        this._active = new Map();
        this._look = null;
        this._refreshId = 0;

        const watched = new Set(KNOWN_BLUR_EXTENSIONS.map(extension => extension.uuid));
        Main.extensionManager.connectObject('extension-state-changed', (_manager, extension) => {
            if (watched.has(extension.uuid))
                this._queueRefresh();
        }, this);
    }

    update(look) {
        this._look = look;
        this._refresh();
    }

    // Another extension may add its blur a moment after it is enabled.
    _queueRefresh() {
        if (this._refreshId)
            return;
        this._refreshId = addLater(() => {
            this._refreshId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _refresh() {
        const look = this._look;
        if (!look)
            return;

        for (const spec of SURFACES) {
            const wanted = look.surfaces[spec.key];
            let surface = this._active.get(spec.key);

            if (!wanted) {
                surface?.destroy();
                this._active.delete(spec.key);
                this._diagnostics.report(spec.key, null);
                continue;
            }

            if (surface && findForeignBlur(surface.conflictRoot)) {
                surface.destroy();
                this._active.delete(spec.key);
                this._diagnostics.report(spec.key,
                    `${spec.label} : une autre extension floute déjà cette surface ; habillage suspendu.`);
                continue;
            }

            if (!surface) {
                try {
                    surface = spec.create();
                } catch (e) {
                    this._diagnostics.report(spec.key, `${spec.label} : non pris en charge sur cette version (${e.message}).`);
                    continue;
                }
                if (findForeignBlur(surface.conflictRoot)) {
                    surface.destroy();
                    this._diagnostics.report(spec.key,
                        `${spec.label} : une autre extension floute déjà cette surface ; habillage suspendu.`);
                    continue;
                }
                this._active.set(spec.key, surface);
            }
            surface.setLook(look);
            this._diagnostics.report(spec.key, null);
        }
    }

    destroy() {
        removeLater(this._refreshId);
        this._refreshId = 0;
        Main.extensionManager.disconnectObject(this);
        for (const surface of this._active.values())
            surface.destroy();
        this._active.clear();
    }
}

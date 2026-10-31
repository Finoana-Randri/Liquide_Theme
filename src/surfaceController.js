// Shell surfaces other than the dock: top bar, every popup menu (quick
// settings, calendar, panel menus, dock context menus, window previews),
// notification banners, the volume/brightness pop-up and the Alt+Tab
// switcher. They share the dock's tint and rim, and each group can be turned
// off on its own.
//
// Internal shell API used here, and the fallback when it disappears:
//   Main.layoutManager.panelBox      -> top bar left unstyled
//   Main.panel._rightBox             -> clock stays in the centre
//   BoxPointer.prototype.open        -> menus left unstyled
//   OsdWindow.prototype.show, _hbox  -> volume pop-up left unstyled
//   SwitcherPopup.prototype.show,
//   SwitcherPopup._switcherList      -> Alt+Tab left unstyled
//   Main.messageTray._bannerBin      -> notification banners left unstyled
// Every patched prototype method is put back in destroy().

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as OsdWindow from 'resource:///org/gnome/shell/ui/osdWindow.js';
import * as SwitcherPopup from 'resource:///org/gnome/shell/ui/switcherPopup.js';

import {addLater, KNOWN_BLUR_EXTENSIONS, removeLater} from './compat.js';
import {findForeignBlur, GlassSurface} from './glassEffect.js';

// Text sits directly on these surfaces, so the tint never drops below a
// level that keeps it readable over a busy wallpaper.
const PANEL_MIN_TINT = 0.38;
const MENU_MIN_TINT = 0.6;
const BANNER_MIN_TINT = 0.58;

const SCHEME_CLASSES = ['glass-shell-light', 'glass-shell-dark'];

function setSchemeClass(actor, scheme) {
    for (const name of SCHEME_CLASSES)
        actor.remove_style_class_name(name);
    actor.add_style_class_name(`glass-shell-${scheme}`);
}

function clearClasses(actor, names) {
    for (const name of [...names, ...SCHEME_CLASSES])
        actor.remove_style_class_name(name);
}

function textSurfaceLook(look, minTint, radius) {
    return {
        ...look,
        scheme: look.shellScheme,
        tintAlpha: Math.max(look.tintAlpha, minTint),
        radius,
        shadow: false,
    };
}

// Replace `proto[name]` with a wrapper that first calls `hook(this)`, and
// return a function that puts the original back.
function hookMethod(proto, name, hook, {after = false} = {}) {
    const original = proto[name];
    proto[name] = function (...args) {
        if (!after)
            hook(this);
        const result = original.apply(this, args);
        if (after)
            hook(this);
        return result;
    };
    return () => {
        proto[name] = original;
    };
}

class PanelGlass {
    constructor() {
        this._panel = Main.panel;
        this._host = Main.layoutManager.panelBox;
        this._panel.add_style_class_name('glass-shell-panel');
        this._surface = new GlassSurface({id: 'top-bar', host: this._host, target: this._panel});
        this._clockHome = null;

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

    // The desktop layout puts the clock at the far right, after the system
    // indicators, and brings notification banners to the top-right corner.
    _setDesktopLayout(enabled) {
        const container = Main.panel.statusArea.dateMenu?.container;
        const rightBox = Main.panel._rightBox;
        if (!container || !rightBox)
            return;

        if (enabled && !this._clockHome) {
            const parent = container.get_parent();
            if (!parent || parent === rightBox)
                return;
            this._clockHome = {
                parent,
                index: parent.get_children().indexOf(container),
                bannerAlignment: Main.messageTray.bannerAlignment,
            };
            parent.remove_child(container);
            rightBox.add_child(container);
            Main.messageTray.bannerAlignment = Clutter.ActorAlign.END;
            this._panel.add_style_class_name('glass-shell-desktop-layout');
        } else if (!enabled && this._clockHome) {
            const {parent, index, bannerAlignment} = this._clockHome;
            this._clockHome = null;
            container.get_parent()?.remove_child(container);
            parent.insert_child_at_index(container, Math.max(0, index));
            Main.messageTray.bannerAlignment = bannerAlignment;
            this._panel.remove_style_class_name('glass-shell-desktop-layout');
        }
    }

    setLook(look) {
        this._setDesktopLayout(look.macosLayout);
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
        this._setDesktopLayout(false);
        this._surface.destroy();
        clearClasses(this._panel, ['glass-shell-panel', 'glass-shell-desktop-layout']);
    }
}

// Glass inside one popup menu. BoxPointer always renders offscreen, which
// would hand the background blur an empty buffer; while the glass is
// attached it only goes offscreen during its fade animation.
class MenuGlass {
    constructor(boxPointer, box, category) {
        this._category = category;
        this._boxPointer = boxPointer;
        this._box = box;
        this._redirect = boxPointer.offscreen_redirect;
        boxPointer.set_offscreen_redirect(Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY);
        box.add_style_class_name('glass-shell-menu');
        this._surface = new GlassSurface({id: 'menu', host: box, target: box});
    }

    setLook(look) {
        setSchemeClass(this._box, look.shellScheme);
        const radius = this._category === 'menus' ? look.radii.menu : look.radii.panel;
        this._surface.setLook(textSurfaceLook(look, MENU_MIN_TINT, radius));
    }

    destroy(destroyed = false) {
        this._surface.destroy();
        if (destroyed)
            return;
        this._boxPointer.set_offscreen_redirect(this._redirect);
        clearClasses(this._box, ['glass-shell-menu']);
    }
}

class MenuGlassManager {
    constructor() {
        this._menus = new Map();
        this._look = null;
        this._restore = hookMethod(BoxPointer.BoxPointer.prototype, 'open', boxPointer => {
            try {
                this._sync(boxPointer);
            } catch (e) {
                console.warn(`Glass Shell: menu left unstyled: ${e.message}`);
            }
        });
    }

    // Most menus put their content box straight into the pointer's bin;
    // quick settings wraps it in an overlay first.
    _findContent(boxPointer) {
        const stack = [[boxPointer.bin?.get_child(), 0]];
        while (stack.length > 0) {
            const [actor, depth] = stack.shift();
            if (!actor)
                continue;
            if (actor instanceof St.BoxLayout && actor.has_style_class_name('popup-menu-content'))
                return actor;
            if (depth < 3)
                stack.push(...actor.get_children().map(child => [child, depth + 1]));
        }
        return null;
    }

    _category(content) {
        if (content === Main.panel.statusArea.quickSettings?.menu?.box)
            return 'quickSettings';
        if (content === Main.panel.statusArea.dateMenu?.menu?.box)
            return 'calendar';
        return 'menus';
    }

    _sync(boxPointer) {
        if (!this._look)
            return;
        const content = this._findContent(boxPointer);
        const existing = this._menus.get(boxPointer);
        const wanted = content && this._look.surfaces[this._category(content)];

        if (existing && !wanted) {
            this._detach(boxPointer);
            return;
        }
        if (existing || !wanted || findForeignBlur(boxPointer))
            return;

        const glass = new MenuGlass(boxPointer, content, this._category(content));
        glass.setLook(this._look);
        this._menus.set(boxPointer, glass);
        boxPointer.connectObject('destroy', () => {
            this._menus.get(boxPointer)?.destroy(true);
            this._menus.delete(boxPointer);
        }, this);
    }

    _detach(boxPointer) {
        boxPointer.disconnectObject(this);
        this._menus.get(boxPointer)?.destroy();
        this._menus.delete(boxPointer);
    }

    setLook(look) {
        this._look = look;
        for (const boxPointer of [...this._menus.keys()]) {
            const content = this._findContent(boxPointer);
            if (look.surfaces[this._category(content)])
                this._menus.get(boxPointer).setLook(look);
            else
                this._detach(boxPointer);
        }
    }

    destroy() {
        this._restore();
        for (const boxPointer of [...this._menus.keys()])
            this._detach(boxPointer);
    }
}

// Pop-ups that allocate their children by hand (OSD, Alt+Tab) cannot hold
// the glass actors. The glass goes into the UI group right below the pop-up
// and copies its opacity and visibility instead.
class OverlayGlassManager {
    constructor({id, proto, method, after, surfaceKey, findTarget, styleClass, minTint, radiusKey}) {
        this._radiusKey = radiusKey;
        this._id = id;
        this._surfaceKey = surfaceKey;
        this._findTarget = findTarget;
        this._styleClass = styleClass;
        this._minTint = minTint;
        this._popups = new Map();
        this._look = null;
        this._restore = hookMethod(proto, method, popup => {
            try {
                this._attach(popup);
            } catch (e) {
                console.warn(`Glass Shell: ${id} left unstyled: ${e.message}`);
            }
        }, {after});
    }

    _attach(popup) {
        if (!this._look?.surfaces[this._surfaceKey] || this._popups.has(popup))
            return;
        const target = this._findTarget(popup);
        const host = popup.get_parent();
        if (!target || !host)
            return;
        target.add_style_class_name(this._styleClass);
        setSchemeClass(target, this._look.shellScheme);
        const surface = new GlassSurface({id: this._id, host, target, below: popup, follow: popup});
        surface.setLook(textSurfaceLook(this._look, this._minTint, this._look.radii[this._radiusKey]));
        this._popups.set(popup, {surface, target});
        popup.connectObject('destroy', () => this._detach(popup, true), this);
    }

    _detach(popup, destroyed = false) {
        const entry = this._popups.get(popup);
        if (!entry)
            return;
        this._popups.delete(popup);
        popup.disconnectObject(this);
        entry.surface.destroy();
        if (!destroyed)
            clearClasses(entry.target, [this._styleClass]);
    }

    setLook(look) {
        this._look = look;
        for (const [popup, {surface, target}] of [...this._popups]) {
            if (!look.surfaces[this._surfaceKey]) {
                this._detach(popup);
                continue;
            }
            setSchemeClass(target, look.shellScheme);
            surface.setLook(textSurfaceLook(look, this._minTint, look.radii[this._radiusKey]));
        }
    }

    destroy() {
        this._restore();
        for (const popup of [...this._popups.keys()])
            this._detach(popup);
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

    _attach(child) {
        if (this._surfaces.has(child) || child.name?.startsWith('glass-shell-'))
            return;
        child.add_style_class_name?.('glass-shell-banner');
        const surface = new GlassSurface({id: 'banner', host: this._bin, target: child, below: child});
        if (this._look)
            surface.setLook(textSurfaceLook(this._look, BANNER_MIN_TINT, this._look.radii.banner));
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
            surface.setLook(textSurfaceLook(look, BANNER_MIN_TINT, look.radii.banner));
    }

    destroy() {
        this._bin.disconnectObject(this);
        for (const child of [...this._surfaces.keys()])
            this._detach(child);
    }
}

// Surfaces that exist once, created when their switch is on.
const SINGLE_SURFACES = [
    {key: 'topBar', label: 'Barre supérieure', create: () => new PanelGlass()},
    {key: 'notifications', label: 'Notifications', create: () => new BannerGlass()},
];

export class SurfaceController {
    constructor({diagnostics}) {
        this._diagnostics = diagnostics;
        this._active = new Map();
        this._look = null;
        this._refreshId = 0;

        // Menus and pop-ups are created on demand, so they are styled as
        // they open rather than up front.
        this._menus = new MenuGlassManager();
        this._overlays = [
            new OverlayGlassManager({
                id: 'osd',
                proto: OsdWindow.OsdWindow.prototype,
                method: 'show',
                after: false,
                surfaceKey: 'osd',
                findTarget: popup => popup._hbox ?? null,
                styleClass: 'glass-shell-osd',
                minTint: MENU_MIN_TINT,
                radiusKey: 'osd',
            }),
            new OverlayGlassManager({
                id: 'switcher',
                proto: SwitcherPopup.SwitcherPopup.prototype,
                method: 'show',
                after: true,
                surfaceKey: 'switcher',
                findTarget: popup => popup._switcherList ?? null,
                styleClass: 'glass-shell-switcher',
                minTint: MENU_MIN_TINT,
                radiusKey: 'switcher',
            }),
        ];

        const watched = new Set(KNOWN_BLUR_EXTENSIONS.map(extension => extension.uuid));
        Main.extensionManager.connectObject('extension-state-changed', (_manager, extension) => {
            if (watched.has(extension.uuid))
                this._queueRefresh();
        }, this);
    }

    update(look) {
        this._look = look;
        this._menus.setLook(look);
        for (const overlay of this._overlays)
            overlay.setLook(look);
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

        for (const spec of SINGLE_SURFACES) {
            let surface = this._active.get(spec.key);
            const conflictMessage = `${spec.label} : une autre extension floute déjà cette surface ; habillage suspendu.`;

            if (!look.surfaces[spec.key]) {
                surface?.destroy();
                this._active.delete(spec.key);
                this._diagnostics.report(spec.key, null);
                continue;
            }

            if (surface && findForeignBlur(surface.conflictRoot)) {
                surface.destroy();
                this._active.delete(spec.key);
                this._diagnostics.report(spec.key, conflictMessage);
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
                    this._diagnostics.report(spec.key, conflictMessage);
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
        this._menus.destroy();
        for (const overlay of this._overlays)
            overlay.destroy();
        for (const surface of this._active.values())
            surface.destroy();
        this._active.clear();
    }
}

// Turns the stored preferences and the desktop accessibility settings into
// one resolved "look" that every surface reads from.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Changes are grouped so dragging a slider does not rebuild styles on every step.
const CHANGE_DELAY_MS = 150;

// Converts the 0-100 intensity to a Shell.BlurEffect radius in pixels.
const BLUR_RADIUS_PER_POINT = 0.8;

const PROFILES = {
    quality: {blurFactor: 1, highlightFactor: 1, opacityBoost: 0, durationMs: 220},
    balanced: {blurFactor: 0.85, highlightFactor: 0.9, opacityBoost: 0, durationMs: 180},
    // No blur at all: the GPU cost is what this profile exists to remove.
    economy: {blurFactor: 0, highlightFactor: 0.5, opacityBoost: 0.2, durationMs: 160},
};

function lookupSettings(schemaId, key) {
    const schema = Gio.SettingsSchemaSource.get_default()?.lookup(schemaId, true);
    if (!schema || (key && !schema.has_key(key)))
        return null;
    return new Gio.Settings({settings_schema: schema});
}

export class GlassSettings {
    constructor(settings, onChanged) {
        this._settings = settings;
        this._onChanged = onChanged;
        this._timeoutId = 0;

        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._a11y = lookupSettings('org.gnome.desktop.a11y.interface', 'high-contrast');

        const queue = () => this._queueChange();
        this._settings.connectObject('changed', (_settings, key) => {
            // The extension writes this key itself; reacting would loop.
            if (key !== 'diagnostics')
                queue();
        }, this);
        this._interface.connectObject(
            'changed::color-scheme', queue,
            'changed::enable-animations', queue,
            this);
        this._a11y?.connectObject('changed::high-contrast', queue, this);
    }

    get gsettings() {
        return this._settings;
    }

    _queueChange() {
        if (this._timeoutId)
            return;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CHANGE_DELAY_MS, () => {
            this._timeoutId = 0;
            this._onChanged();
            return GLib.SOURCE_REMOVE;
        });
    }

    computeLook() {
        const s = this._settings;
        const prefersDark = this._interface.get_string('color-scheme') === 'prefer-dark';
        return resolveLook({
            colorScheme: s.get_string('color-scheme'),
            lightOpacity: s.get_int('light-opacity'),
            darkOpacity: s.get_int('dark-opacity'),
            blurIntensity: s.get_int('blur-intensity'),
            cornerRadius: s.get_int('corner-radius'),
            highlightIntensity: s.get_int('highlight-intensity'),
            cornerStrategy: s.get_string('corner-strategy'),
            applyDockPreset: s.get_boolean('apply-dock-preset'),
            iconSize: s.get_int('icon-size'),
            iconSpacing: s.get_int('icon-spacing'),
            dockPadding: s.get_int('dock-padding'),
            dockMargin: s.get_int('dock-margin'),
            hoverMagnification: s.get_boolean('hover-magnification'),
            magnification: s.get_int('magnification'),
            allowDashToDock: s.get_boolean('allow-dash-to-dock'),
            surfaces: {
                dock: s.get_boolean('surface-dock'),
                topBar: s.get_boolean('surface-top-bar'),
                quickSettings: s.get_boolean('surface-quick-settings'),
                calendar: s.get_boolean('surface-calendar'),
                menus: s.get_boolean('surface-menus'),
                notifications: s.get_boolean('surface-notifications'),
                osd: s.get_boolean('surface-osd'),
                switcher: s.get_boolean('surface-switcher'),
            },
            macosLayout: s.get_boolean('macos-layout'),
            profile: s.get_string('performance-profile'),
            reduceEffects: s.get_boolean('reduce-effects'),
            reduceTransparency: s.get_boolean('reduce-transparency'),
        }, {
            prefersDark,
            animations: this._interface.get_boolean('enable-animations'),
            highContrast: this._a11y?.get_boolean('high-contrast') ?? false,
        });
    }

    destroy() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        this._settings.disconnectObject(this);
        this._interface.disconnectObject(this);
        this._a11y?.disconnectObject(this);
    }
}

// Pure function so the rules can be read, and tested, in one place.
export function resolveLook(values, system) {
    const profile = PROFILES[values.profile] ?? PROFILES.balanced;
    const scheme = values.colorScheme === 'system'
        ? (system.prefersDark ? 'dark' : 'light')
        : values.colorScheme;

    let tintAlpha = (scheme === 'dark' ? values.darkOpacity : values.lightOpacity) / 100;
    let blurRadius = values.blurIntensity * BLUR_RADIUS_PER_POINT * profile.blurFactor;
    let highlight = (values.highlightIntensity / 100) * profile.highlightFactor;
    let borderAlpha = scheme === 'dark' ? 0.14 : 0.5;
    tintAlpha += profile.opacityBoost;

    if (values.reduceTransparency) {
        tintAlpha = Math.max(tintAlpha, 0.8);
        blurRadius *= 0.5;
    }
    if (values.reduceEffects) {
        tintAlpha = Math.max(tintAlpha, 0.75);
        blurRadius = 0;
        highlight = 0;
    }
    // Readability wins over the glass look when high contrast is on.
    if (system.highContrast) {
        tintAlpha = Math.max(tintAlpha, 0.9);
        highlight = 0;
        borderAlpha = 0.7;
    }

    const animations = system.animations && !values.reduceEffects;
    const magnify = values.hoverMagnification && animations;
    // How far a magnified icon grows past its edge, so padding can absorb it
    // and neighbours never overlap.
    const magnification = values.magnification / 100;
    // Headroom above the icons for them to grow into without being clipped.
    const magnifyHeadroom = magnify ? Math.ceil(values.iconSize * (magnification - 1)) + 2 : 0;
    // Room on each side for the row to spread into: neighbours within about
    // two and a half icons grow, so the row gains up to about 1.6 icon widths.
    const magnifySideRoom = magnify ? Math.ceil((values.iconSize + values.iconSpacing) * (magnification - 1) * 1.6) + 4 : 0;

    return {
        scheme,
        // Menus and banners keep the shell's own text colours, so their tint
        // follows the desktop scheme even when the dock scheme is forced.
        shellScheme: system.prefersDark ? 'dark' : 'light',
        tintAlpha: Math.min(0.95, tintAlpha),
        blurRadius,
        // Darkening is left to the tint: a dimmed blur would show the edge of
        // the inset blur rectangle as a visible step.
        blurBrightness: 1,
        highlight,
        borderAlpha,
        glowAlpha: scheme === 'dark' ? 0.05 : 0.22,
        specularAlpha: scheme === 'dark' ? 0.28 : 0.9,
        // Ubuntu Dock clips its children to the slide container, which cuts
        // any outer shadow into a hard-edged rectangle, so none is drawn.
        shadow: false,
        shadowAlpha: scheme === 'dark' ? 0.32 : 0.18,
        radius: values.cornerRadius,
        // Smaller corners on small surfaces, as on a desktop with glass
        // panels: menus are tighter than control panels and the dock.
        radii: {
            menu: Math.round(values.cornerRadius * 0.55),
            panel: Math.round(values.cornerRadius * 0.9),
            banner: Math.round(values.cornerRadius * 0.75),
            osd: Math.round(values.cornerRadius * 0.8),
            switcher: values.cornerRadius,
        },
        cornerStrategy: values.cornerStrategy,
        highContrast: system.highContrast,
        animations,
        durationMs: animations ? profile.durationMs : 0,
        magnify,
        magnification,
        magnifyHeadroom,
        magnifySideRoom,
        applyDockPreset: values.applyDockPreset,
        iconSize: values.iconSize,
        iconSpacing: values.iconSpacing,
        dockPadding: values.dockPadding,
        dockMargin: values.dockMargin,
        allowDashToDock: values.allowDashToDock,
        macosLayout: values.macosLayout,
        surfaces: values.surfaces,
    };
}

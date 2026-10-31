// Preferences window. It runs in its own process with GTK 4 and libadwaita,
// so it must not import St, Clutter, Shell or anything under ui/.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {restoreDockSettings} from './dockPreset.js';

const COLOR_SCHEMES = [
    ['system', 'Système'],
    ['light', 'Clair'],
    ['dark', 'Sombre'],
];

const PROFILES = [
    ['quality', 'Qualité'],
    ['balanced', 'Équilibré'],
    ['economy', 'Économie'],
];

// Keys the reset button leaves alone: they are state, not preferences.
const STATE_KEYS = new Set(['diagnostics']);

// Settings handlers are disconnected when the window closes.
class Bindings {
    constructor(settings) {
        this._settings = settings;
        this._ids = [];
    }

    onChanged(key, callback) {
        this._ids.push(this._settings.connect(`changed::${key}`, callback));
    }

    destroy() {
        for (const id of this._ids)
            this._settings.disconnect(id);
        this._ids = [];
    }
}

function addSwitch(group, settings, key, title, subtitle = null) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
    return row;
}

// Integer keys are bound by hand: the default GSettings mapping between an
// "i" key and a double adjustment rejects fractional slider positions.
function addSlider(group, settings, bindings, key, title, {min, max, step = 1, unit = '', subtitle = null}) {
    const row = new Adw.ActionRow({title, subtitle});
    const adjustment = new Gtk.Adjustment({
        lower: min,
        upper: max,
        step_increment: step,
        page_increment: step * 5,
        value: settings.get_int(key),
    });
    const scale = new Gtk.Scale({
        adjustment,
        digits: 0,
        round_digits: 0,
        draw_value: true,
        value_pos: Gtk.PositionType.LEFT,
        hexpand: true,
        valign: Gtk.Align.CENTER,
        width_request: 240,
    });
    scale.set_format_value_func((_scale, value) => `${Math.round(value)}${unit}`);
    adjustment.connect('value-changed', () => {
        const value = Math.round(adjustment.value);
        if (settings.get_int(key) !== value)
            settings.set_int(key, value);
    });
    bindings.onChanged(key, () => {
        const value = settings.get_int(key);
        if (Math.round(adjustment.value) !== value)
            adjustment.value = value;
    });
    row.add_suffix(scale);
    group.add(row);
    return row;
}

function addChoice(group, settings, bindings, key, title, choices, subtitle = null) {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(choices.map(([, label]) => label)),
    });
    const sync = () => {
        const index = choices.findIndex(([value]) => value === settings.get_string(key));
        if (index >= 0 && row.selected !== index)
            row.selected = index;
    };
    sync();
    row.connect('notify::selected', () => {
        const [value] = choices[row.selected] ?? [];
        if (value && settings.get_string(key) !== value)
            settings.set_string(key, value);
    });
    bindings.onChanged(key, sync);
    group.add(row);
    return row;
}

function addButton(group, title, subtitle, label, callback, {destructive = false} = {}) {
    const row = new Adw.ActionRow({title, subtitle});
    const button = new Gtk.Button({label, valign: Gtk.Align.CENTER});
    if (destructive)
        button.add_css_class('destructive-action');
    button.connect('clicked', callback);
    row.add_suffix(button);
    group.add(row);
    return row;
}

export default class GlassShellPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const bindings = new Bindings(settings);
        window.connect('close-request', () => {
            bindings.destroy();
            return false;
        });
        window.set_default_size(720, 760);
        window.search_enabled = true;

        window.add(this._appearancePage(settings, bindings));
        window.add(this._dockPage(window, settings, bindings));
        window.add(this._surfacesPage(settings));
        window.add(this._performancePage(window, settings, bindings));
    }

    _appearancePage(settings, bindings) {
        const page = new Adw.PreferencesPage({title: 'Apparence', icon_name: 'applications-graphics-symbolic'});

        const scheme = new Adw.PreferencesGroup({title: 'Couleurs'});
        addChoice(scheme, settings, bindings, 'color-scheme', 'Mode', COLOR_SCHEMES,
            'Le mode système suit le réglage clair ou sombre du bureau.');
        addSlider(scheme, settings, bindings, 'light-opacity', 'Opacité de la teinte claire',
            {min: 20, max: 85, unit: ' %'});
        addSlider(scheme, settings, bindings, 'dark-opacity', 'Opacité de la teinte sombre',
            {min: 20, max: 85, unit: ' %'});
        page.add(scheme);

        const material = new Adw.PreferencesGroup({
            title: 'Matériau',
            description: 'Le flou porte sur l\'arrière-plan ; les icônes et les textes restent nets.',
        });
        addSlider(material, settings, bindings, 'blur-intensity', 'Intensité du flou', {min: 0, max: 100});
        addSlider(material, settings, bindings, 'corner-radius', 'Rayon des angles', {min: 0, max: 40, unit: ' px'});
        addSlider(material, settings, bindings, 'highlight-intensity', 'Intensité des reflets', {min: 0, max: 100});
        page.add(material);

        return page;
    }

    _dockPage(window, settings, bindings) {
        const page = new Adw.PreferencesPage({title: 'Dock', icon_name: 'view-app-grid-symbolic'});

        const layout = new Adw.PreferencesGroup({title: 'Disposition'});
        addSwitch(layout, settings, 'apply-dock-preset', 'Préréglage bas et centré',
            'Place le dock en bas, sans occuper toute la largeur. Les anciennes valeurs sont sauvegardées.');
        const iconSize = addSlider(layout, settings, bindings, 'icon-size', 'Taille des icônes',
            {min: 32, max: 64, step: 2, unit: ' px', subtitle: 'Modifie la taille maximale des icônes du dock.'});
        settings.bind('apply-dock-preset', iconSize, 'sensitive', Gio.SettingsBindFlags.GET);
        addSlider(layout, settings, bindings, 'icon-spacing', 'Espacement', {min: 0, max: 24, unit: ' px'});
        addSlider(layout, settings, bindings, 'dock-padding', 'Marge intérieure', {min: 0, max: 24, unit: ' px'});
        addSlider(layout, settings, bindings, 'dock-margin', 'Marge au bord de l\'écran', {min: 0, max: 48, unit: ' px'});
        page.add(layout);

        const behaviour = new Adw.PreferencesGroup({title: 'Comportement'});
        addSwitch(behaviour, settings, 'hover-magnification', 'Agrandissement au survol',
            'Agrandit l\'icône survolée sans déplacer les zones de clic.');
        addSwitch(behaviour, settings, 'allow-dash-to-dock', 'Habiller aussi Dash to Dock',
            'Portage non validé dans la configuration de référence.');
        page.add(behaviour);

        const native = new Adw.PreferencesGroup({
            title: 'Réglages natifs',
            description: 'Masquage automatique, écran du dock et comportement des clics restent gérés par Ubuntu Dock.',
        });
        addButton(native, 'Réglages d\'Ubuntu Dock', null, 'Ouvrir', () => {
            try {
                Gio.Subprocess.new(['gnome-control-center', 'ubuntu'], Gio.SubprocessFlags.NONE);
            } catch (e) {
                window.add_toast(new Adw.Toast({title: `Impossible d'ouvrir les réglages : ${e.message}`}));
            }
        });
        page.add(native);

        return page;
    }

    _surfacesPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Surfaces', icon_name: 'video-display-symbolic'});
        const group = new Adw.PreferencesGroup({
            title: 'Surfaces habillées',
            description: 'Chaque surface peut être désactivée séparément.',
        });
        addSwitch(group, settings, 'surface-dock', 'Dock');
        addSwitch(group, settings, 'surface-top-bar', 'Barre supérieure');
        addSwitch(group, settings, 'surface-quick-settings', 'Réglages rapides');
        addSwitch(group, settings, 'surface-calendar', 'Menu calendrier');
        addSwitch(group, settings, 'surface-menus', 'Autres menus',
            'Menus de la barre, clic droit du dock, aperçus de fenêtres.');
        addSwitch(group, settings, 'surface-notifications', 'Bannières de notification');
        addSwitch(group, settings, 'surface-osd', 'Volume et luminosité');
        addSwitch(group, settings, 'surface-switcher', 'Sélecteur Alt+Tab');
        page.add(group);

        const layout = new Adw.PreferencesGroup({title: 'Disposition'});
        addSwitch(layout, settings, 'macos-layout', 'Barre de bureau fine',
            'Barre plus fine, horloge à droite et notifications en haut à droite.');
        page.add(layout);
        return page;
    }

    _performancePage(window, settings, bindings) {
        const page = new Adw.PreferencesPage({title: 'Performance', icon_name: 'speedometer-symbolic'});

        const profile = new Adw.PreferencesGroup({title: 'Profil graphique'});
        addChoice(profile, settings, bindings, 'performance-profile', 'Profil', PROFILES,
            'Équilibré limite le flou ; Économie le désactive et renforce l\'opacité.');
        addSwitch(profile, settings, 'reduce-effects', 'Effets réduits',
            'Sans flou, reflets ni agrandissement ; surfaces plus opaques.');
        addSwitch(profile, settings, 'reduce-transparency', 'Transparence réduite');
        page.add(profile);

        const maintenance = new Adw.PreferencesGroup({title: 'Maintenance'});
        addButton(maintenance, 'Réglages du projet', 'Rétablit les valeurs par défaut de Glass Shell uniquement.',
            'Rétablir', () => {
                for (const key of settings.settings_schema.list_keys()) {
                    if (!STATE_KEYS.has(key))
                        settings.reset(key);
                }
                window.add_toast(new Adw.Toast({title: 'Réglages de Glass Shell rétablis'}));
            }, {destructive: true});
        addButton(maintenance, 'Réglages du dock d\'origine',
            'Remet les valeurs du dock d\'avant Glass Shell, sauf celles modifiées depuis.',
            'Restaurer', () => {
                // Turn the preset off first so the extension does not apply it again.
                settings.set_boolean('apply-dock-preset', false);
                const result = restoreDockSettings();
                let message;
                if (result.missingSchema)
                    message = 'Réglages du dock introuvables ; rien n\'a été modifié.';
                else if (result.restored.length === 0 && result.kept.length === 0)
                    message = 'Aucune sauvegarde du dock à restaurer.';
                else
                    message = `${result.restored.length} réglage(s) restauré(s), ${result.kept.length} conservé(s).`;
                window.add_toast(new Adw.Toast({title: message}));
            });
        page.add(maintenance);

        const compatibility = new Adw.PreferencesGroup({
            title: 'Compatibilité et conflits',
            description: `Session ${GLib.getenv('XDG_SESSION_TYPE') ?? 'inconnue'}. ` +
                'Messages transmis par l\'extension active.',
        });
        const rows = [];
        const fill = () => {
            for (const row of rows.splice(0))
                compatibility.remove(row);
            const lines = settings.get_strv('diagnostics');
            for (const line of lines.length > 0 ? lines : ['Aucun message : l\'extension n\'est peut-être pas active.']) {
                const row = new Adw.ActionRow({title: GLib.markup_escape_text(line, -1)});
                compatibility.add(row);
                rows.push(row);
            }
        };
        fill();
        bindings.onChanged('diagnostics', fill);
        page.add(compatibility);

        return page;
    }
}

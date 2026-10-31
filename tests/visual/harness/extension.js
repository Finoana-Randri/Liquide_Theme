// Test-only extension that walks through every Glass Shell state and saves a
// screenshot of each. It uses a virtual pointer so hover and press go through
// the real input path, and real application windows for the blur checks.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot', 'screenshot_finish');

const GLASS_UUID = 'glass-shell@finoana-randri.github.io';
const OUT = GLib.getenv('GLASS_OUT') || '/out';
const WALLPAPER = GLib.getenv('GLASS_WALLPAPER') || '';

function sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function waitFor(predicate, timeoutMs, stepMs = 200) {
    for (let waited = 0; waited < timeoutMs; waited += stepMs) {
        const value = predicate();
        if (value)
            return value;
        await sleep(stepMs);
    }
    return null;
}

function findByName(root, name) {
    const stack = [root];
    const found = [];
    while (stack.length > 0) {
        const actor = stack.pop();
        if (actor.name === name)
            found.push(actor);
        stack.push(...actor.get_children());
    }
    return found;
}

function center(actor) {
    const [x, y] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    return [x + w / 2, y + h / 2];
}

export default class Harness extends Extension {
    enable() {
        // GNOME re-enables later extensions when Glass Shell is toggled;
        // the scenario must only run once per session.
        if (globalThis.__glassHarnessStarted)
            return;
        globalThis.__glassHarnessStarted = true;
        this._log('harness enabled');
        this._run()
            .catch(e => this._log(`FAILED: ${e}\n${e.stack}`))
            .finally(() => this._write('done', 'done\n'));
    }

    disable() {
    }

    _write(name, text, append = false) {
        const file = Gio.File.new_for_path(`${OUT}/${name}`);
        const stream = append
            ? file.append_to(Gio.FileCreateFlags.NONE, null)
            : file.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        stream.write_all(new TextEncoder().encode(text), null);
        stream.close(null);
    }

    _log(message) {
        this._write('harness.log', `[${(GLib.get_monotonic_time() / 1e6).toFixed(1)}] ${message}\n`, true);
    }

    async _shot(name, delay = 400) {
        await sleep(delay);
        const file = Gio.File.new_for_path(`${OUT}/${name}.png`);
        const stream = file.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        await new Shell.Screenshot().screenshot(false, stream);
        stream.close(null);
        this._log(`shot ${name} | ${this._state()}`);
    }

    _state() {
        const wrappers = findByName(global.stage, 'glass-shell-dock');
        const blurs = wrappers.map(w => w.get_child_at_index(0)?.get_effects().map(e => e.enabled).join('/') ?? '-');
        const diag = this._glassSettings()?.get_strv('diagnostics').join(' ; ') ?? 'no settings';
        const dock = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.dash-to-dock'});
        return `dock glass=${wrappers.length} blur=${blurs.join(',')} pos=${dock.get_string('dock-position')} | ${diag}`;
    }

    _glassSettings() {
        const glass = Main.extensionManager.lookup(GLASS_UUID);
        if (!glass?.stateObj)
            return null;
        this._settings ??= glass.stateObj.getSettings();
        return this._settings;
    }

    _pointerTo(x, y) {
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
    }

    _button(state) {
        this._pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, state);
    }

    _dockButtons() {
        const dock = Main.layoutManager.uiGroup.get_children().find(a => a.name === 'dashtodockContainer');
        if (!dock?.dash)
            return [];
        const buttons = dock.dash._box.get_children()
            .map(item => item.child)
            .filter(child => child instanceof St.Button);
        if (dock.dash.showAppsButton)
            buttons.push(dock.dash.showAppsButton);
        return buttons;
    }

    _dumpDock() {
        this._dumpTree(Main.layoutManager.uiGroup.get_children().find(a => a.name === 'dashtodockContainer'), 'dock-tree.txt');
    }

    _dumpTree(dock, fileName) {
        const lines = [];
        const walk = (actor, depth) => {
            const box = actor.get_allocation_box();
            let bg = '';
            if (actor instanceof St.Widget && actor.get_stage()) {
                const node = actor.get_theme_node();
                const c = node.get_background_color();
                bg = `bg=${c.red},${c.green},${c.blue},${c.alpha} shadow=${Boolean(node.get_box_shadow())}`;
            }
            const effects = actor.get_effects().map(e => e.constructor.name).join(',');
            lines.push(`${'  '.repeat(depth)}${actor.constructor.name} name=${actor.name} class=${actor.style_class ?? ''} ` +
                `alloc=${box.x1.toFixed(0)},${box.y1.toFixed(0)} ${box.get_width().toFixed(0)}x${box.get_height().toFixed(0)} ` +
                `opacity=${actor.opacity} visible=${actor.visible} ${bg} style=${actor.style ?? ''} fx=${effects}`);
            if (depth < 7)
                actor.get_children().forEach(c => walk(c, depth + 1));
        };
        if (dock)
            walk(dock, 0);
        this._write(fileName, `${lines.join('\n')}\n`);
    }

    _closeDockMenus() {
        for (const button of this._dockButtons())
            button._menu?.close(BoxPointer.PopupAnimation.NONE);
    }

    _setBackground({color = null, uri = null}) {
        const bg = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        if (uri) {
            bg.set_string('picture-options', 'zoom');
            bg.set_string('picture-uri', uri);
            bg.set_string('picture-uri-dark', uri);
        } else {
            bg.set_string('picture-options', 'none');
            bg.set_string('color-shading-type', 'solid');
            bg.set_string('primary-color', color);
        }
    }

    _setScheme(dark) {
        new Gio.Settings({schema_id: 'org.gnome.desktop.interface'})
            .set_string('color-scheme', dark ? 'prefer-dark' : 'default');
    }

    async _openMenu(menu, name) {
        menu.open(BoxPointer.PopupAnimation.FULL);
        await sleep(1200);
        await this._shot(name);
        this._dumpTree(menu.actor, `${name}-tree.txt`);
        menu.close(BoxPointer.PopupAnimation.NONE);
        await sleep(400);
    }

    async _notify(name, title, body) {
        // Hovering a banner keeps it on screen, so park the pointer away.
        this._pointerTo(40, Main.layoutManager.primaryMonitor.height / 2);
        Main.notify(title, body);
        await sleep(1500);
        await this._shot(name);
        // Let the banner time out before the next scene.
        await waitFor(() => !Main.messageTray._banner, 12000);
        await sleep(600);
    }

    async _launch(id) {
        const app = Shell.AppSystem.get_default().lookup_app(id);
        if (!app) {
            this._log(`app not found: ${id}`);
            return null;
        }
        app.activate();
        const window = await waitFor(() => app.get_windows()[0], 20000);
        this._log(`launched ${id}: ${window ? 'window ok' : 'no window'}`);
        return window;
    }

    async _run() {
        const seat = Clutter.get_default_backend().get_default_seat();
        this._seat = seat;
        this._pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const monitor = Main.layoutManager.primaryMonitor;
        const W = monitor.width;
        const H = monitor.height;
        this._log(`monitor ${W}x${H} scale ${monitor.geometryScale}`);

        await waitFor(() => this._dockButtons().length > 0 && this._glassSettings(), 30000);
        await sleep(2500);
        Main.overview.hide();
        await waitFor(() => !Main.overview.visible && !Main.overview.animationInProgress, 10000);
        if (WALLPAPER)
            this._setBackground({uri: WALLPAPER});
        this._setScheme(true);
        this._pointerTo(W / 2, H / 3);
        await sleep(2500);

        if (GLib.getenv('GLASS_QUICK')) {
            await this._openMenu(Main.panel.statusArea.quickSettings.menu, 'quick-qs');
            return;
        }

        // Dock at rest, hover, press.
        await this._shot('01-dock-repos-sombre');
        let buttons = this._dockButtons();
        this._log(`dock buttons: ${buttons.length}`);
        this._dumpTree(Main.layoutManager.panelBox, 'panel-tree.txt');
        const [hx, hy] = center(buttons[1] ?? buttons[0]);
        this._pointerTo(hx, hy);
        await sleep(900);
        await this._shot('02-dock-survol');
        this._button(Clutter.ButtonState.PRESSED);
        // Shoot before the long-press menu timeout of the dock fires.
        await this._shot('03-dock-clic', 60);
        this._button(Clutter.ButtonState.RELEASED);
        this._pointerTo(W / 2, H / 3);
        await sleep(300);
        this._closeDockMenus();
        this._dumpDock();
        await sleep(1500);

        // Running applications and windows behind the dock.
        const editor = await this._launch('org.gnome.TextEditor.desktop');
        const calculator = await this._launch('org.gnome.Calculator.desktop');
        await sleep(2500);
        this._pointerTo(W / 2, 20);
        await this._shot('04-applications-ouvertes');

        if (editor) {
            editor.move_resize_frame(true, Math.round(W * 0.18), H - 330, 760, 480);
            await sleep(1200);
            await this._shot('05-fenetre-derriere-dock');
            editor.move_frame(true, Math.round(W * 0.42), H - 280);
            await sleep(1200);
            await this._shot('06-fenetre-deplacee');
        }
        if (calculator) {
            calculator.move_frame(true, Math.round(W * 0.30), H - 360);
            calculator.activate(global.get_current_time());
            await sleep(1200);
            await this._shot('07-calculatrice-derriere-dock');
        }
        editor?.move_frame(true, 120, 80);
        calculator?.move_frame(true, W - 520, 80);
        await sleep(1000);

        // P1 surfaces.
        await this._openMenu(Main.panel.statusArea.quickSettings.menu, '08-reglages-rapides-sombre');
        await this._openMenu(Main.panel.statusArea.dateMenu.menu, '09-calendrier-sombre');
        // Dock context menu (right click) uses the generic menu glass.
        buttons = this._dockButtons();
        const [mx, my] = center(buttons[0]);
        this._pointerTo(mx, my);
        await sleep(300);
        this._pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_SECONDARY, Clutter.ButtonState.PRESSED);
        this._pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_SECONDARY, Clutter.ButtonState.RELEASED);
        await sleep(1200);
        await this._shot('09b-menu-contextuel-dock');
        this._closeDockMenus();
        this._pointerTo(W / 2, H / 3);
        await sleep(600);

        // Volume pop-up.
        Main.osdWindowManager.show(-1, Gio.ThemedIcon.new('audio-volume-high-symbolic'), 'Volume', 0.65, 1);
        await sleep(900);
        await this._shot('09c-osd-volume');
        await sleep(2500);

        // Real Alt+Tab through a virtual keyboard, so the shell keybinding
        // opens the switcher with Alt held.
        const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const key = (keyval, state) => keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, state);
        key(Clutter.KEY_Alt_L, Clutter.KeyState.PRESSED);
        await sleep(100);
        key(Clutter.KEY_Tab, Clutter.KeyState.PRESSED);
        key(Clutter.KEY_Tab, Clutter.KeyState.RELEASED);
        await sleep(1500);
        await this._shot('09d-alt-tab');
        key(Clutter.KEY_Escape, Clutter.KeyState.PRESSED);
        key(Clutter.KEY_Escape, Clutter.KeyState.RELEASED);
        key(Clutter.KEY_Alt_L, Clutter.KeyState.RELEASED);
        await sleep(800);

        await this._notify('10-notification-sombre', 'Glass Shell', 'Les bannières de notification utilisent le même verre que le dock.');

        // Keyboard focus ring on a dock icon.
        buttons = this._dockButtons();
        buttons[0]?.grab_key_focus();
        await this._shot('11-dock-focus-clavier');
        global.stage.set_key_focus(null);

        Main.overview.show();
        await sleep(1800);
        await this._shot('12-vue-activites');
        Main.overview.hide();
        await sleep(1800);

        // Light scheme.
        this._setScheme(false);
        await sleep(2500);
        await this._shot('13-dock-clair');
        await this._openMenu(Main.panel.statusArea.quickSettings.menu, '14-reglages-rapides-clair');
        await this._openMenu(Main.panel.statusArea.dateMenu.menu, '15-calendrier-clair');
        await this._notify('16-notification-clair', 'Glass Shell', 'Mode clair : texte foncé, teinte blanche.');

        // Test backgrounds required by the visual test set.
        editor?.minimize();
        calculator?.minimize();
        await sleep(800);
        this._setBackground({color: '#ffffff'});
        await sleep(1500);
        await this._shot('17-fond-blanc-clair');
        this._setScheme(true);
        this._setBackground({color: '#000000'});
        await sleep(2000);
        await this._shot('18-fond-noir-sombre');
        this._setBackground({color: '#e95420'});
        await sleep(1500);
        await this._shot('19-fond-colore-sombre');
        if (WALLPAPER)
            this._setBackground({uri: WALLPAPER});
        editor?.unminimize();
        await sleep(1500);
        editor?.move_resize_frame(true, Math.round(W * 0.25), H - 330, 900, 480);
        await sleep(1200);

        // Corner strategies and accessibility switches.
        const settings = this._glassSettings();
        settings.set_string('corner-strategy', 'full');
        await sleep(1500);
        await this._shot('20-coins-strategie-full');
        settings.reset('corner-strategy');
        await sleep(1500);
        await this._shot('21-coins-strategie-inset');
        settings.set_boolean('reduce-effects', true);
        await sleep(1500);
        await this._shot('22-effets-reduits');
        settings.reset('reduce-effects');
        settings.set_string('performance-profile', 'economy');
        await sleep(1500);
        await this._shot('23-profil-economie');
        settings.set_string('performance-profile', 'quality');
        await sleep(1500);
        await this._shot('24-profil-qualite');
        settings.reset('performance-profile');
        await sleep(1000);

        // Native look for comparison, then repeated enable/disable cycles.
        Main.extensionManager.disableExtension(GLASS_UUID);
        await sleep(2000);
        await this._shot('25-sans-glass-shell');
        // Enabling goes through GSettings and is asynchronous: wait for each
        // state before the next toggle.
        const state = () => Main.extensionManager.lookup(GLASS_UUID)?.state;
        const ACTIVE = 1;
        for (let i = 0; i < 20; i++) {
            Main.extensionManager.enableExtension(GLASS_UUID);
            await waitFor(() => state() === ACTIVE, 5000, 50);
            await sleep(200);
            Main.extensionManager.disableExtension(GLASS_UUID);
            await waitFor(() => state() !== ACTIVE, 5000, 50);
            await sleep(200);
        }
        Main.extensionManager.enableExtension(GLASS_UUID);
        await waitFor(() => state() === ACTIVE, 5000, 50);
        this._log(`glass state after cycles: ${state()} error=${Main.extensionManager.lookup(GLASS_UUID)?.error ?? ''}`);
        this._settings = null;
        await sleep(2500);
        await this._shot('26-apres-20-cycles');
        this._log(`wrappers after cycles: dock=${findByName(global.stage, 'glass-shell-dock').length} ` +
            `top-bar=${findByName(global.stage, 'glass-shell-top-bar').length}`);
    }
}

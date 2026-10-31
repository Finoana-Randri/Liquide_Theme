// Glass Shell: liquid glass surfaces for Ubuntu Dock and the GNOME Shell top
// bar, menus and notification banners.
//
// Nothing happens at import time. enable() builds everything and disable()
// takes it all down again, including after an enable() that failed halfway.

import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SHELL_VERSION} from './compat.js';
import {DockAdapter} from './dockAdapter.js';
import {buildRuntimeCss, RuntimeStyleSheet} from './runtimeStyle.js';
import {GlassSettings} from './settings.js';
import {SurfaceController} from './surfaceController.js';

const DIAGNOSTICS_DELAY_MS = 500;

// Collects compatibility and conflict messages and publishes them to the
// preferences window through GSettings.
class Diagnostics {
    constructor(settings) {
        this._settings = settings;
        this._entries = new Map();
        this._timeoutId = 0;
    }

    report(source, message) {
        if (message)
            this._entries.set(source, message);
        else
            this._entries.delete(source);
        this._queueWrite();
    }

    _queueWrite() {
        if (this._timeoutId)
            return;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DIAGNOSTICS_DELAY_MS, () => {
            this._timeoutId = 0;
            this.flush();
            return GLib.SOURCE_REMOVE;
        });
    }

    flush() {
        const lines = [`GNOME Shell ${SHELL_VERSION}`, ...this._entries.values()];
        const previous = this._settings.get_strv('diagnostics');
        if (previous.length !== lines.length || previous.some((line, i) => line !== lines[i]))
            this._settings.set_strv('diagnostics', lines);
    }

    destroy() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
    }
}

export default class GlassShellExtension extends Extension {
    enable() {
        try {
            this._gsettings = this.getSettings();
            this._diagnostics = new Diagnostics(this._gsettings);
            this._styleSheet = new RuntimeStyleSheet(this.uuid);
            this._settings = new GlassSettings(this._gsettings, () => this._refresh());
            this._dock = new DockAdapter({diagnostics: this._diagnostics});
            this._surfaces = new SurfaceController({diagnostics: this._diagnostics});
            this._refresh();
        } catch (e) {
            console.error(`${this.uuid}: could not enable, cleaning up`, e);
            this._diagnostics?.report('extension', `Échec de l'activation : ${e.message}`);
            this._teardown({keepDiagnostics: true});
        }
    }

    disable() {
        this._teardown();
    }

    _refresh() {
        const look = this._settings.computeLook();
        // Load the runtime sheet first so docks attached below already get
        // the right padding on their first layout.
        try {
            this._styleSheet.update(buildRuntimeCss(look));
        } catch (e) {
            console.error(`${this.uuid}: runtime stylesheet rejected`, e);
            this._diagnostics.report('stylesheet', 'Feuille de style dynamique refusée ; valeurs par défaut utilisées.');
        }
        this._dock.update(look);
        this._surfaces.update(look);
    }

    _teardown({keepDiagnostics = false} = {}) {
        // Reverse order of creation; every step tolerates a missing part.
        this._surfaces?.destroy();
        this._surfaces = null;
        this._dock?.destroy();
        this._dock = null;
        this._settings?.destroy();
        this._settings = null;
        this._styleSheet?.destroy();
        this._styleSheet = null;
        if (keepDiagnostics)
            this._diagnostics?.flush();
        this._diagnostics?.destroy();
        this._diagnostics = null;
        this._gsettings = null;
    }
}

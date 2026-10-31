// Backup and restore of the dock settings that Glass Shell changes.
// This module only uses Gio and GLib so the preferences window can share it.
//
// The backup is a small tab-separated file rather than a GSettings key so the
// uninstall script can restore it with plain gsettings calls:
//   #schemadir<TAB><directory or empty>
//   <key><TAB><value before><TAB><value applied>
// Values are GVariant text as printed by `gsettings get`.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const DOCK_SCHEMA_ID = 'org.gnome.shell.extensions.dash-to-dock';

const BACKUP_HEADER = '#schemadir';

export function backupFilePath() {
    return GLib.build_filenamev([GLib.get_user_state_dir(), 'glass-shell', 'dock-backup.tsv']);
}

// Ubuntu Dock installs its schema system-wide; Dash to Dock installed from
// extensions.gnome.org ships it inside its own folder.
export function lookupDockSettings(schemaDir = null) {
    let source = Gio.SettingsSchemaSource.get_default();
    if (schemaDir && GLib.file_test(schemaDir, GLib.FileTest.IS_DIR)) {
        try {
            source = Gio.SettingsSchemaSource.new_from_directory(schemaDir, source, false);
        } catch (e) {
            console.warn(`Glass Shell: cannot read dock schemas in ${schemaDir}: ${e.message}`);
        }
    }
    const schema = source?.lookup(DOCK_SCHEMA_ID, true);
    return schema ? new Gio.Settings({settings_schema: schema}) : null;
}

function readBackup() {
    const entries = new Map();
    let schemaDir = '';
    let contents;
    try {
        [, contents] = GLib.file_get_contents(backupFilePath());
    } catch {
        return {entries, schemaDir};
    }

    for (const line of new TextDecoder().decode(contents).split('\n')) {
        const [key, before, applied] = line.split('\t');
        if (key === BACKUP_HEADER) {
            schemaDir = before ?? '';
            continue;
        }
        if (!key || key.startsWith('#') || before === undefined || applied === undefined)
            continue;
        try {
            entries.set(key, {
                before: GLib.Variant.parse(null, before, null, null),
                applied: GLib.Variant.parse(null, applied, null, null),
            });
        } catch (e) {
            console.warn(`Glass Shell: ignoring unreadable backup line for ${key}: ${e.message}`);
        }
    }
    return {entries, schemaDir};
}

function writeBackup(entries, schemaDir) {
    const path = backupFilePath();
    if (entries.size === 0) {
        GLib.unlink(path);
        return;
    }
    const lines = [`${BACKUP_HEADER}\t${schemaDir ?? ''}`];
    for (const [key, {before, applied}] of entries)
        lines.push(`${key}\t${before.print(true)}\t${applied.print(true)}`);
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    GLib.file_set_contents(path, `${lines.join('\n')}\n`);
}

export class DockPreset {
    constructor(dockSettings, schemaDir = null) {
        this._settings = dockSettings;
        this._schemaDir = schemaDir;
        ({entries: this._entries} = readBackup());
    }

    // Set `key` to `value` and remember the value it replaces.
    // A key we already changed once is left alone, so a value the user picks
    // later in the dock settings is never overridden at the next login.
    // `owned` keys mirror a Glass Shell preference: changing that preference
    // is an explicit request, so the new value is applied again.
    ensure(key, value, {owned = false} = {}) {
        if (!this._settings.settings_schema.has_key(key))
            return;

        const current = this._settings.get_value(key);
        const entry = this._entries.get(key);
        if (!entry) {
            this._entries.set(key, {before: current, applied: value});
            this._save();
            if (!current.equal(value))
                this._settings.set_value(key, value);
            Gio.Settings.sync();
            return;
        }

        if (owned && !entry.applied.equal(value)) {
            entry.applied = value;
            this._save();
            if (!current.equal(value))
                this._settings.set_value(key, value);
            Gio.Settings.sync();
        }
    }

    _save() {
        try {
            writeBackup(this._entries, this._schemaDir);
        } catch (e) {
            console.error(`Glass Shell: cannot write the dock backup: ${e.message}`);
        }
    }
}

// Put back the dock values saved before Glass Shell changed them.
// A value the user changed since then is kept and reported.
export function restoreDockSettings() {
    const {entries, schemaDir} = readBackup();
    const result = {restored: [], kept: [], missingSchema: false};
    if (entries.size === 0)
        return result;

    const settings = lookupDockSettings(schemaDir || null);
    if (!settings) {
        result.missingSchema = true;
        return result;
    }

    for (const [key, {before, applied}] of entries) {
        if (!settings.settings_schema.has_key(key))
            continue;
        if (settings.get_value(key).equal(applied)) {
            settings.set_value(key, before);
            result.restored.push(key);
        } else {
            result.kept.push(key);
        }
    }
    Gio.Settings.sync();
    writeBackup(new Map(), schemaDir);
    return result;
}

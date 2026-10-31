// Version-dependent and internal GNOME Shell access lives here, so a breaking
// change in a future release only needs to be handled in one place.

import Meta from 'gi://Meta';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const SHELL_VERSION = Config.PACKAGE_VERSION;

// GNOME 46 renamed ENABLED to ACTIVE; both mean "running".
const STATE_ACTIVE = ExtensionState.ACTIVE ?? ExtensionState.ENABLED;

// Other extensions that are known to blur the same surfaces.
export const KNOWN_BLUR_EXTENSIONS = [
    {uuid: 'blur-my-shell@aunetx', label: 'Blur my Shell'},
];

export function lookupExtension(uuid) {
    return Main.extensionManager.lookup(uuid) ?? null;
}

export function isExtensionActive(uuid) {
    return lookupExtension(uuid)?.state === STATE_ACTIVE;
}

export function extensionPath(uuid) {
    return lookupExtension(uuid)?.dir?.get_path() ?? null;
}

// Run a callback once, right before the next frame is laid out and painted.
// Geometry read from allocations is final at that point, and changes made
// here land in the same frame instead of the next one.
export function addLater(callback) {
    return global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, callback);
}

export function removeLater(id) {
    if (id)
        global.compositor.get_laters().remove(id);
}

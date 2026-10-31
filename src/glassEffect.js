// The glass material: a blurred copy of what is behind a surface, a tinted
// layer with a soft top highlight, and a thin rim. Each part is its own actor
// so the blur never reaches the icons or text of the surface it decorates.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {addLater, removeLater} from './compat.js';

// A rectangle inset by r * (1 - 1/sqrt(2)) on every side fits entirely inside
// a rounded rectangle of radius r. Shell.BlurEffect only paints rectangles,
// so this is what keeps the blur from leaking past rounded corners.
const CORNER_INSET_RATIO = 1 - Math.SQRT1_2;

const LIGHT_TINT = [255, 255, 255];
const DARK_TINT = [38, 38, 42];

// Effects created by this extension, so conflict detection can ignore them.
const ownEffects = new WeakSet();

function rgba([r, g, b], alpha) {
    return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha)).toFixed(3)})`;
}

function cornerInset(radius) {
    return Math.ceil(radius * CORNER_INSET_RATIO);
}

// Look for a Shell.BlurEffect that another extension attached below `root`.
// Two background blurs on one surface double the GPU cost and blur twice.
export function findForeignBlur(root, maxActors = 2000) {
    const stack = [root];
    let visited = 0;
    while (stack.length > 0 && visited < maxActors) {
        const actor = stack.pop();
        visited++;
        for (const effect of actor.get_effects()) {
            if (effect instanceof Shell.BlurEffect && !ownEffects.has(effect))
                return actor;
        }
        stack.push(...actor.get_children());
    }
    return null;
}

// Allocation of `actor` expressed in the coordinate space of `ancestor`.
// Translations are ignored on purpose: slide and fade animations move the
// whole subtree, glass included.
function allocationInAncestor(actor, ancestor) {
    let x = 0;
    let y = 0;
    for (let current = actor; current !== ancestor; current = current.get_parent()) {
        if (!current)
            return null;
        const box = current.get_allocation_box();
        x += box.x1;
        y += box.y1;
    }
    const box = actor.get_allocation_box();
    return {x, y, width: box.get_width(), height: box.get_height()};
}

function tintStyle(look) {
    const color = look.scheme === 'dark' ? DARK_TINT : LIGHT_TINT;
    // The gradient start is the static top reflection; nothing animates it.
    const top = look.tintAlpha + look.highlight * 0.14;
    let css = `border-radius: ${look.radius}px;` +
        ' background-gradient-direction: vertical;' +
        ` background-gradient-start: ${rgba(color, top)};` +
        ` background-gradient-end: ${rgba(color, look.tintAlpha)};`;
    if (look.shadow)
        css += ` box-shadow: 0 6px 18px 0 rgba(0, 0, 0, ${look.shadowAlpha.toFixed(3)});`;
    return css;
}

function rimStyle(look) {
    const border = rgba(LIGHT_TINT, look.borderAlpha);
    const edges = look.rimEdges === 'bottom'
        ? `border-width: 0 0 1px 0; border-color: ${border};`
        : `border: 1px solid ${border};`;
    // With the inset corner strategy, a soft inner glow covers the thin band
    // along the edges that the blurred rectangle does not reach.
    const inset = look.cornerStrategy === 'inset' ? cornerInset(look.radius) : 0;
    const blur = Math.max(4, inset * 2);
    const spread = Math.ceil(inset / 2);
    const glowColor = look.scheme === 'dark' ? DARK_TINT : LIGHT_TINT;
    const glow = look.rimGlowAlpha + look.highlight * 0.1;
    return `border-radius: ${look.radius}px; ${edges}` +
        ` box-shadow: inset 0 1px ${blur}px ${spread}px ${rgba(glowColor, glow)};`;
}

export class GlassSurface {
    // `host` receives the glass actors; `target` is the actor whose
    // allocation the glass follows. `below` optionally names a child of
    // `host` the glass must be painted under.
    constructor({id, host, target, below = null}) {
        this._host = host;
        this._target = target;
        this._look = null;
        this._effect = null;
        this._hidden = false;
        this._suspended = false;
        this._destroyed = false;
        this._syncId = 0;
        this._geometry = null;

        this._wrapper = new St.Widget({
            name: `glass-shell-${id}`,
            style_class: 'glass-shell-wrapper',
            reactive: false,
            // A fixed zero size keeps the host layout unchanged; the children
            // are positioned by hand and are allowed to overflow.
            width: 0,
            height: 0,
            x_expand: false,
            y_expand: false,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });
        this._blurLayer = new St.Widget({style_class: 'glass-shell-blur', reactive: false});
        this._tint = new St.Widget({style_class: 'glass-shell-tint', reactive: false});
        this._rim = new St.Widget({style_class: 'glass-shell-rim', reactive: false});
        this._wrapper.add_child(this._blurLayer);
        this._wrapper.add_child(this._tint);
        this._wrapper.add_child(this._rim);

        if (below)
            host.insert_child_below(this._wrapper, below);
        else
            host.insert_child_at_index(this._wrapper, 0);

        this._wrapper.connectObject('destroy', () => this._onWrapperDestroyed(), this);

        this._ancestors = [];
        for (let actor = this._wrapper.get_parent(); actor && actor !== global.stage; actor = actor.get_parent())
            this._ancestors.push(actor);

        // Background blur reads the framebuffer it is painted into. Under an
        // ancestor that is always redirected offscreen, that buffer is empty.
        this.blurSupported = !this._ancestors.some(actor =>
            actor.offscreen_redirect & Clutter.OffscreenRedirect.ALWAYS);

        // Every actor between the target and the host can move the target.
        this._geometrySources = [];
        for (let actor = target; actor && actor !== host; actor = actor.get_parent())
            this._geometrySources.push(actor);

        const queueSync = () => this._queueSync();
        for (const actor of this._geometrySources)
            actor.connectObject('notify::allocation', queueSync, this);
        this._wrapper.connectObject('notify::allocation', queueSync, this);
        St.ThemeContext.get_for_stage(global.stage)
            .connectObject('notify::scale-factor', queueSync, this);

        // Fading ancestors are temporarily redirected offscreen, which would
        // flash an empty blur. Pause the blur until they are opaque again.
        for (const actor of this._ancestors)
            actor.connectObject('notify::opacity', () => this._updateBlurState(), this);

        this._queueSync();
    }

    setLook(look) {
        if (this._destroyed)
            return;
        this._look = look;
        this._tint.set_style(tintStyle(look));
        this._rim.set_style(rimStyle(look));
        this._wrapper.remove_style_class_name(look.scheme === 'dark' ? 'glass-shell-light' : 'glass-shell-dark');
        this._wrapper.add_style_class_name(look.scheme === 'dark' ? 'glass-shell-dark' : 'glass-shell-light');
        this._geometry = null;
        this._updateBlurState();
        this._queueSync();
    }

    // Hidden surfaces are not painted at all, for example the top bar while
    // the overview is open.
    setHidden(hidden) {
        if (this._destroyed || this._hidden === hidden)
            return;
        this._hidden = hidden;
        this._wrapper.visible = !hidden;
        this._updateBlurState();
    }

    // Suspended surfaces keep their tint but skip the blur, for example a
    // dock that has slid out of view.
    setSuspended(suspended) {
        if (this._destroyed || this._suspended === suspended)
            return;
        this._suspended = suspended;
        this._updateBlurState();
    }

    get blurActive() {
        return Boolean(this._effect?.enabled);
    }

    _updateBlurState() {
        if (this._destroyed)
            return;
        const wanted = this.blurSupported && this._look && this._look.blurRadius > 0;
        if (!wanted) {
            this._removeEffect();
            return;
        }

        const radius = Math.round(this._look.blurRadius);
        if (!this._effect) {
            this._effect = new Shell.BlurEffect({
                mode: Shell.BlurMode.BACKGROUND,
                radius,
                brightness: this._look.blurBrightness,
            });
            ownEffects.add(this._effect);
            this._blurLayer.add_effect_with_name('glass-shell-blur', this._effect);
        } else {
            if (this._effect.radius !== radius)
                this._effect.radius = radius;
            if (Math.abs(this._effect.brightness - this._look.blurBrightness) > 0.001)
                this._effect.brightness = this._look.blurBrightness;
        }

        const opaque = this._ancestors.every(actor => actor.opacity === 255);
        this._effect.enabled = opaque && !this._hidden && !this._suspended;
    }

    _removeEffect() {
        if (!this._effect)
            return;
        this._blurLayer.remove_effect(this._effect);
        this._effect = null;
    }

    _queueSync() {
        if (this._syncId || this._destroyed)
            return;
        this._syncId = addLater(() => {
            this._syncId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        if (this._destroyed || !this._look)
            return;
        if (!this._target.has_allocation() || !this._wrapper.has_allocation())
            return;

        const rect = allocationInAncestor(this._target, this._host);
        if (!rect)
            return;
        const origin = this._wrapper.get_allocation_box();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const inset = this._look.cornerStrategy === 'inset'
            ? cornerInset(this._look.radius * scale)
            : 0;
        const geometry = {
            x: Math.round(rect.x - origin.x1),
            y: Math.round(rect.y - origin.y1),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            inset,
        };

        // Repositioning queues a relayout, so skip it when nothing moved.
        const previous = this._geometry;
        if (previous && Object.keys(geometry).every(key => previous[key] === geometry[key]))
            return;
        this._geometry = geometry;

        const {x, y, width, height} = geometry;
        for (const layer of [this._tint, this._rim]) {
            layer.set_position(x, y);
            layer.set_size(width, height);
        }

        const blurWidth = width - 2 * inset;
        const blurHeight = height - 2 * inset;
        this._blurLayer.visible = blurWidth > 0 && blurHeight > 0;
        this._blurLayer.set_position(x + inset, y + inset);
        this._blurLayer.set_size(Math.max(0, blurWidth), Math.max(0, blurHeight));
    }

    _onWrapperDestroyed() {
        // The host was destroyed with our actors inside it; only the
        // bookkeeping is left to release.
        this._destroyed = true;
        this._effect = null;
        removeLater(this._syncId);
        this._syncId = 0;
        this._disconnectAll();
    }

    _disconnectAll() {
        for (const actor of this._geometrySources)
            actor.disconnectObject(this);
        for (const actor of this._ancestors)
            actor.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
    }

    destroy() {
        if (this._destroyed)
            return;
        removeLater(this._syncId);
        this._syncId = 0;
        this._removeEffect();
        this._disconnectAll();
        this._wrapper.disconnectObject(this);
        this._destroyed = true;
        this._wrapper.destroy();
    }
}

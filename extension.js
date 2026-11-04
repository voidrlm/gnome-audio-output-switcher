import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Gvc from 'gi://Gvc';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

// Gvc hands out UI device ids from one counter starting at 1 and only reports
// devices that appear after we connect, so existing ones are found by probing.
const PROBE_IDS = 1024;

// Right of Keep Awake if it's there, otherwise just left of Quick Settings.
function panelIndex() {
    const rightBox = Main.panel._rightBox;
    const children = rightBox.get_children();
    const prev = Main.panel.statusArea['keep-awake-panel@arjun']?.container;
    if (prev && children.includes(prev))
        return children.indexOf(prev) + 1;
    const next = Main.panel.statusArea.quickSettings?.container;
    const idx = next ? children.indexOf(next) : -1;
    return idx >= 0 ? idx : 0;
}

function text(...parts) {
    return parts.filter(Boolean).join(' ').toLowerCase();
}

export default class AudioOutputSwitcher extends Extension {
    enable() {
        this._control = Volume.getMixerControl();
        this._items = new Map();
        this._activeId = null;

        this._button = new PanelMenu.Button(0.5, this.metadata.name);
        this._icon = new St.Icon({
            gicon: Gio.FileIcon.new(Gio.File.new_for_path(`${this.path}/icons/audio-aux-symbolic.svg`)),
            style_class: 'system-status-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._button.add_child(this._icon);

        // Scroll on the icon changes the output volume, like the stock one.
        this._button.connect('scroll-event', (_a, event) => this._onScroll(event));

        const menu = this._button.menu;
        menu.box.add_style_class_name('audio-output-menu');
        const header = new PopupMenu.PopupMenuItem('Sound Output', {reactive: false, can_focus: false});
        header.label.add_style_class_name('audio-output-header');
        menu.addMenuItem(header);
        this._section = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._section);
        this._empty = new PopupMenu.PopupMenuItem('No outputs found', {reactive: false});
        this._section.addMenuItem(this._empty);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction('Sound Settings', () => {
            Gio.Subprocess.new(['gnome-control-center', 'sound'], Gio.SubprocessFlags.NONE);
        });

        this._control.connectObject(
            'output-added', (_c, id) => this._addDevice(id),
            'output-removed', (_c, id) => this._removeDevice(id),
            'active-output-update', (_c, id) => this._setActive(id),
            'default-sink-changed', () => this._syncActiveFromSink(),
            'state-changed', () => this._populate(),
            this);
        menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._populate();
        });

        Main.panel.addToStatusArea(this.uuid, this._button, panelIndex(), 'right');
        this._populate();
    }

    // Only outputs that exist right now: a running sink, and a port that
    // isn't reported unplugged. Hides stale or unreachable entries.
    _usable(device) {
        const stream = this._control.get_stream_from_device(device);
        if (!stream)
            return false;
        if (!this._control.get_sinks().some(s => s.get_id() === stream.get_id()))
            return false;
        return device.port_available !== false;
    }

    _populate() {
        if (!this._control || this._control.get_state() !== Gvc.MixerControlState.READY)
            return;
        for (let id = 1; id <= PROBE_IDS; id++) {
            const dev = this._control.lookup_output_id(id);
            if (dev && this._usable(dev))
                this._addDevice(id);
            else if (this._items.has(id))
                this._removeDevice(id);
        }
        this._syncActiveFromSink();
    }

    _syncActiveFromSink() {
        const sink = this._control.get_default_sink();
        const device = sink ? this._control.lookup_device_from_stream(sink) : null;
        if (device) {
            this._addDevice(device.get_id());
            this._setActive(device.get_id());
        } else {
            this._updateIcon();
        }
    }

    _addDevice(id) {
        if (this._items.has(id))
            return;
        const device = this._control.lookup_output_id(id);
        if (!device || !this._usable(device))
            return;

        const {description, origin} = device;
        const item = new PopupMenu.PopupImageMenuItem(description ?? 'Unknown output', this._iconFor(device));
        if (origin) {
            const sub = new St.Label({text: origin, style_class: 'audio-output-origin', y_align: Clutter.ActorAlign.CENTER, x_expand: true});
            item.label.x_expand = false;
            item.add_child(sub);
        }
        item.connect('activate', () => {
            const dev = this._control.lookup_output_id(id);
            if (dev)
                this._control.change_output(dev);
        });
        this._section.addMenuItem(item);
        this._items.set(id, item);
        item.setOrnament(id === this._activeId ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        this._empty.visible = false;
    }

    _removeDevice(id) {
        this._items.get(id)?.destroy();
        this._items.delete(id);
        this._empty.visible = this._items.size === 0;
        if (id === this._activeId) {
            this._activeId = null;
            this._updateIcon();
        }
    }

    _setActive(id) {
        this._activeId = id;
        for (const [itemId, item] of this._items)
            item.setOrnament(itemId === id ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        this._updateIcon();
    }

    // Symbolic icon that fits the top bar, from what the device looks like.
    _iconFor(device) {
        const stream = this._control.get_stream_from_device(device);
        const formFactor = stream?.get_form_factor?.() ?? '';
        const name = stream?.get_name?.() ?? '';
        const desc = text(device.description, device.origin, device.port_name, device.get_icon_name?.(), name, formFactor);

        if (/headphone|headset|earbud|airpod|buds|hands-?free/.test(desc))
            return 'audio-headphones-symbolic';
        if (/bluez|bluetooth/.test(desc))
            return 'bluetooth-active-symbolic';
        if (/hdmi|displayport|monitor|\btv\b/.test(desc))
            return 'video-display-symbolic';
        if (/usb/.test(desc))
            return 'audio-card-symbolic';
        return 'audio-speakers-symbolic';
    }

    _updateIcon() {
        const device = this._activeId !== null ? this._control.lookup_output_id(this._activeId) : null;
        this._button.accessible_name = device ? `Sound output: ${device.description}` : 'Sound output';
    }

    _onScroll(event) {
        const sink = this._control.get_default_sink();
        if (!sink)
            return Clutter.EVENT_PROPAGATE;
        let delta = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP: delta = 1; break;
        case Clutter.ScrollDirection.DOWN: delta = -1; break;
        case Clutter.ScrollDirection.SMOOTH: delta = -event.get_scroll_delta()[1]; break;
        default: return Clutter.EVENT_PROPAGATE;
        }
        const max = this._control.get_vol_max_norm();
        const step = max * 0.05;
        const vol = Math.max(0, Math.min(max, sink.volume + delta * step));
        sink.set_volume(vol);
        sink.push_volume();
        if (sink.is_muted && vol > 0)
            sink.change_is_muted(false);
        Main.panel.statusArea.quickSettings?._volumeOutput?._output?.showOSD?.();
        return Clutter.EVENT_STOP;
    }

    disable() {
        this._control?.disconnectObject(this);
        this._control = null;
        this._items?.clear();
        this._items = null;
        this._button?.destroy();
        this._button = null;
        this._icon = null;
        this._section = null;
        this._empty = null;
    }
}

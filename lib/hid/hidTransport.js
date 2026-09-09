'use strict';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {createUnixInputStream, createUnixOutputStream} from './unixStreams.js';

// Owns the hidraw node of one device: opens it, keeps a read loop running and
// periodically sends the protocol's battery request. Parsed battery reports
// are delivered through the 'battery-changed' signal. Has no dependency on
// the GNOME Shell UI so it can be exercised from a plain gjs script.

// Wireless mice sleep when idle and stop answering. Keep the last reading for
// a while before treating the device as gone (level 0 hides the widget).
const MAX_MISSED_RESPONSES = 10;

export const HidTransport = GObject.registerClass({
    GTypeName: 'BluetoothBatteryMeter_HidTransport',
    Signals: {
        'battery-changed': {param_types: [GObject.TYPE_INT, GObject.TYPE_STRING]},
        'closed': {},
    },
}, class HidTransport extends GObject.Object {
    _init(node, protocol) {
        super._init();
        this._node = node;
        this._protocol = protocol;
        this._cancellable = new Gio.Cancellable();
        this._running = false;
        this._missedResponses = 0;
        this._awaitingResponse = false;
        this._pollTimerId = null;
        this._responseTimerId = null;
        this.level = 0;
        this.status = 'discharging';
    }

    get node() {
        return this._node;
    }

    start() {
        try {
            const file = Gio.File.new_for_path(this._node);
            this._ioStream = file.open_readwrite(null);
            const fd = this._ioStream.get_input_stream().get_fd();
            this._inputStream = createUnixInputStream(fd);
            this._outputStream = createUnixOutputStream(fd);
        } catch (e) {
            console.log(`Bluetooth-Battery-Meter: Cannot open ${this._node}: ${e.message}`);
            this._closeStreams();
            return false;
        }

        this._running = true;
        this._readLoop();
        this._poll();
        this._pollTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            this._protocol.pollIntervalSec, () => {
                this._poll();
                return GLib.SOURCE_CONTINUE;
            });
        return true;
    }

    async _readLoop() {
        while (this._running) {
            let bytes;
            try {
                // eslint-disable-next-line no-await-in-loop
                bytes = await this._inputStream.read_bytes_async(
                    this._protocol.reportSize, GLib.PRIORITY_DEFAULT, this._cancellable);
            } catch (e) {
                if (this._running && !e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.log(`Bluetooth-Battery-Meter: Read failed on ${this._node}: ${e.message}`);
                break;
            }

            if (!bytes || bytes.get_size() === 0)
                break;

            this._processReport(bytes.toArray());
        }

        if (this._running) {
            this.stop();
            this.emit('closed');
        }
    }

    _processReport(data) {
        const battery = this._protocol.parseResponse(data);
        if (!battery)
            return;

        this._missedResponses = 0;
        this._awaitingResponse = false;
        this._clearResponseTimer();
        this._updateBattery(battery.level, battery.status);
    }

    async _poll() {
        if (!this._running || this._awaitingResponse)
            return;

        this._awaitingResponse = true;
        try {
            await this._outputStream.write_all_async(this._protocol.buildRequest(),
                GLib.PRIORITY_DEFAULT, this._cancellable, null);
        } catch (e) {
            this._awaitingResponse = false;
            if (!this._running)
                return;
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.log(`Bluetooth-Battery-Meter: Write failed on ${this._node}: ${e.message}`);
            this.stop();
            this.emit('closed');
            return;
        }

        this._clearResponseTimer();
        this._responseTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            this._protocol.responseTimeoutMs, () => {
                this._responseTimerId = null;
                this._awaitingResponse = false;
                this._missedResponses++;
                if (this._missedResponses >= MAX_MISSED_RESPONSES)
                    this._updateBattery(0, 'discharging');
                return GLib.SOURCE_REMOVE;
            });
    }

    _updateBattery(level, status) {
        if (this.level === level && this.status === status)
            return;

        this.level = level;
        this.status = status;
        this.emit('battery-changed', level, status);
    }

    _clearResponseTimer() {
        if (this._responseTimerId)
            GLib.source_remove(this._responseTimerId);
        this._responseTimerId = null;
    }

    _closeStreams() {
        try {
            this._ioStream?.close(null);
        } catch {
            // Device may already be gone
        }
        this._inputStream = null;
        this._outputStream = null;
        this._ioStream = null;
    }

    stop() {
        this._running = false;
        this._awaitingResponse = false;
        this._cancellable.cancel();
        this._clearResponseTimer();
        if (this._pollTimerId)
            GLib.source_remove(this._pollTimerId);
        this._pollTimerId = null;
        this._closeStreams();
    }

    destroy() {
        this.stop();
    }
});

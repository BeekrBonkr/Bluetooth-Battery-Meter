'use strict';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {WidgetManagerHid} from './widgetManagerHid.js';
import {HidTransport} from './hidTransport.js';
import {findHidProtocol} from './hidProtocols.js';
import * as Helper from './hidHelper.js';

// Battery reporting for USB HID devices (wired or through a 2.4GHz receiver)
// that use a vendor specific protocol instead of the standard HID battery
// usage. Mirrors lib/upower/upowerDevice.js: HidClient discovers devices and
// keeps the 'hid-device-list' setting in sync, HidDevice drives the widgets.

const HidDevice = GObject.registerClass({
    GTypeName: 'BluetoothBatteryMeter_HidDevice',
}, class HidDevice extends GObject.Object {
    _init(hidClient, info, protocol) {
        super._init();
        this._hidClient = hidClient;
        this._toggle = hidClient._toggle;
        this._info = info;
        this._protocol = protocol;
        this._id = Helper.getStableId(info);
        this._transport = new HidTransport(info.node, protocol);
        this._transport.connectObject(
            'battery-changed', () => this._sync(),
            'closed', () => this._hidClient._removeDevice(this._info.node),
            this
        );
        this._transport.start();
    }

    get id() {
        return this._id;
    }

    _sync() {
        const model = this._info.hidName || this._id;
        const percentage = this._transport.level;
        const status = this._transport.status;

        let deviceProp;
        let devicePropUpdated = false;
        if (this._hidClient._deviceList.has(this._id)) {
            deviceProp = this._hidClient._deviceList.get(this._id);
            if (deviceProp.model !== model) {
                deviceProp.model = model;
                devicePropUpdated = true;
            }
        } else {
            deviceProp = {
                alias: model,
                icon: this._protocol.defaultIcon,
                model,
                hideDevice: false,
            };
            this._hidClient._deviceList.set(this._id, deviceProp);
            this._hidClient._delayedUpdateDeviceGsettings();
        }

        let device = this._hidClient._deviceWidgets.get(this._id);
        const showDevice = !deviceProp.hideDevice && percentage > 0;

        if (showDevice && !device) {
            device = new WidgetManagerHid(this._toggle, this._id, deviceProp.alias,
                deviceProp.icon, percentage, status);
            this._hidClient._deviceWidgets.set(this._id, device);
        } else if (showDevice && device) {
            device.updateBattery(percentage, status);
        } else if (!showDevice && device) {
            device.destroy();
            this._hidClient._deviceWidgets.delete(this._id);
        }

        if (devicePropUpdated) {
            this._hidClient._deviceList.set(this._id, deviceProp);
            this._hidClient._pushDevicesToGsetting();
        }
    }

    destroy() {
        this._transport?.disconnectObject(this);
        this._transport?.destroy();
        this._transport = null;
        this._hidClient = null;
        this._toggle = null;
    }
});

export const HidClient = GObject.registerClass({
    GTypeName: 'BluetoothBatteryMeter_HidClient',
}, class HidClient extends GObject.Object {
    constructor(toggle) {
        super();
        this._toggle = toggle;
        this._settings = toggle.settings;
        this._deviceItems = new Map();   // hidraw node -> HidDevice
        this._deviceWidgets = new Map(); // stable id -> WidgetManagerHid
        this._deviceList = new Map();    // stable id -> user configuration
        this._pullDevicesFromGsetting();
        this._connectSettingsSignal(true);
        this._monitor = Helper.watchHidrawNodes(() => this._rescan());
        this._rescan();
    }

    _rescan() {
        const present = new Set();
        for (const info of Helper.enumerateHidrawDevices()) {
            const protocol = findHidProtocol(info);
            if (!protocol)
                continue;

            present.add(info.node);
            if (!this._deviceItems.has(info.node))
                this._deviceItems.set(info.node, new HidDevice(this, info, protocol));
        }

        for (const node of [...this._deviceItems.keys()]) {
            if (!present.has(node))
                this._removeDevice(node);
        }
    }

    _removeDevice(node) {
        const device = this._deviceItems.get(node);
        if (!device)
            return;

        this._deviceItems.delete(node);
        const stillPresent = [...this._deviceItems.values()].some(d => d.id === device.id);
        if (!stillPresent && this._deviceWidgets.has(device.id)) {
            this._deviceWidgets.get(device.id)?.destroy();
            this._deviceWidgets.delete(device.id);
        }
        device.destroy();
    }

    _connectSettingsSignal(connect) {
        if (connect) {
            this._settingSignalId = this._settings.connect('changed::hid-device-list', () => {
                this._pullDevicesFromGsetting();
                this._deviceWidgets.forEach(device => device?.destroy());
                this._deviceWidgets.clear();
                this._deviceItems.forEach(device => device?._sync());
            });
        } else if (this._settingSignalId) {
            this._settings.disconnect(this._settingSignalId);
            this._settingSignalId = null;
        }
    }

    _pullDevicesFromGsetting() {
        this._deviceList.clear();
        const deviceList = this._settings.get_strv('hid-device-list');
        for (const jsonString of deviceList) {
            const item = JSON.parse(jsonString);
            const deviceProps = {
                'alias': item['alias'],
                'icon': item['icon'],
                'model': item['model'],
                'hideDevice': item['hide-device'],
            };
            if (!deviceProps.alias)
                deviceProps.alias = deviceProps.model;
            this._deviceList.set(item.path, deviceProps);
        }
    }

    _pushDevicesToGsetting() {
        const deviceList = [];
        for (const [path, deviceProps] of this._deviceList) {
            const item = {
                path,
                'alias': deviceProps.alias,
                'icon': deviceProps.icon,
                'model': deviceProps.model,
                'hide-device': deviceProps.hideDevice,
            };
            deviceList.push(JSON.stringify(item));
        }
        this._connectSettingsSignal(false);
        this._settings.set_strv('hid-device-list', deviceList);
        this._connectSettingsSignal(true);
    }

    _delayedUpdateDeviceGsettings() {
        if (this._delayedTimerId)
            GLib.source_remove(this._delayedTimerId);
        this._delayedTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._pushDevicesToGsetting();
            this._delayedTimerId = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._delayedTimerId)
            GLib.source_remove(this._delayedTimerId);
        this._delayedTimerId = null;
        this._monitor?.destroy();
        this._monitor = null;
        this._connectSettingsSignal(false);
        if (this._deviceWidgets) {
            this._deviceWidgets.forEach(device => device?.destroy());
            this._deviceWidgets.clear();
        }
        this._deviceWidgets = null;
        if (this._deviceItems) {
            this._deviceItems.forEach(item => item?.destroy());
            this._deviceItems.clear();
        }
        this._deviceItems = null;
    }
});

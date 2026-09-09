'use strict';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Shared helpers for talking to USB HID devices through the kernel hidraw
// interface. Used by both the extension (lib/hid/hidDevice.js) and the
// preferences page (preferences/hidDevices.js).

const HIDRAW_SYSFS_DIR = '/sys/class/hidraw';
const DEV_DIR = '/dev';
const RESCAN_DELAY_MS = 1000;

function readSysfsFile(path) {
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        return ok ? contents : null;
    } catch {
        return null;
    }
}

// Extracts the first Usage Page from a HID report descriptor. Vendor defined
// interfaces use pages >= 0xFF00 and are the ones exposing battery protocols.
function parseUsagePage(descriptor) {
    if (!descriptor || descriptor.length < 2)
        return -1;

    const tag = descriptor[0];
    if (tag === 0x05)
        return descriptor[1];

    if (tag === 0x06 && descriptor.length >= 3)
        return descriptor[1] | (descriptor[2] << 8);

    return -1;
}

// Device names such as "Keychron Keychron M7 8K" repeat the vendor prefix.
export function humanizeHidName(name) {
    if (!name)
        return '';

    const words = name.trim().split(/\s+/);
    if (words.length > 1 && words[0].toLowerCase() === words[1].toLowerCase())
        words.shift();

    return words.join(' ');
}

export function getStableId(info) {
    const vid = info.vendorId.toString(16).padStart(4, '0');
    const pid = info.productId.toString(16).padStart(4, '0');
    return `hid:${vid}:${pid}`;
}

// Returns an array of {node, name, bus, vendorId, productId, hidName, usagePage}
// for every hidraw node currently registered by the kernel.
export function enumerateHidrawDevices() {
    const devices = [];
    const dir = Gio.File.new_for_path(HIDRAW_SYSFS_DIR);
    let enumerator;
    try {
        enumerator = dir.enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
    } catch {
        return devices;
    }

    let fileInfo;
    while ((fileInfo = enumerator.next_file(null))) {
        const name = fileInfo.get_name();
        const ueventData = readSysfsFile(`${HIDRAW_SYSFS_DIR}/${name}/device/uevent`);
        if (!ueventData)
            continue;

        const uevent = new TextDecoder().decode(ueventData);
        const idMatch = uevent.match(/HID_ID=([0-9A-Fa-f]+):([0-9A-Fa-f]+):([0-9A-Fa-f]+)/);
        if (!idMatch)
            continue;

        const nameMatch = uevent.match(/HID_NAME=(.*)/);
        const descriptor =
            readSysfsFile(`${HIDRAW_SYSFS_DIR}/${name}/device/report_descriptor`);

        devices.push({
            node: `${DEV_DIR}/${name}`,
            name,
            bus: parseInt(idMatch[1], 16),
            vendorId: parseInt(idMatch[2], 16),
            productId: parseInt(idMatch[3], 16),
            hidName: humanizeHidName(nameMatch ? nameMatch[1] : ''),
            usagePage: parseUsagePage(descriptor),
        });
    }
    enumerator.close(null);
    return devices;
}

export function canAccessNode(node) {
    try {
        const info = Gio.File.new_for_path(node).query_info(
            'access::can-read,access::can-write', Gio.FileQueryInfoFlags.NONE, null);
        return info.get_attribute_boolean('access::can-read') &&
            info.get_attribute_boolean('access::can-write');
    } catch {
        return false;
    }
}

// Watches /dev for hidraw nodes appearing or disappearing. The callback is
// debounced, since udev applies permissions shortly after the node is created.
// Returns an object with a destroy() method.
export function watchHidrawNodes(callback) {
    let monitor = null;
    let timerId = null;

    const scheduleCallback = () => {
        if (timerId)
            GLib.source_remove(timerId);
        timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESCAN_DELAY_MS, () => {
            timerId = null;
            callback();
            return GLib.SOURCE_REMOVE;
        });
    };

    try {
        monitor = Gio.File.new_for_path(DEV_DIR).monitor_directory(
            Gio.FileMonitorFlags.NONE, null);
        monitor.connect('changed', (_monitor, file, _otherFile, eventType) => {
            if (eventType !== Gio.FileMonitorEvent.CREATED &&
                eventType !== Gio.FileMonitorEvent.DELETED &&
                eventType !== Gio.FileMonitorEvent.ATTRIBUTE_CHANGED)
                return;

            if (file.get_basename().startsWith('hidraw'))
                scheduleCallback();
        });
    } catch {
        console.log('Bluetooth-Battery-Meter: Failed to monitor /dev for hidraw devices');
    }

    return {
        destroy() {
            if (timerId)
                GLib.source_remove(timerId);
            timerId = null;
            monitor?.cancel();
            monitor = null;
        },
    };
}

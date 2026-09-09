'use strict';

// Vendor specific HID battery protocols.
//
// Each protocol describes how to recognise the hidraw node that speaks the
// protocol and how to request / parse the battery report:
//   id:                unique protocol name
//   vendorId:          USB vendor ID that must match
//   usagePage:         HID usage page of the vendor interface that must match
//   defaultIcon:       icon used until the user picks another one in preferences
//   reportSize:        size of output/input reports including report ID byte
//   pollIntervalSec:   how often a battery request is sent
//   responseTimeoutMs: how long to wait for a reply to a request
//   buildRequest():    returns Uint8Array to write to the hidraw node
//   parseResponse(b):  returns {level, status} or null if the report is not a
//                      battery report. status is 'charging' or 'discharging'.

// Keychron wireless mice (M3/M5/M6/M7 ...) either connected with the USB
// cable or through the Keychron (Ultra-)Link 2.4GHz receiver.
// Interface with usage page 0xFFC1: a status request (report 0xB3, cmd 0x06)
// is answered with report 0xB4 where byte 20 holds the battery level. Bit 7
// of that byte is set while the mouse is charging over the cable.
// Reference: https://github.com/csutcliff/keychron-battery-dkms
const KeychronProtocol = {
    id: 'keychron',
    vendorId: 0x3434,
    usagePage: 0xFFC1,
    defaultIcon: 'input-mouse',
    reportSize: 64,
    pollIntervalSec: 60,
    responseTimeoutMs: 2000,

    buildRequest() {
        const request = new Uint8Array(this.reportSize);
        request[0] = 0xB3;
        request[1] = 0x06;
        return request;
    },

    parseResponse(data) {
        if (!data || data.length < 21 || data[0] !== 0xB4 || data[1] !== 0x06)
            return null;

        const raw = data[20];
        const level = raw & 0x7F;
        if (level > 100)
            return null;

        return {
            level,
            status: (raw & 0x80) !== 0 ? 'charging' : 'discharging',
        };
    },
};

export const hidProtocols = [
    KeychronProtocol,
];

export function findHidProtocol(deviceInfo) {
    return hidProtocols.find(protocol =>
        protocol.vendorId === deviceInfo.vendorId &&
        protocol.usagePage === deviceInfo.usagePage) ?? null;
}

'use strict';
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {supportedIcons} from '../lib/widgets/iconGroups.js';
import * as Helper from '../lib/hid/hidHelper.js';
import {findHidProtocol, hidProtocols} from '../lib/hid/hidProtocols.js';

const SETTINGS_KEY = 'hid-device-list';

function updateDeviceSetting(settings, path, updater) {
    const devices = settings.get_strv(SETTINGS_KEY);
    const index = devices.findIndex(item => JSON.parse(item).path === path);
    if (index === -1)
        return;

    const item = JSON.parse(devices[index]);
    updater(item);
    devices[index] = JSON.stringify(item);
    settings.set_strv(SETTINGS_KEY, devices);
}

const  ConfigureWindow = GObject.registerClass({
    GTypeName: 'BluetoothBatteryMeter_HidConfigureWindow',
}, class ConfigureWindow extends Adw.Window {
    _init(settings, pathInfo, parentWindow) {
        super._init({
            title: pathInfo.model,
            default_width: 580,
            default_height: 600,
            modal: true,
            transient_for: parentWindow,
        });

        const toolViewBar = new Adw.ToolbarView();

        const headerBar = new Adw.HeaderBar({
            decoration_layout: 'icon:close',
            show_end_title_buttons: true,
        });

        const page = new Adw.PreferencesPage();

        toolViewBar.add_top_bar(headerBar);
        toolViewBar.set_content(page);
        this.set_content(toolViewBar);

        const modelGroup = new Adw.PreferencesGroup({
            title: `Model: ${pathInfo.model}`,
            description: `ID: ${pathInfo.path}`,
        });
        page.add(modelGroup);

        const iconGroup = new Adw.PreferencesGroup({
            title: _('Icon'),
        });

        const iconRow = new Adw.ActionRow({
            title: _('Select Icon'),
            subtitle: _('Select the icon used for the indicator and quick menu'),
        });

        const iconSplitButton = new Adw.SplitButton({
            icon_name: `bbm-${pathInfo.icon}-symbolic`,
            valign: Gtk.Align.CENTER,
        });

        const popover = new Gtk.Popover({
            has_arrow: true,
            autohide: true,
        });

        const grid = new Gtk.Grid({
            column_spacing: 10,
            row_spacing: 10,
        });

        const maxRows = 7;
        const totalIcons = supportedIcons.length;
        const columns = Math.ceil(totalIcons / maxRows);
        supportedIcons.forEach((deviceType, index) => {
            const button = new Gtk.Button({
                icon_name: `bbm-${deviceType}-symbolic`,
                valign: Gtk.Align.CENTER,
            });
            const column = index % columns;
            const row = Math.floor(index / columns);
            grid.attach(button, column, row, 1, 1);
            button.connect('clicked', () => {
                popover.hide();
                updateDeviceSetting(settings, pathInfo.path, item => {
                    item['icon'] = deviceType;
                });
                iconSplitButton.icon_name = `bbm-${deviceType}-symbolic`;
            });
        });

        popover.set_child(grid);
        iconSplitButton.set_popover(popover);
        iconRow.add_suffix(iconSplitButton);
        iconGroup.add(iconRow);
        page.add(iconGroup);

        const aliasGroup = new Adw.PreferencesGroup({
            title: _('Alias'),
        });

        const aliasRow = new Adw.EntryRow({
            title: _('Device Alias'),
            text: pathInfo.alias || '',
            show_apply_button: true,
            activates_default: false,
        });

        aliasRow.connect('apply', row => {
            updateDeviceSetting(settings, pathInfo.path, item => {
                item['alias'] = row.text.trim();
            });
        });

        aliasGroup.add(aliasRow);
        page.add(aliasGroup);

        const indicatorGroup = new Adw.PreferencesGroup({
            title: _('Indicator'),
        });

        const indicatorRow = new Adw.ActionRow({
            title: _('Configure Indicator'),
            subtitle: _('Choose how the indicator should behave'),
        });

        const indicatorOptions = [
            {id: true, label: _('Hide Icon')},
            {id: false, label: _('Show Icon')},
        ];

        const dropDown = new Gtk.DropDown({
            valign: Gtk.Align.CENTER,
            model: Gtk.StringList.new(indicatorOptions.map(option => option.label)),
            selected: indicatorOptions.findIndex(option => option.id === !!pathInfo.hideDevice),
        });

        dropDown.connect('notify::selected', () => {
            const selected = indicatorOptions[dropDown.get_selected()];
            updateDeviceSetting(settings, pathInfo.path, item => {
                item['hide-device'] = selected.id;
            });
        });

        indicatorRow.add_suffix(dropDown);
        indicatorRow.activatable_widget = dropDown;
        indicatorGroup.add(indicatorRow);
        page.add(indicatorGroup);
    }
}
);

const  DeviceItem = GObject.registerClass({
    GTypeName: 'BluetoothBatteryMeter_HidDeviceItem',
}, class DeviceItem extends Adw.ActionRow {
    constructor(settings, deviceItems, pathInfo, presentDevices) {
        super({});
        this._pathInfo = pathInfo;

        this._icon = new Gtk.Image({
            icon_name: `bbm-${this._pathInfo.icon}-symbolic`,
        });

        this._customiseButton = new Gtk.Button({
            icon_name: 'bbm-settings-symbolic',
            tooltip_text: _('Configure device.'),
            valign: Gtk.Align.CENTER,
        });

        this._customiseButton.connect('clicked', () => {
            const parentWindow = this._customiseButton.get_ancestor(Gtk.Window);
            const configureWindow = new ConfigureWindow(settings, this._pathInfo, parentWindow);
            configureWindow.present();
        });

        this._deleteButton = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            tooltip_text: _('Delete device information: ' +
                'The button is available after the device is disconnected'),
            css_classes: ['destructive-action'],
            valign: Gtk.Align.CENTER,
        });

        this._deleteButton.connect('clicked', () => {
            const devices = settings.get_strv(SETTINGS_KEY);
            const index = devices.findIndex(entry => JSON.parse(entry).path === pathInfo.path);
            if (index !== -1) {
                devices.splice(index, 1);
                settings.set_strv(SETTINGS_KEY, devices);
            }
            this.get_parent().remove(this);
            deviceItems.delete(pathInfo.path);
        });

        const box = new Gtk.Box({spacing: 16});
        box.append(this._customiseButton);
        box.append(this._deleteButton);
        this.add_prefix(this._icon);
        this.add_suffix(box);

        this.updateProperties(pathInfo, presentDevices);
    }

    updateProperties(pathInfo, presentDevices) {
        this._pathInfo = pathInfo;
        const present = presentDevices.get(pathInfo.path);
        let status;
        if (!present)
            status = _('(Offline)');
        else if (!present.accessible)
            status = _('(No permission)');
        else
            status = _('(Online)');

        this.title = pathInfo.model;
        this.subtitle = present ? `${present.node} ${status}` : `${pathInfo.path} ${status}`;
        this._deleteButton.sensitive = !present;
        this._icon.icon_name = `bbm-${pathInfo.icon}-symbolic`;
    }
});

export const  HidDevices = GObject.registerClass({
    GTypeName: 'BluetoothBatteryMeter_HidDeviceUI',
    Template: GLib.Uri.resolve_relative(
        import.meta.url, '../ui/hidDevices.ui', GLib.UriFlags.NONE
    ),
    InternalChildren: [
        'enable_hid_level_icon',
        'hid_permission_group',
        'hid_permission_row',
        'hid_permission_copy_button',
        'hid_device_group',
        'no_online_row',
    ],
}, class HidDevices extends Adw.PreferencesPage {
    constructor(settings) {
        super({});
        this._settings = settings;
        this._presentDevices = new Map(); // stable id -> {node, accessible, model}
        this._deviceItems = new Map();
        this._settings.bind(
            'enable-hid-level-icon',
            this._enable_hid_level_icon,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        this._settingSignalId = this._settings.connect('changed::enable-hid-level-icon', () =>
            this._hidManager());

        const vendors = hidProtocols.map(
            protocol => protocol.vendorId.toString(16).padStart(4, '0'));
        const rule = vendors.map(vendor =>
            `SUBSYSTEM=="hidraw", ATTRS{idVendor}=="${vendor}", TAG+="uaccess"`).join('\n');
        this._hid_permission_row.subtitle = rule;
        this._hid_permission_copy_button.connect('clicked', () => {
            const display = Gdk.Display.get_default();
            display?.get_clipboard().set(rule);
        });

        this._hidManager();
    }

    _hidManager() {
        const enabled = this._settings.get_boolean('enable-hid-level-icon');
        this._hid_permission_group.visible = enabled;
        this._hid_device_group.visible = enabled;
        if (enabled) {
            this._scanDevices();
            this._createDevices();
            if (!this._monitor)
                this._monitor = Helper.watchHidrawNodes(() => this._onNodesChanged());
            if (!this._signalId) {
                this._signalId =
                    this._settings.connect(`changed::${SETTINGS_KEY}`, () => this._createDevices());
            }
        } else {
            if (this._signalId)
                this._settings.disconnect(this._signalId);
            this._signalId = null;
            this._monitor?.destroy();
            this._monitor = null;
            if (this._deviceItems.size > 0) {
                this._deviceItems.forEach(item => this._hid_device_group.remove(item));
                this._deviceItems.clear();
            }
        }
    }

    _onNodesChanged() {
        this._scanDevices();
        this._createDevices();
    }

    _scanDevices() {
        this._presentDevices.clear();
        for (const info of Helper.enumerateHidrawDevices()) {
            const protocol = findHidProtocol(info);
            if (!protocol)
                continue;

            this._presentDevices.set(Helper.getStableId(info), {
                node: info.node,
                accessible: Helper.canAccessNode(info.node),
                model: info.hidName,
                icon: protocol.defaultIcon,
            });
        }
    }

    _createDevices() {
        const configured = this._settings.get_strv(SETTINGS_KEY).map(JSON.parse);
        const devices = new Map();
        for (const info of configured) {
            devices.set(info['path'], {
                path: info['path'],
                icon: info['icon'],
                model: info['model'],
                alias: info['alias'],
                hideDevice: info['hide-device'],
            });
        }

        // Devices that are present but were never seen by the extension (for
        // example while the extension is disabled or lacks permission) are
        // listed too so the user can see their permission state.
        for (const [id, present] of this._presentDevices) {
            if (!devices.has(id)) {
                devices.set(id, {
                    path: id, icon: present.icon, model: present.model || id,
                    alias: present.model, hideDevice: false, unconfigured: true,
                });
            }
        }

        this._no_online_row.visible = devices.size === 0;
        for (const pathInfo of devices.values()) {
            if (this._deviceItems.has(pathInfo.path)) {
                const row = this._deviceItems.get(pathInfo.path);
                row.updateProperties(pathInfo, this._presentDevices);
                row._customiseButton.sensitive = !pathInfo.unconfigured;
            } else {
                const deviceItem =
                    new DeviceItem(this._settings, this._deviceItems, pathInfo,
                        this._presentDevices);
                deviceItem._customiseButton.sensitive = !pathInfo.unconfigured;
                this._deviceItems.set(pathInfo.path, deviceItem);
                this._hid_device_group.add(deviceItem);
            }
        }
    }

    destroy() {
        this._monitor?.destroy();
        this._monitor = null;

        if (this._settingSignalId && this._settings)
            this._settings.disconnect(this._settingSignalId);
        this._settingSignalId = null;

        if (this._signalId && this._settings)
            this._settings.disconnect(this._signalId);
        this._signalId = null;

        this._settings = null;
    }
});

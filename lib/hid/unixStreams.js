'use strict';
import Gio from 'gi://Gio';

// GLib 2.80 moved the Unix specific streams to the GioUnix namespace, and GJS
// warns when the old Gio.Unix*Stream aliases are used. Prefer GioUnix and fall
// back to the Gio aliases on older platforms.
let GioUnix = null;
try {
    GioUnix = (await import('gi://GioUnix')).default;
} catch {
    GioUnix = null;
}

export function createUnixInputStream(fd) {
    if (GioUnix?.InputStream)
        return GioUnix.InputStream.new(fd, false);
    return Gio.UnixInputStream.new(fd, false);
}

export function createUnixOutputStream(fd) {
    if (GioUnix?.OutputStream)
        return GioUnix.OutputStream.new(fd, false);
    return Gio.UnixOutputStream.new(fd, false);
}

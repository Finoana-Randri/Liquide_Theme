#!/usr/bin/env bash
# Container entry point, run as root: GNOME Shell needs a system bus with
# logind on it. A python-dbusmock logind stands in for systemd, as in the
# GNOME Shell test suite. The session itself runs as an unprivileged user.

set -euo pipefail

mkdir -p /run/dbus /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix
chmod 777 /out
dbus-daemon --system --fork
python3 -m dbusmock --system --template logind >/out/logind-mock.log 2>&1 &
sleep 2
# The session bus, and the dconf service it activates, must share the
# runtime directory of the shell or settings changes are never seen.
su tester -c "export GLASS_QUICK=${GLASS_QUICK:-} XDG_RUNTIME_DIR=/tmp/runtime && mkdir -p /tmp/runtime && chmod 700 /tmp/runtime && dbus-run-session -- bash /session.sh"

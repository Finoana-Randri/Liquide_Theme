# Headless Ubuntu desktop used to capture real GNOME Shell screenshots of
# Glass Shell. Rendering is done by Mesa llvmpipe, so the images are faithful
# but frame timings from this container say nothing about real hardware.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        gnome-shell ubuntu-session gnome-shell-extension-ubuntu-dock \
        yaru-theme-gnome-shell yaru-theme-icon yaru-theme-gtk ubuntu-wallpapers \
        fonts-ubuntu adwaita-icon-theme gsettings-desktop-schemas \
        dbus dbus-user-session dconf-service dconf-gsettings-backend glib2.0-bin \
        libgl1-mesa-dri libegl-mesa0 xwayland \
        gnome-text-editor gnome-calculator gnome-clocks gnome-characters \
        libnotify-bin locales python3-dbusmock ca-certificates sudo xz-utils librsvg2-common git fonts-inter fontconfig \
    && sed -i 's/^# *fr_FR.UTF-8/fr_FR.UTF-8/' /etc/locale.gen && locale-gen \
    && rm -rf /var/lib/apt/lists/*

# A container has no login session, so logname(1) prints nothing; the
# WhiteSur installer relies on it. Test image only.
RUN useradd -m -s /bin/bash tester \
    && printf '#!/bin/sh\necho "${USER:-tester}"\n' > /usr/local/bin/logname \
    && chmod 755 /usr/local/bin/logname
USER tester
WORKDIR /home/tester

# Install the WhiteSur look once at build time with the project script, so
# every test run starts from the same themed desktop.
COPY --chown=tester scripts /opt/glass-shell/scripts
COPY --chown=tester src /opt/glass-shell/src
COPY --chown=tester assets /opt/glass-shell/assets
ENV USER=tester
RUN dbus-run-session -- bash /opt/glass-shell/scripts/install-appearance.sh --color light

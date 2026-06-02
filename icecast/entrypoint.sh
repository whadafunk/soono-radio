#!/bin/sh
# Fix log directory ownership so icecast2 can write after privilege drop.
# This runs as root; icecast2 binary drops to icecast2 via <changeowner>.
chown -R icecast2:icecast2 /usr/local/icecast/logs 2>/dev/null || true
exec icecast2 -c /etc/icecast2/icecast.xml

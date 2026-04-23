I want to build a complex radio automation and streaming server in one app.
The final result should be a server that has a nice graphical backend for streamers with player, playlist, jingle organization, etc.
Broadcast streams through icecast.
The two components we decided on are icecast and liquid soap.
We will start with liquid soap and a settings control panel for it, but before that we should
discuss how we package this app. We just use containers and start everything with docker compose?
What if we also want a installable version or even a linux distro? Can we do those later?
I guess for starters we can use containers to develop our features.


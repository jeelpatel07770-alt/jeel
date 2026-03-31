#!/bin/sh
# Virtual display + VNC for the CF challenge solver in Docker.
#
# The CF solver needs a headed (visible) browser because a human must click
# through the challenge. Docker has no display server, so we run:
#   Xvfb (virtual framebuffer) -> x11vnc (VNC server) -> noVNC (web client)
#
# When idle, these use ~5-10MB RAM and the noVNC port shows a black screen.
# When the Solve button is clicked, the solver launches Firefox on DISPLAY=:99
# and the user interacts via the noVNC web viewer on port 6080.
#
# Why not on-demand? Starting/stopping Xvfb per solve adds process lifecycle
# complexity for minimal savings. Always-on is simpler and cheap.

# Start Xvfb (virtual framebuffer) on display :99
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp &

# Wait for display to be ready
sleep 1

# Start x11vnc (VNC server) on the virtual display, no password
x11vnc -display :99 -forever -nopw -quiet &

# Start noVNC (browser-based VNC client) via websockify
# Serves the noVNC web app and proxies WebSocket to x11vnc
NOVNC_PATH=$(find /usr -path "*/novnc/utils/novnc_proxy" -o -path "*/novnc/utils/launch.sh" 2>/dev/null | head -1)
if [ -n "$NOVNC_PATH" ]; then
  "$NOVNC_PATH" --vnc localhost:5900 --listen "${NOVNC_PORT:-6080}" &
else
  # Fallback: use websockify directly with noVNC web root
  NOVNC_WEB=$(find /usr -type d -name novnc 2>/dev/null | head -1)
  websockify --web "$NOVNC_WEB" "${NOVNC_PORT:-6080}" localhost:5900 &
fi

# Run the app
cd /app/orchestrator
exec sh -c "npx tsx src/server/db/migrate.ts && npm run start"

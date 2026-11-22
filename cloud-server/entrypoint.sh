#!/usr/bin/env bash
set -e

mkdir -p /tmp/jobs /tmp/uploads

# Start CUPS daemon in background so lpinfo/lpadmin can register the Epson PPD
cupsd

# Wait briefly for cupsd socket
for i in $(seq 1 15); do
  if lpstat -r >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# Pick the closest Epson ESC/P-R PPD (L3210 -> L3110 -> L3250 -> any escpr)
PPD_URI=$(lpinfo -m 2>/dev/null | grep -i "escpr" | grep -iE "L3210" | head -n 1 | awk '{print $1}')
if [ -z "$PPD_URI" ]; then
  PPD_URI=$(lpinfo -m 2>/dev/null | grep -i "escpr" | grep -iE "L3110|L3250|L3150" | head -n 1 | awk '{print $1}')
fi
if [ -z "$PPD_URI" ]; then
  PPD_URI=$(lpinfo -m 2>/dev/null | grep -i "escpr" | head -n 1 | awk '{print $1}')
fi

if [ -n "$PPD_URI" ]; then
  echo "[CUPS] Registering virtual printer with PPD: $PPD_URI"
  lpadmin -p epson_l3210 -E -v file:///dev/null -m "$PPD_URI"
else
  echo "[CUPS] WARNING: No escpr PPD found!"
fi

# Startup check: verify /usr/lib/cups/filter/epson-escpr-wrapper exists
if [ -x /usr/lib/cups/filter/epson-escpr-wrapper ]; then
  echo "[CUPS] ✓ epson-escpr-wrapper filter verified"
else
  echo "[CUPS] ✗ WARNING: /usr/lib/cups/filter/epson-escpr-wrapper missing!"
fi

exec node /app/server.js

#!/bin/bash
set -e

# Ensure current UID has a passwd entry if needed
if ! getent passwd "$(id -u)" > /dev/null; then
  echo "lidify:x:$(id -u):$(id -g):Lidify User:/home:/bin/bash" >> /etc/passwd
fi

# Use tini for signal handling, then run the main CMD
exec /usr/bin/tini -- "$@"

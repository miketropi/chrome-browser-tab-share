#!/bin/sh
set -eu
case "${TURN_HOST:-}" in *[!A-Za-z0-9.-]*|'') echo 'Invalid TURN_HOST' >&2; exit 1;; esac
case "${TURN_LISTEN_IP:-}" in *[!0-9.]*|'') echo 'Invalid TURN_LISTEN_IP' >&2; exit 1;; esac
case "${TURN_TLS_PORT:-}" in *[!0-9]*|'') echo 'Invalid TURN_TLS_PORT' >&2; exit 1;; esac
[ "${#TURN_SHARED_SECRET}" -ge 32 ] || { echo 'TURN_SHARED_SECRET must be at least 32 characters' >&2; exit 1; }
[ -f "$TURN_CERT_PATH" ] && [ -f "$TURN_KEY_PATH" ] || { echo 'Trusted TURN certificate and key files are required' >&2; exit 1; }
umask 077
cp /config/turnserver.conf.template /tmp/turnserver.conf
sed -i "s|__TURN_HOST__|$TURN_HOST|g;s|__TURN_LISTEN_IP__|$TURN_LISTEN_IP|g;s|__TURN_TLS_PORT__|$TURN_TLS_PORT|g;s|__TURN_CERT_PATH__|$TURN_CERT_PATH|g;s|__TURN_KEY_PATH__|$TURN_KEY_PATH|g;s|__TURN_SHARED_SECRET__|$TURN_SHARED_SECRET|g" /tmp/turnserver.conf
exec turnserver -c /tmp/turnserver.conf

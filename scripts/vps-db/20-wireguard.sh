#!/usr/bin/env bash
# Phase 1, step 8 (RUNBOOK.md): WireGuard server wg0 (plan §4.6). Run as root;
# safe to re-run. The server's private key is made here and never leaves the
# server. Peers are added with `gk-peer set-wg <name> <public key>`; each
# peer's private key is made on its own side (the Mac's WireGuard app, or
# mac/make-github-keys.sh straight into GitHub secrets).
. "$(dirname "$0")/lib.sh"
need_root
need_config VPS_PUBLIC_IP

install -d -m 700 /etc/wireguard
if [ ! -s /etc/wireguard/server.key ]; then
  log "Making the server's WireGuard key"
  (umask 077; wg genkey > /etc/wireguard/server.key)
fi
wg pubkey < /etc/wireguard/server.key > /etc/wireguard/server.pub

gk-peer apply
systemctl enable wg-quick@wg0 >/dev/null 2>&1
systemctl is-active --quiet wg-quick@wg0 || systemctl start wg-quick@wg0

log "WireGuard is up on $WG_SERVER_IP, UDP $WG_PORT."
log "Server public key: $(cat /etc/wireguard/server.pub)"
log "Endpoint for peers: $VPS_PUBLIC_IP:$WG_PORT"
gk-peer list

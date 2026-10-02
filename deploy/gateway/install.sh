#!/usr/bin/env bash
# Installs the gateway on a host that runs Caddy from its Debian package. Run as root, with the
# user's approval: it creates a system user, keys under /etc/buckspay-gateway, a systemd unit and
# the Caddy configuration. It prints the fee payer's address and the HPKE public key apps pin.
# usage: install.sh <host, e.g. gw.buckspay.xyz> <buckspay-gateway binary> <solana-keygen binary>
set -euo pipefail
umask 077
usage="usage: install.sh <host> <binary> <solana-keygen>"
host=${1:?$usage}
binary=${2:?$usage}
keygen=${3:?$usage}
here=$(cd "$(dirname "$0")" && pwd)
etc=/etc/buckspay-gateway

id buckspay-gateway > /dev/null 2>&1 ||
  useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin buckspay-gateway
usermod --append --groups buckspay-gateway caddy
install -m 0755 "$binary" /usr/local/bin/buckspay-gateway

install -d -m 0750 -o root -g buckspay-gateway "$etc"
# Keys are created here, once, readable by root only, and never leave the host: systemd hands
# copies to the service.
[ -e "$etc/fee-payer.json" ] || "$keygen" new --no-bip39-passphrase --silent --outfile "$etc/fee-payer.json"
if [ ! -e "$etc/hpke.key" ]; then
  openssl genpkey -algorithm X25519 -out "$etc/hpke.pem"
  openssl pkey -in "$etc/hpke.pem" -outform DER | tail -c 32 > "$etc/hpke.key"
  openssl pkey -in "$etc/hpke.pem" -pubout -outform DER | tail -c 32 | base64 > "$etc/hpke.pub"
  rm "$etc/hpke.pem"
fi
# The RPC URL may hold a provider's API key: root reads the file for systemd, Caddy does not.
[ -e "$etc/gateway.env" ] || install -m 0600 "$here/gateway.env.example" "$etc/gateway.env"

install -m 0644 "$here/buckspay-gateway.service" /etc/systemd/system/buckspay-gateway.service
install -m 0644 "$here/Caddyfile" /etc/caddy/Caddyfile
install -d -m 0755 /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironment=GATEWAY_HOST=%s\nEnvironment=GATEWAY_SOCKET=/run/buckspay-gateway/gateway.sock\n' "$host" \
  > /etc/systemd/system/caddy.service.d/buckspay-gateway.conf
chmod 0644 /etc/systemd/system/caddy.service.d/buckspay-gateway.conf

systemctl daemon-reload
systemctl enable --now buckspay-gateway
# The admin API is off, so Caddy takes its configuration on a restart, not a reload.
systemctl restart caddy
echo "fee payer: $("$keygen" pubkey "$etc/fee-payer.json")"
echo "HPKE public key to pin: $(cat "$etc/hpke.pub")"

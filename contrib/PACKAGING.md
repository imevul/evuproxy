# Packaging notes

- Version is embedded with `-ldflags "-X main.version=..."` when building `cmd/evuproxy`.
- Optional `.deb` / RPM builds are out of scope for the initial tree; distro maintainers can wrap `evuproxy` as a single binary plus `/etc/evuproxy` config.
- **CrowdSec**: optional integration via `crowdsec.enabled` and set `crowdsec_block_v4` — see [`crowdsec/README.md`](crowdsec/README.md) and `make crowdsec-install`. Disabled by default; not installed by `scripts/install.sh`.

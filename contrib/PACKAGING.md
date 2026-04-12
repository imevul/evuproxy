# Packaging notes

- Version is embedded with `-ldflags "-X main.version=..."` when building `cmd/evuproxy`.
- Optional `.deb` / RPM builds are out of scope for the initial tree; distro maintainers can wrap `evuproxy` as a single binary plus `/etc/evuproxy` config.
- **CrowdSec**: optional future bouncer or nftables integration — disabled by default (later milestone).

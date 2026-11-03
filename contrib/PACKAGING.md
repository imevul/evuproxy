# Packaging notes

- Version is embedded with `-ldflags "-X main.version=..."` when building `cmd/evuproxy`.
- Releases include optional `.deb` and RPM packages, built by [`scripts/build-packages.sh`](../scripts/build-packages.sh) from [`packaging/`](../packaging) with [nfpm](https://nfpm.goreleaser.com/). `make package-test` takes them through install, upgrade and removal in containers; see [`devtools/package-test`](../devtools/package-test/README.md). Using them is covered in the [README](../README.md#install-from-a-package).
- The packages never enable a unit, start `evuproxy.service` or change IP forwarding, including on upgrade. `config.yaml` is copied from a seed under `/usr/share/evuproxy` only when missing, instead of being a conffile, so no package manager can replace it or ask about it.
- Distro maintainers can also wrap `evuproxy` as a single binary plus `/etc/evuproxy` config.
- **CrowdSec**: optional integration via `crowdsec.enabled` and set `crowdsec_block_v4` — see [`crowdsec/README.md`](crowdsec/README.md) and `make crowdsec-install`. Disabled by default; not installed by `scripts/install.sh`.

# Changelog

## [0.13.0](https://github.com/imevul/evuproxy/compare/v0.12.0...v0.13.0) (2026-07-03)


### Features

* harden apply/reload path and complete review remediation ([f07b6d2](https://github.com/imevul/evuproxy/commit/f07b6d27e53a949f6f6fec95fcddc2be87b8cda4))

## [Unreleased]

Security and reliability hardening pass (in progress).

### Security

* **wireguard:** validate `wireguard.address` and peer `public_key` before they are written to `/etc/wireguard/*.conf`, rejecting newlines/control characters. Prevents an authenticated config write from injecting a `PostUp` directive that `wg-quick` would run as root.
* **geo:** validate each downloaded zone line as an IP/CIDR before interpolating into the nftables ruleset (defense against a compromised/MITM zone source).

### Reliability

* **reload:** replace nftables tables in a single atomic transaction so a failed load rolls back and never leaves the host with the INPUT policy-drop chain removed (fail-closed).
* **crowdsec:** preserve active bans across reloads instead of flushing the set on every apply.
* **apply:** per-command timeouts on all privileged subprocesses (`nft`, `wg`, `wg-quick`, `tar`) and a cross-process file lock serializing reload/update-geo/backup/restore/save so CLI and API operations cannot interleave.

### CI

* Run `gofmt`, `go vet`, `go test -race`, and ShellCheck on pull requests; add a `make check` target.

## [0.12.0](https://github.com/imevul/evuproxy/compare/v0.11.0...v0.12.0) (2026-05-23)


### Features

* **abuse:** rate limits, CrowdSec, and Prometheus observability ([1cd6cdd](https://github.com/imevul/evuproxy/commit/1cd6cddff192ea9602a1272ae7f296410d3236b8))
* **crowdsec:** add install script with Docker and native paths ([a8598b8](https://github.com/imevul/evuproxy/commit/a8598b81bff752c2852d50bf0f497d31e646b41b))
* **forwarding:** port maps, deny lists, route geo, and maintenance mode ([f081b1f](https://github.com/imevul/evuproxy/commit/f081b1f91ecf1b0ac862901a3a5beb86359b5cf3))
* **logs:** surface CrowdSec drops in log viewer ([15ce59f](https://github.com/imevul/evuproxy/commit/15ce59f26d2169b71b374b6639e8143cec73af33))
* **peers:** add API fallback when Web Crypto is unavailable on HTTP. ([5ac2eae](https://github.com/imevul/evuproxy/commit/5ac2eae459801ef274e5db838e90d19767f06817))
* **ui:** gate Advanced tabs with disabled state and hints ([3739696](https://github.com/imevul/evuproxy/commit/37396963dfd1e7b86f5964ab433cc385d0203371))


### Bug Fixes

* **abuse:** harden review findings and deferred operator gaps ([156bcee](https://github.com/imevul/evuproxy/commit/156bcee6d7f5132e57e1f99fe5b34f2f42605208))
* **crowdsec:** allow staged Docker install before bouncer key exists. ([8477092](https://github.com/imevul/evuproxy/commit/8477092e7f6492e70e5a9fdac8cf825f31c4adab))
* **crowdsec:** build local nft bouncer image instead of missing Hub tag. ([7f5df91](https://github.com/imevul/evuproxy/commit/7f5df91598d7aa2efe11273b7ffb4ed6274d40ea))
* **crowdsec:** fetch bouncer binary from GitHub releases in Docker build. ([ecacaf3](https://github.com/imevul/evuproxy/commit/ecacaf371a213975367fa138fd88ab90efc16fc0))
* **crowdsec:** prefetch bouncer binary on host for offline Docker build. ([550c11e](https://github.com/imevul/evuproxy/commit/550c11e47240fa658081c0cab6e6f003ba797e7c))
* **crowdsec:** recover from Docker-created acquis.yaml directory trap. ([d4ef63f](https://github.com/imevul/evuproxy/commit/d4ef63f8885c8f7409986fba8548ca689f1b4de9))
* **crowdsec:** remove RETURN trap that broke install under set -u. ([2dd9f1d](https://github.com/imevul/evuproxy/commit/2dd9f1d6adea16695cef406cb88df97dee304039))
* **crowdsec:** set LOCAL_API_URL so cscli can reach LAPI in Docker. ([ef0bc46](https://github.com/imevul/evuproxy/commit/ef0bc460535d53bf6c7e16d4f4d4b42eb7188b88))
* **crowdsec:** start LAPI offline when CrowdSec HTTPS is blocked. ([f512781](https://github.com/imevul/evuproxy/commit/f512781efd2e4cb65be96eeb969aab8bd330821a))
* **crowdsec:** use host network and gitignore local compose configs. ([a5cd49b](https://github.com/imevul/evuproxy/commit/a5cd49b2be1bb1a16125a8a0ef05218b560e196f))
* **nft:** enforce max_conn_per_ip before forward established accept. ([a7bcab2](https://github.com/imevul/evuproxy/commit/a7bcab28a085cb4d83ecf88fc3456290c1c4a9da))
* **nft:** meter all UDP packets for udp_per_second limits. ([88d3c69](https://github.com/imevul/evuproxy/commit/88d3c6907ad781857e0a8ee728d96ba2a41703e0))
* **nft:** use ct count over N-1 for max_conn_per_ip limits. ([1474946](https://github.com/imevul/evuproxy/commit/14749463661057de1ec767ed0eb610edb0d82b8c))
* **nft:** use inline ct count for max_conn_per_ip limits. ([90d5dc7](https://github.com/imevul/evuproxy/commit/90d5dc73ebe7d2b7668201f29ffdc097ff3954e5))
* **reload:** retry nft validate after deleting live EvuProxy tables. ([9eb550b](https://github.com/imevul/evuproxy/commit/9eb550b36299cf117e7f0e9e279a60201716b972))
* **reload:** stage wg syncconf temp file under /etc/wireguard. ([990ac24](https://github.com/imevul/evuproxy/commit/990ac243799f5ce7e9dda478e88acca7806e74d4))
* **ui:** correct peer crypto fallback API paths. ([2b0782d](https://github.com/imevul/evuproxy/commit/2b0782da2f7190ab2785391bf1ad897289d4c97f))
* **ui:** guard peer onboarding copy when clipboard is unavailable. ([d6f1dda](https://github.com/imevul/evuproxy/commit/d6f1ddad348be382bf5e60c6609836922d45f088))

## [0.11.0](https://github.com/imevul/evuproxy/compare/v0.10.0...v0.11.0) (2026-05-17)


### Features

* **peers:** EVUB onboarding via bash installers and tightened admin UI. ([532b886](https://github.com/imevul/evuproxy/commit/532b886016e0bc945c35c10675b8e526bacbcac0))


### Bug Fixes

* **docker:** derive UI healthcheck URL from EVUPROXY_UI_LISTEN ([958ba01](https://github.com/imevul/evuproxy/commit/958ba0184dd9270954daaad70af2d63c72d1826c))
* **ui:** tabbed Settings and tidier Overview cards. ([07b8c5f](https://github.com/imevul/evuproxy/commit/07b8c5f2a098400e22eb2252faf0241dcc727323))

## [0.10.0](https://github.com/imevul/evuproxy/compare/v0.9.0...v0.10.0) (2026-05-16)


### Features

* Topology page, mock config persistence, and sidebar version notice ([a7a05a1](https://github.com/imevul/evuproxy/commit/a7a05a157e59a230b684b972d42445dc8add5c39))
* **web:** topology graph pan/zoom with Center control ([1a1ef86](https://github.com/imevul/evuproxy/commit/1a1ef862dde3067e1128cdfec906bb39f34e9911))

## [0.9.0](https://github.com/imevul/evuproxy/compare/v0.8.0...v0.9.0) (2026-05-09)


### Features

* SQLite peer metrics collector, API, and admin UI ([b3eb254](https://github.com/imevul/evuproxy/commit/b3eb2545a2ff65a987f3633eccb84aaa970888f8))

## [0.8.0](https://github.com/imevul/evuproxy/compare/v0.7.0...v0.8.0) (2026-04-13)


### Features

* **geo:** optional apply geoblocking to input_allows ([c81880a](https://github.com/imevul/evuproxy/commit/c81880afc00ad675bb9d4af7a65aa243d2b52df6))


### Bug Fixes

* **ui:** geoblocking unsaved indicator; geo config roundtrip tests ([fa8932e](https://github.com/imevul/evuproxy/commit/fa8932ea3ff0cb426bef42d1b8d6fba5549d8f70))

## [0.7.0](https://github.com/imevul/evuproxy/compare/v0.6.0...v0.7.0) (2026-04-13)


### Features

* admin API enhancements, audit logging, and security hardening ([ddb5c89](https://github.com/imevul/evuproxy/commit/ddb5c8982b13fb6a2e62972f02682ffdb5016e37))
* **logs:** optional GeoLite2 MMDB for SRC/DST country flags ([08d4296](https://github.com/imevul/evuproxy/commit/08d4296c83ef4e1e780df00de62c949d67cb6558))
* **ui:** show country flags in geo zones summary table ([b131a2c](https://github.com/imevul/evuproxy/commit/b131a2c866d8d6720e6769357614e61ff266f36c))


### Bug Fixes

* **config:** allow port ranges up to 65535 distinct ports ([a41b73b](https://github.com/imevul/evuproxy/commit/a41b73bfc369cfa351c7df1fcb2da30531427747))
* **serve:** tolerate unreadable GeoLite MMDB with stderr hint ([2ea90b9](https://github.com/imevul/evuproxy/commit/2ea90b91e04bbab5aa683724413ee743f78baa3c))

## [0.6.0](https://github.com/imevul/evuproxy/compare/v0.5.0...v0.6.0) (2026-04-13)


### Features

* **security:** implement CodeQL path sanitization in backup and restore functions ([ebf8354](https://github.com/imevul/evuproxy/commit/ebf835486f31d81d36de4765149a25606d40e00f))
* **web:** client-side firewall log filtering and table view ([b06d97f](https://github.com/imevul/evuproxy/commit/b06d97f0ae33d4a6bac781b8e1f0b81d9c4105e5))
* **web:** layout width setting, logs toolbar and date filters ([457d217](https://github.com/imevul/evuproxy/commit/457d217989e84b6001422a29564defabc1f882ba))


### Bug Fixes

* **security:** address CodeQL path, zip-slip, logging, and GHA permissions ([1775c7e](https://github.com/imevul/evuproxy/commit/1775c7e3357729161c5ce8cc36c012fd2a55f038))

## [0.5.0](https://github.com/imevul/evuproxy/compare/v0.4.0...v0.5.0) (2026-04-13)


### Features

* disable input_allows in config; unify disabled toggles in UI ([8b25598](https://github.com/imevul/evuproxy/commit/8b25598124c627448ca1ed1b02c3a0e0ba0dd2bb))


### Bug Fixes

* **ui:** pending diff for large nftables and empty baseline ([44228da](https://github.com/imevul/evuproxy/commit/44228da756d82a6f703d2233aee57107793cbdbb))
* **ui:** revalidate cached static assets in production nginx ([744da9d](https://github.com/imevul/evuproxy/commit/744da9da0e942293123f688a8e57612aeaf94438))

## [0.4.0](https://github.com/imevul/evuproxy/compare/v0.3.0...v0.4.0) (2026-04-13)


### Features

* **api:** mutating-op mutex, backup allowlist, timeouts, observability ([23507ed](https://github.com/imevul/evuproxy/commit/23507ed9d7ce5571cc9bf723c092663f9811f778))


### Bug Fixes

* **config:** disable geo feature in evuproxy example configuration ([09d5ab2](https://github.com/imevul/evuproxy/commit/09d5ab2981b22015778c71b2476c0b694d3f779a))

## [0.3.0](https://github.com/imevul/evuproxy/compare/v0.2.0...v0.3.0) (2026-04-12)


### Features

* **api:** add optional CORS for cross-origin web UI ([e4fe086](https://github.com/imevul/evuproxy/commit/e4fe086f045b230febcf36b37680daba7f522564))
* **nftables:** optional forward allows for Docker bridge egress ([f1c1db0](https://github.com/imevul/evuproxy/commit/f1c1db09bf7c5df531d65879abb65a7a926c3920))


### Bug Fixes

* **nftables:** allow Docker ingress when forward_allow_docker_bridges ([d0f6170](https://github.com/imevul/evuproxy/commit/d0f61708f8512c847ba30754a4fdbc82a2f8e2ab))

## [0.2.0](https://github.com/imevul/evuproxy/compare/v0.1.0...v0.2.0) (2026-04-12)


### Features

* admin UI config API, stats, preferences, dev mock stack ([1fba449](https://github.com/imevul/evuproxy/commit/1fba44924f8651e6f52e4b0d3da85501e46908a0))
* **docker:** host network for UI; proxy API via 127.0.0.1:9847 ([dbe33b4](https://github.com/imevul/evuproxy/commit/dbe33b4a3e4154495d38965f04759b83a1cdfe7b))
* **prefs:** default peer tunnel subnet to 10.100.0.0/24 on server ([9d702f5](https://github.com/imevul/evuproxy/commit/9d702f5350842d79af865a9267b3ea77481c2dde))


### Bug Fixes

* **compose:** allow EVUPROXY_UI_LISTEN override from environment ([28adc8c](https://github.com/imevul/evuproxy/commit/28adc8c5484d8234658c51e0205df3d3e176456c))
* **nft:** default INPUT allow for admin UI TCP/9080 ([232024d](https://github.com/imevul/evuproxy/commit/232024d522f18fcee65b5e82f4c11042cee9b9ba))
* **ui:** show clear message when API upstream returns HTML (502) ([c00ee6c](https://github.com/imevul/evuproxy/commit/c00ee6c278f24da81f83a6c9f646e76697057514))

## Changelog

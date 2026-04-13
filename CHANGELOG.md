# Changelog

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

# Changelog

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

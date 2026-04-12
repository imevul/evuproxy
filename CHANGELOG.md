# Changelog

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

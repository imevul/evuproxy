# Changelog

## [0.18.0](https://github.com/imevul/evuproxy/compare/v0.17.0...v0.18.0) (2026-11-03)


### ⚠ BREAKING CHANGES

* **api:** POST /reload with no body, or without config_hash or force, no longer applies anything and answers 409. Automation that calls it directly must send {"force": true} to keep the old behavior, or send the config_hash from POST /validate. An admin UI older than the API gets the same 409 until updated. The CLI is unaffected. See "Apply gate" in docs/http-api.md.

### Features

* add optional .deb and RPM packages (ENG-169) ([88de34a](https://github.com/imevul/evuproxy/commit/88de34a008c30bc2c34b27179fe193f4cfa36904))
* add optional .deb and RPM packages (ENG-169) ([d0b1ae3](https://github.com/imevul/evuproxy/commit/d0b1ae3a75af59ad5d215b45fdfcd5b185cc0f76))
* **api:** add a read-only API token (ENG-196) ([0a59372](https://github.com/imevul/evuproxy/commit/0a593720f68a91a06d59488fc669634c3fc2136f))
* **api:** add a read-only API token (ENG-196) ([4431534](https://github.com/imevul/evuproxy/commit/443153408b4cca8cf7b87f4836ca943f53e3a22b))
* **api:** add optional mTLS listener (ENG-166) ([c286849](https://github.com/imevul/evuproxy/commit/c286849c99400765259ca5dbbf13b9add13718cd))
* **api:** add optional mTLS listener (ENG-166) ([d28c199](https://github.com/imevul/evuproxy/commit/d28c1993d0e62387790c20699b0639c82facc97a))
* **api:** optional bearer token for the Prometheus listener (ENG-198) ([b1a076e](https://github.com/imevul/evuproxy/commit/b1a076ea2499213256f86f7078c0b2f766fd17ed))
* **api:** optional bearer token for the Prometheus listener (ENG-198) ([f0d0f53](https://github.com/imevul/evuproxy/commit/f0d0f536edf12d69e743e12f99643be955c54b56))
* **api:** refuse cross-origin state-changing requests (ENG-164) ([37df98c](https://github.com/imevul/evuproxy/commit/37df98cc848246780955e9be2ee72e18eb6aa718))
* **api:** refuse cross-origin state-changing requests (ENG-164) ([b6f6d09](https://github.com/imevul/evuproxy/commit/b6f6d098f4744c3b41d52b6c319469fd05b3eac4))
* **api:** require a checked config hash or force on POST /reload (ENG-162) ([4a8a143](https://github.com/imevul/evuproxy/commit/4a8a1435f6b7963f40a1e3421a6e96b1d45246f0))
* Apply with automatic rollback unless confirmed (ENG-146) ([cfa58d9](https://github.com/imevul/evuproxy/commit/cfa58d95b7a9a2e9936b225e911c3954a685a603))
* Apply with automatic rollback unless confirmed (ENG-146) ([674bbd6](https://github.com/imevul/evuproxy/commit/674bbd63ac36b12c52376a769620a29ae2ccf4f0))
* auto-pause loop and pause_when_peer_offline (ENG-158) ([c21e08d](https://github.com/imevul/evuproxy/commit/c21e08d49e78be095bc50684043906728826c0be))
* auto-pause loop and pause_when_peer_offline (ENG-158) ([c43fd31](https://github.com/imevul/evuproxy/commit/c43fd31b0cf352d9599095c6e9abf74d125eb639))
* boot applies the last confirmed config when confirm is on (ENG-185) ([bc61296](https://github.com/imevul/evuproxy/commit/bc6129630d2398c711048ebaa889551f88370173))
* boot applies the last confirmed config when confirm is on (ENG-185) ([045e1af](https://github.com/imevul/evuproxy/commit/045e1af33a54a9c4fba664026e0b182ed67833c8))
* **docker:** publish the UI image to GHCR on release (ENG-168) ([dffcac2](https://github.com/imevul/evuproxy/commit/dffcac28d65faa5a57ff40125b7c294ee0558c75))
* **docker:** publish the UI image to GHCR on release (ENG-168) ([c6ea9c8](https://github.com/imevul/evuproxy/commit/c6ea9c8737abc3d09c372159b38fad8a045c5ab0))
* **gen:** add optional counters on drop rules (ENG-161) ([949ecf1](https://github.com/imevul/evuproxy/commit/949ecf1deb66d5fb297e2c29ea400cf1f4b936b9))
* **gen:** add optional counters on drop rules (ENG-161) ([70f3749](https://github.com/imevul/evuproxy/commit/70f37496fb48cbac0bab7ec176c7d4bfa9be2343))
* Keep changes needs a new connection (ENG-184) ([5e1e8e8](https://github.com/imevul/evuproxy/commit/5e1e8e8aef81317505a8f2cc841e8e1b8858e3c7))
* Keep changes needs a new connection (ENG-184) ([0c8b180](https://github.com/imevul/evuproxy/commit/0c8b1805744391343e753561761e18b72c22d697))
* **logging:** reopen log file on SIGHUP (ENG-172) ([0f49191](https://github.com/imevul/evuproxy/commit/0f491912b8c388d1620a2bcf06b8ef80ab76d8bc))
* **logging:** reopen log file on SIGHUP (ENG-172) ([c4fb2a7](https://github.com/imevul/evuproxy/commit/c4fb2a7e756a84420da37340309fdec28297ff7b))
* **metrics:** expose per-route accepted counters in Prometheus (ENG-156) ([f8c036e](https://github.com/imevul/evuproxy/commit/f8c036e7c24c8754010bfa5996df979cec7df827))
* **metrics:** expose per-route accepted counters in Prometheus (ENG-156) ([120146f](https://github.com/imevul/evuproxy/commit/120146ff13f209e01a9554e6f0764aecd4b476c2))
* omit DNAT for auto-paused routes (ENG-159) ([94851af](https://github.com/imevul/evuproxy/commit/94851afde572e2e8d06f171e787c553261430ab6))
* omit DNAT for auto-paused routes (ENG-159) ([e6c5883](https://github.com/imevul/evuproxy/commit/e6c5883b27f1cb4d2fa45b3cf75ee103c19a80cb))
* **scripts:** add an upgrade path for binary-only installs (ENG-170) ([cfcb710](https://github.com/imevul/evuproxy/commit/cfcb71062979d95fbe03f4d75db1a9c6b30f150b))
* **scripts:** add an upgrade path for binary-only installs (ENG-170) ([8ae77ec](https://github.com/imevul/evuproxy/commit/8ae77ec5ab61c55413b023bbdb0bab53c0958ff4))
* **stats:** add per-route accepted counters to GET /stats (ENG-154) ([14c8b1c](https://github.com/imevul/evuproxy/commit/14c8b1c1168cff1f14dd22fed899c42859c7b93c))
* **stats:** add per-route accepted counters to GET /stats (ENG-154) ([dd9ad63](https://github.com/imevul/evuproxy/commit/dd9ad63c394c5948a708ccc058306ac07a9d5a7c))
* **ui:** add Accepted column to Routes (ENG-155) ([4aadf7c](https://github.com/imevul/evuproxy/commit/4aadf7c96e5bf955236238520abea5c5d99edd3d))
* **ui:** add Accepted column to Routes (ENG-155) ([fe0bd03](https://github.com/imevul/evuproxy/commit/fe0bd03a6de3f5165206f4bb116e6e350cbe10a8))
* **ui:** add Routes pause checkbox and Auto-paused banner (ENG-160) ([bc860eb](https://github.com/imevul/evuproxy/commit/bc860eba3f12bf5fb816ac6f1f12f86ebd5b68bb))
* **ui:** add Routes pause checkbox and Auto-paused banner (ENG-160) ([3a93304](https://github.com/imevul/evuproxy/commit/3a93304437e8d7fbc16e4796e6e69cd78ab43429))
* **ui:** add toast system and confirm every config save (ENG-135) ([e59db42](https://github.com/imevul/evuproxy/commit/e59db4267eb78dc80c0046a7a5429a4ee0646a11))
* **ui:** motion and hierarchy pass, first-run guide, titles and favicon (ENG-143) ([56a342f](https://github.com/imevul/evuproxy/commit/56a342ffc5533e227c553764c79bb8df710deba7))
* **ui:** motion and hierarchy pass, first-run guide, titles and favicon (ENG-143) ([31ccb43](https://github.com/imevul/evuproxy/commit/31ccb43e825816e50b225a078b498bcb2221c6eb))
* **ui:** one save model with instant switches and a save bar (ENG-137) ([bd23883](https://github.com/imevul/evuproxy/commit/bd238837b2e88a3163e849274fc0a1a2b94e4c3f))
* **ui:** one save model with instant switches and a save bar (ENG-137) ([a8f8d7d](https://github.com/imevul/evuproxy/commit/a8f8d7df36c2ca4c7d7fc7f4036fc137b49478af))
* **ui:** one vocabulary for Save, Apply and Refresh (ENG-139) ([6d3ce8b](https://github.com/imevul/evuproxy/commit/6d3ce8b55ded969f86798a8e8d7b37cc69ffb45d))
* **ui:** one vocabulary for Save, Apply and Refresh (ENG-139) ([435dc6e](https://github.com/imevul/evuproxy/commit/435dc6e9b11ce47d6ad4d2181fe70d62a7baf67a))
* **ui:** phone layouts inside the mobile breakpoint (ENG-145) ([94b104e](https://github.com/imevul/evuproxy/commit/94b104ea041e397c93b09d86d7e7b3189ac2025d))
* **ui:** phone layouts inside the mobile breakpoint (ENG-145) ([951d274](https://github.com/imevul/evuproxy/commit/951d274f6653c32fdcfadfb9cdc186dc9ff2b75e))
* **ui:** plain-language pending changes with per-item Revert (ENG-140) ([031a84c](https://github.com/imevul/evuproxy/commit/031a84c717fdcf86d888b7ebf004d42c1afaba69))
* **ui:** plain-language pending changes with per-item Revert (ENG-140) ([70052c1](https://github.com/imevul/evuproxy/commit/70052c148a55d2aea82996af75225cd69a161102))
* **ui:** replace confirmations on draft edits with Undo (ENG-136) ([14fe1ac](https://github.com/imevul/evuproxy/commit/14fe1aca0b13e7af6f06096e9711418e00154eec))
* **ui:** replace confirmations on draft edits with Undo (ENG-136) ([97d7ae3](https://github.com/imevul/evuproxy/commit/97d7ae30587035cedaf5da576907365822593a20))
* **ui:** send a strict Content-Security-Policy (ENG-163) ([2deb126](https://github.com/imevul/evuproxy/commit/2deb1264ca682aaa81e80ece55219cc3c73dfc7c))
* **ui:** sticky headers, sorting, topology at scale and route names (ENG-144) ([ccfbe22](https://github.com/imevul/evuproxy/commit/ccfbe2269baed739bbfe7f93bd57e2638022803a))
* **ui:** sticky headers, sorting, topology at scale and route names (ENG-144) ([e6da4b1](https://github.com/imevul/evuproxy/commit/e6da4b15612ed18043602caadda6550ea8528fdd))
* **ui:** switch pages immediately and show loading states (ENG-138) ([bb40352](https://github.com/imevul/evuproxy/commit/bb4035244d0e163ff85d3f055233c01734c30a09))
* **ui:** switch pages immediately and show loading states (ENG-138) ([200a3b5](https://github.com/imevul/evuproxy/commit/200a3b5493a6b14f5837c187dfef0e54610ca782))
* **ui:** sync Evu Theme press feedback and motion tokens ([47f8e6b](https://github.com/imevul/evuproxy/commit/47f8e6bc8630c1d4b558f9c0d9b78d1c1ebceece))
* **ui:** toast system with feedback for every save (ENG-135) ([6df14eb](https://github.com/imevul/evuproxy/commit/6df14ebd1e17fb29669c91c672424f184d37626a))
* **ui:** unapplied-changes bar and a single Apply with progress (ENG-141) ([2077ed4](https://github.com/imevul/evuproxy/commit/2077ed4335b3c08ef2b432b1c11b5974546ab717))
* **ui:** unapplied-changes bar and a single Apply with progress (ENG-141) ([408add4](https://github.com/imevul/evuproxy/commit/408add42a1bbb97ea2c974e8493ab2bef56a7ba4))


### Bug Fixes

* **api,ui:** detect conflicting config saves with a revision (ENG-132) ([618a906](https://github.com/imevul/evuproxy/commit/618a906e143281d7807500777dea47266a585522))
* **api:** make the mTLS setup survive a reboot (ENG-166) ([f426efd](https://github.com/imevul/evuproxy/commit/f426efd983b578dd75475ace4974451ca064369e))
* **apply:** warn when a change would drop inbound access (ENG-142) ([117f0ad](https://github.com/imevul/evuproxy/commit/117f0ad649173e4a0f0761c4123d2725532dee46))
* **apply:** warn when a change would drop inbound access (ENG-142) ([52b5228](https://github.com/imevul/evuproxy/commit/52b52283a9f71fc175fd9ff299d59a67843c36d4))
* **autopause:** keep paused names current, ignore port order (ENG-158) ([909d8f5](https://github.com/imevul/evuproxy/commit/909d8f5dedc3607cbf5a2bc34fb4ce424b057010))
* **cli:** stop peer-add assigning the server's tunnel address ([7ea83b3](https://github.com/imevul/evuproxy/commit/7ea83b3f69e51d1575d570326d095f3ff577f548))
* **dev:** run mock API as the invoking user (ENG-183) ([c2b4964](https://github.com/imevul/evuproxy/commit/c2b4964ce4740ad5864d2baf519677dc083923f0))
* **dev:** run mock API as the invoking user (ENG-183) ([a7bfd3d](https://github.com/imevul/evuproxy/commit/a7bfd3db15888a307a49e184e1019bd61c9dcd4e))
* drop only what a paused route's DNAT would match (ENG-159) ([0c43e75](https://github.com/imevul/evuproxy/commit/0c43e75a406c4c05187c1473e21662bcffb931f3))
* **e2e:** correct the README example order and report docker errors as 100 (ENG-149) ([0d312b8](https://github.com/imevul/evuproxy/commit/0d312b8896e7cf5ca49db0f931dcec16058806f8))
* forwarding policy traffic tests, and the port map and geo bugs they found (ENG-150) ([6b13578](https://github.com/imevul/evuproxy/commit/6b1357897a03c9ec821a2abffe2756a799bb01eb))
* **gen:** make port maps pass traffic and close geo gaps on input_allows (ENG-150) ([2ee5bf6](https://github.com/imevul/evuproxy/commit/2ee5bf6236f9d6e21d6b26c0a21f023b30538968))
* geo updates load the applied config when confirm is on (ENG-186) ([6b9769e](https://github.com/imevul/evuproxy/commit/6b9769e7bd2ec991f47d3d70a5bef302abff9b5a))
* geo updates load the applied config when confirm is on (ENG-186) ([da5a394](https://github.com/imevul/evuproxy/commit/da5a394334a07f9d4c1f301b3ad94c78711f643f))
* keep failed Apply edits out of boot, and clearer revert states (ENG-146) ([85fde66](https://github.com/imevul/evuproxy/commit/85fde66c103872ffebd621a0df7c07fcfdf0e2f4))
* **logging:** make cleanup safe to call twice (ENG-172) ([527143d](https://github.com/imevul/evuproxy/commit/527143d6af34b1a36ef755203e2f52a549507330))
* **nft:** make rate limits drop the excess and count per source (ENG-151) ([9e7d918](https://github.com/imevul/evuproxy/commit/9e7d91835d8b53289185ca5a1a0d369929d98471))
* **packages:** stop the README enabling nftables.service (ENG-169) ([88c75a4](https://github.com/imevul/evuproxy/commit/88c75a4bb8f58edde2604addce4bd0e631652a71))
* panel note after no answer follows the session (ENG-184) ([eed3915](https://github.com/imevul/evuproxy/commit/eed391534a6fdfba4404cb8ca530614512b6ae98))
* refresh the boot unit from rebuild.sh so the upgrade gets it (ENG-185) ([6208752](https://github.com/imevul/evuproxy/commit/620875283ee00641e87e238c8c98d1d8452e250d))
* **scripts:** stop an upgrade when the new binary rejects the config (ENG-171) ([9b47815](https://github.com/imevul/evuproxy/commit/9b47815711aa7bc5b128687a63e55bb030bb8aa5))
* **scripts:** stop an upgrade when the new binary rejects the config (ENG-171) ([db13d0d](https://github.com/imevul/evuproxy/commit/db13d0d3e3d103f0c90ee23541f28659347018c0))
* **stats:** check ports before showing a route's accepted count (ENG-194) ([f8c9a25](https://github.com/imevul/evuproxy/commit/f8c9a254bcecffbfc8514a1325624ff0c3b38ac0))
* **stats:** check ports before showing a route's accepted count (ENG-194) ([813ef4d](https://github.com/imevul/evuproxy/commit/813ef4da0f1fdbe19cb452d7715db8830c10cb4f))
* **ui:** clear connection-lost state with retry and recovery (ENG-134) ([0252d58](https://github.com/imevul/evuproxy/commit/0252d585f88c2435c74ce191c32d96f05e8d58ab))
* **ui:** clear connection-lost state with retry and recovery (ENG-134) ([012a54c](https://github.com/imevul/evuproxy/commit/012a54ce968efe786eb06ac41edd91ae368afffb))
* **ui:** don't show a route's count on its disabled twin (ENG-155) ([12cdc27](https://github.com/imevul/evuproxy/commit/12cdc27676948d08b811b743ff89df73382fd1bc))
* **ui:** keep edits made during a save, report failed Undo, guard metrics (ENG-137) ([33ab691](https://github.com/imevul/evuproxy/commit/33ab691994a8a97305485ebc63fc719de6ff100b))
* **ui:** keep focus when the last Revert clears pending (ENG-140) ([a190f91](https://github.com/imevul/evuproxy/commit/a190f91b2ce92bb7110588de9b813394180e9245))
* **ui:** keep the removed-route toast ending on its target (ENG-144) ([e1071dc](https://github.com/imevul/evuproxy/commit/e1071dcdf935fac0301eeb5f6910bbd6d0153c9a))
* **ui:** make Undo honest about twin rows and double-clicks (ENG-136) ([060cb69](https://github.com/imevul/evuproxy/commit/060cb694de06b7b8398e1ce43617dd08c817c54e))
* **ui:** map remaining API reload wording to Apply (ENG-139) ([645c173](https://github.com/imevul/evuproxy/commit/645c1738bf96758335b5c9fd420c5f624515e1ec))
* **ui:** phone tap targets and card labels from review (ENG-145) ([3e7d2e0](https://github.com/imevul/evuproxy/commit/3e7d2e0ab9b045a06921b73a4adfb50462e8d1bc))
* **ui:** report failed row switches where the row still is (ENG-135) ([4a23112](https://github.com/imevul/evuproxy/commit/4a2311287a6f12284e6fbef654e63e19b0dd664a))
* **ui:** stop the recovery reload loop and mark old data (ENG-134) ([b02c07e](https://github.com/imevul/evuproxy/commit/b02c07ea2c313672394ff1e524057ee67adca07d))
* **ui:** stop Topology polls moving the large graph (ENG-144) ([6e0a6e1](https://github.com/imevul/evuproxy/commit/6e0a6e1dbdba44935d61556d85f3446b2e0fd6da))
* **ui:** warn before Escape or navigation discards edits (ENG-133) ([9f8cdeb](https://github.com/imevul/evuproxy/commit/9f8cdeb10e9916847dc44df1f08326aa3b59ab35))
* **ui:** warn before Escape or navigation discards edits (ENG-133) ([eb87b62](https://github.com/imevul/evuproxy/commit/eb87b62910f13b599a54a22b1f4021884e2dc103))


### Performance Improvements

* **stats:** read Accepted counts without loading the geo sets (ENG-197) ([490ecdc](https://github.com/imevul/evuproxy/commit/490ecdc666443179b87161490a377534da503481))
* **stats:** read Accepted counts without loading the geo sets (ENG-197) ([90be217](https://github.com/imevul/evuproxy/commit/90be217ef44fe35fd0a0019a1615958c5c5a569a))
* **ui:** draw Routes without waiting for GET /stats (ENG-195) ([c1248d7](https://github.com/imevul/evuproxy/commit/c1248d749d1add09f0c649cdb1f29a354de447f8))
* **ui:** draw Routes without waiting for GET /stats (ENG-195) ([1276e96](https://github.com/imevul/evuproxy/commit/1276e965611990b1c2d72bd654045ef9e2586732))

## [0.17.0](https://github.com/imevul/evuproxy/compare/v0.16.0...v0.17.0) (2026-08-11)


### Features

* diagnostics bundle, endpoint DNS warnings, and peer route UX ([238a7d0](https://github.com/imevul/evuproxy/commit/238a7d0bc192bb40a5e10b925ac28412e6d8dcc5))

## [0.16.0](https://github.com/imevul/evuproxy/compare/v0.15.1...v0.16.0) (2026-08-11)


### Features

* guard WireGuard iface from networkd/netplan address wipe ([10edd8e](https://github.com/imevul/evuproxy/commit/10edd8e6eba83a0c691f3d1144f41601d5c73d5e))

## [0.15.1](https://github.com/imevul/evuproxy/compare/v0.15.0...v0.15.1) (2026-08-09)


### Bug Fixes

* **logs:** read kernel journal and fall back to dmesg when empty ([5846d9c](https://github.com/imevul/evuproxy/commit/5846d9cc8647864cb8d9df52b23f2a2aca4ffc66))

## [0.15.0](https://github.com/imevul/evuproxy/compare/v0.14.0...v0.15.0) (2026-08-08)


### Features

* **ui:** density/a11y pass, apply gate, geo IP check, and logs break-glass ([290b8c1](https://github.com/imevul/evuproxy/commit/290b8c18c1bbb6b7e5352594f1c0b54b462d6e6a))

## [0.14.0](https://github.com/imevul/evuproxy/compare/v0.13.0...v0.14.0) (2026-08-08)


### Features

* **ui:** adopt Evu Theme with light/dark/system ([cc5af78](https://github.com/imevul/evuproxy/commit/cc5af7889cf1f586630d4deecc95b6d68d02cfc2))
* **ui:** sync Evu Theme elevated buttons and form contrast ([c917056](https://github.com/imevul/evuproxy/commit/c917056440013771a443bd4b410b27d6a9a0ce51))


### Bug Fixes

* **crowdsec:** move Docker LAPI off host :8080 to :8082 ([c48e853](https://github.com/imevul/evuproxy/commit/c48e853aed1996a7b64ed0c42bb5b502f94e5ca5))
* **ui:** confirm Routes/Inbound removes and re-resolve the row ([aa1dcb4](https://github.com/imevul/evuproxy/commit/aa1dcb4313d2005be1f7af5042d4124790db6344))

## [0.13.0](https://github.com/imevul/evuproxy/compare/v0.12.0...v0.13.0) (2026-07-03)


### Features

* harden apply/reload path and complete review remediation ([f07b6d2](https://github.com/imevul/evuproxy/commit/f07b6d27e53a949f6f6fec95fcddc2be87b8cda4))

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

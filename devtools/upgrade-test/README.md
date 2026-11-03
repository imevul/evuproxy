# Testing the binary-only upgrade

Runs [`scripts/upgrade-binary.sh`](../../scripts/upgrade-binary.sh) in a throwaway `debian:12` container that boots systemd, with the real units, `evuproxy.service` loading real nftables and WireGuard, and real `curl` over HTTPS.

From the repo root, on Linux with Docker and Go 1.25+:

```bash
make upgrade-test
```

It takes about a minute, and runs on every pull request and push to `main` (`.github/workflows/upgrade-test.yml`). It exits 0 if every check passed, 1 if any failed, and 100 if it could not run.

## What is real and what isn't

GitHub is replaced by [`server`](server/main.go), which serves releases in the same layout from inside the container with a certificate it generates, trusted through `CURL_CA_BUNDLE`. The release binaries are real builds with versions `0.0.1` to `0.0.3`, plus small shell scripts for releases that are meant to be refused. So this doesn't show that the GitHub URLs work; run the script by hand against a real release for that.

## What it checks

- **A failure leaves the install untouched:** a 404 on the binary or on `SHA256SUMS`, a download cut off halfway, no server, an untrusted certificate, a plain `http` URL, a wrong checksum, a missing entry, a binary that reports another version or doesn't run. Each compares the binary, the kept binary, `config.yaml`, the contents of the install directory and each service's invocation before and after.
- **Refusals before the swap:** an open confirm window, a release that rejects `config.yaml`, and a release without `--boot` under a unit that uses it.
- **Upgrade:** latest and `--version`, the old binary kept, active services restarted onto the new binary, an inactive service left inactive, the firewall still loaded and `config.yaml` unchanged.
- **Rollback:** both directions, and with nothing to go back to.
- **Awkward hosts:** a service that fails to restart, a unit without `--boot`, another `PREFIX`, and no `systemctl`.

## What it leaves behind

The container and everything in it go away with `--rm`, along with the temporary binaries. What stays on the machine is the `debian:12` image, and any kernel modules the test caused to load, such as `wireguard` and `nf_tables`. The container is privileged because systemd as PID 1 needs a writable cgroup tree. It keeps its own network namespace, so the rules it loads don't reach the host, and it publishes no ports.

# Confirm-or-revert on a real kernel

Tests the revert timer in a throwaway Debian VM with real `nft`, `wg` and `systemd-run`. It applies a config that cuts the forwarded SSH port, stops the API, and checks that SSH comes back by itself. It also covers confirming, applying again during the window, an API restart, a failed revert, a reboot, a failed Apply whose revert also fails, a revert killed partway, and what a reboot does with edits that were never confirmed. The Go tests only cover these with a fake command runner.

The VM runs under QEMU with KVM inside a container, on user-mode networking. Nothing is installed on the host, and its network and firewall aren't touched: QEMU forwards SSH and the API on the container's own loopback, and no port is published. The script runs from outside the VM, in the container.

From the repo root, on a Linux host with `/dev/kvm`:

```bash
CGO_ENABLED=0 go build -o devtools/rollback-vm/evuproxy ./cmd/evuproxy
docker run --rm --device /dev/kvm \
  -v "$PWD/devtools/rollback-vm:/rollback-vm:ro" -v "$PWD/templates:/templates:ro" \
  alpine:latest sh -c "apk add --no-cache -q bash && exec bash /rollback-vm/run.sh"
```

It takes about eight minutes and needs roughly 1 GiB of disk and 1 GiB of RAM. Everything except the `alpine` image and the binary lives in the container's writable layer, so `--rm` removes it. It exits with the number of failed checks, or `100` if setup failed.

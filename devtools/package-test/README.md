# Package tests

`make package-test` builds the `.deb` and RPM from this tree and takes them through install, upgrade and removal on Debian 12, Ubuntu 24.04, AlmaLinux 9 and Fedora 42. Each distro gets a throwaway container that boots systemd, so units really start, stop and restart. Needs Docker, Go and the host's `wireguard` kernel module (`sudo modprobe wireguard`).

`devtools/package-test/run.sh debian:12` runs one image.

| Stage | What it checks |
| ----- | -------------- |
| Fresh install | Dependencies come in with the package, nothing asks a question, and the config, keys and tokens are created. No unit is enabled or started, there are no rules, and forwarding stays off. |
| Upgrade | Over a changed config, a running API and rules that are already loaded: the config, secrets and rules don't change, `evuproxy.service` isn't restarted, enabled units stay enabled, and the API restarts. |
| Remove | The units, binary and drop-ins go. The config, secrets and rules stay. |
| Reinstall, purge | A reinstall keeps the config, and a dpkg purge deletes `/etc/evuproxy`. |
| Existing config | A `config.yaml` that was there before the first install is kept. |
| README steps | `evuproxy reload`, the units and the API work on real nftables and WireGuard. |
| Boot | Starting the boot target applies the rules through `evuproxy.service`, with `nftables.service` off. |
| Default removal | A plain `dnf remove`, or `apt remove` and `apt autoremove`, takes `nftables` along and leaves the rules and tunnel up. |
| `nftables.service` running | Removal that keeps `nftables` leaves the rules. Removal that takes it along flushes them on RPM distros and leaves them on Debian and Ubuntu, as the README says. Disabling the service leaves them, and stopping it flushes them. |

The containers are privileged because systemd needs a writable cgroup tree, but each keeps its own network namespace, so rules and forwarding changes stay inside it. A container exits by itself when its checks finish, and `run.sh` kills it at the deadline if they don't. Unlike [`make e2e`](../e2e/README.md), this doesn't test traffic.

Containers don't cover everything a host has: SELinux stays in the host's hands, and a real boot doesn't happen, so the boot stage clears the rules and tunnel and starts `multi-user.target` again.

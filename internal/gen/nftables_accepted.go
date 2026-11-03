package gen

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// RouteAcceptedChain is the count-only chain behind GET /stats route_accepted and the
// evuproxy_route_accepted_* Prometheus metrics.
const RouteAcceptedChain = "route_accepted"

// RouteAcceptedTable holds only RouteAcceptedChain. The chain has a table of its own because nft
// 1.0.6 reads every element of a table's sets to list one of its chains, which costs 800 ms and
// 196 MiB with a 150,000 element geo set. Listing this table costs the same at any size.
const RouteAcceptedTable = "evuproxy_accepted"

const routeAcceptedCommentPrefix = "evuproxy-accepted"

var routeAcceptedCommentRE = regexp.MustCompile(`comment "` + routeAcceptedCommentPrefix + ` route=(\d+) proto=(tcp|udp)"`)

// routeAcceptedComment names the route a counter belongs to, so readers don't have to work it
// out from the rule's match.
func routeAcceptedComment(routeIndex int, proto string) string {
	return fmt.Sprintf("%s route=%d proto=%s", routeAcceptedCommentPrefix, routeIndex, proto)
}

// ParseRouteAcceptedComment returns the route index and protocol of a rule line from
// RouteAcceptedChain. ok is false for any other line.
func ParseRouteAcceptedComment(line string) (routeIndex int, proto string, ok bool) {
	m := routeAcceptedCommentRE.FindStringSubmatch(line)
	if m == nil {
		return 0, "", false
	}
	routeIndex, err := strconv.Atoi(m[1])
	if err != nil {
		return 0, "", false
	}
	return routeIndex, m[2], true
}

// writeRouteAcceptedTable emits one counter per route and protocol, in a chain that runs after the
// forward chain. Priority orders base chains across tables too, so being in another table changes
// nothing here: packets the forward chain drops never get here, whatever rule drops them. Packets
// it accepts do, including the established ones its route accept rules don't see.
//
// Every rule requires the public port as well, because a port map can send two routes to the
// same target and internal port, and a packet would otherwise count on both.
//
// The table is replaced even with no routes, so an Apply that leaves none doesn't keep old rules.
func writeRouteAcceptedTable(b *strings.Builder, pub, wg string, routes []routePolicy) {
	fmt.Fprintf(b, "\nadd table inet %s\ndelete table inet %s\n", RouteAcceptedTable, RouteAcceptedTable)
	if len(routes) == 0 {
		return
	}
	fmt.Fprintf(b, "table inet %s {\n    chain %s {\n        type filter hook forward priority 10; policy accept;\n\n", RouteAcceptedTable, RouteAcceptedChain)
	for _, r := range routes {
		ports := r.forwardPorts
		if ports == r.portExpr {
			ports += " ct original proto-dst " + r.portExpr
		}
		fmt.Fprintf(b, "        iifname %q oifname %q ip daddr %s %s dport %s counter comment %q\n",
			pub, wg, r.target, r.proto, ports, routeAcceptedComment(r.routeIndex, r.proto))
	}
	fmt.Fprintf(b, "    }\n}\n")
}

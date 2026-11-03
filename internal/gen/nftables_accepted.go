package gen

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// RouteAcceptedChain is the count-only chain behind GET /stats route_accepted.
const RouteAcceptedChain = "route_accepted"

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

// writeRouteAcceptedChain emits one counter per route and protocol, in a chain of its own that
// runs after the forward chain. Packets the forward chain drops never get here, whatever rule
// drops them. Packets it accepts do, including the established ones its route accept rules
// don't see.
//
// Every rule requires the public port as well, because a port map can send two routes to the
// same target and internal port, and a packet would otherwise count on both.
func writeRouteAcceptedChain(b *strings.Builder, pub, wg string, routes []routePolicy) {
	if len(routes) == 0 {
		return
	}
	fmt.Fprintf(b, "\n    chain %s {\n        type filter hook forward priority 10; policy accept;\n\n", RouteAcceptedChain)
	for _, r := range routes {
		ports := r.forwardPorts
		if ports == r.portExpr {
			ports += " ct original proto-dst " + r.portExpr
		}
		fmt.Fprintf(b, "        iifname %q oifname %q ip daddr %s %s dport %s counter comment %q\n",
			pub, wg, r.target, r.proto, ports, routeAcceptedComment(r.routeIndex, r.proto))
	}
	fmt.Fprintf(b, "    }\n")
}

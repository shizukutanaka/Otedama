package dex

import (
	"fmt"
	"math/big"
	"sort"
	"sync"
)

// SwapRouter finds optimal swap routes
type SwapRouter struct {
	dex        *DEX
	routeCache map[string]*RouteCache
	mu         sync.RWMutex
}

// RouteCache caches computed routes
type RouteCache struct {
	Route     *SwapRoute
	Timestamp int64
	TTL       int64
}

// NewSwapRouter creates a new swap router
func NewSwapRouter(dex *DEX) *SwapRouter {
	return &SwapRouter{
		dex:        dex,
		routeCache: make(map[string]*RouteCache),
	}
}

// FindBestRoute finds the best swap route
func (r *SwapRouter) FindBestRoute(params SwapParams) (*SwapRoute, error) {
	// Check cache first
	cacheKey := r.getCacheKey(params)
	if cached := r.getFromCache(cacheKey); cached != nil {
		return cached, nil
	}
	
	// Find all possible routes
	routes, err := r.findAllRoutes(params)
	if err != nil {
		return nil, err
	}
	
	if len(routes) == 0 {
		return nil, fmt.Errorf("no route found from %s to %s", params.TokenIn, params.TokenOut)
	}
	
	// Select best route based on output amount
	bestRoute := r.selectBestRoute(routes, params)
	
	// Cache the result
	r.cacheRoute(cacheKey, bestRoute)
	
	return bestRoute, nil
}

// FindAllRoutes finds all possible swap routes
func (r *SwapRouter) findAllRoutes(params SwapParams) ([]*SwapRoute, error) {
	r.dex.mu.RLock()
	defer r.dex.mu.RUnlock()
	
	routes := make([]*SwapRoute, 0)
	
	// Direct route
	directRoute := r.findDirectRoute(params)
	if directRoute != nil {
		routes = append(routes, directRoute)
	}
	
	// Multi-hop routes (up to 3 hops)
	multiHopRoutes := r.findMultiHopRoutes(params, 3)
	routes = append(routes, multiHopRoutes...)
	
	// Split routes (split amount across multiple paths)
	splitRoutes := r.findSplitRoutes(params)
	routes = append(routes, splitRoutes...)
	
	return routes, nil
}

// findDirectRoute finds a direct swap route
func (r *SwapRouter) findDirectRoute(params SwapParams) *SwapRoute {
	pairID := generatePairID(params.TokenIn, params.TokenOut)
	pool, exists := r.dex.pairs[pairID]
	if !exists {
		return nil
	}
	
	// Calculate output
	amountOut, err := pool.GetAmountOut(params.TokenIn, params.AmountIn)
	if err != nil {
		return nil
	}
	
	// Calculate price impact
	priceImpact, err := pool.GetPriceImpact(params.TokenIn, params.AmountIn)
	if err != nil {
		return nil
	}
	
	// Calculate fees
	fees := calculateFee(params.AmountIn, pool.TradingFee+pool.ProtocolFee)
	
	return &SwapRoute{
		Path:         []string{params.TokenIn, params.TokenOut},
		Pools:        []string{pairID},
		EstimatedOut: amountOut,
		PriceImpact:  priceImpact,
		Fees:         fees,
	}
}

// findMultiHopRoutes finds multi-hop swap routes
func (r *SwapRouter) findMultiHopRoutes(params SwapParams, maxHops int) []*SwapRoute {
	routes := make([]*SwapRoute, 0)
	
	// Build graph of available pairs
	graph := r.buildTokenGraph()
	
	// Find paths using BFS
	paths := r.findPaths(graph, params.TokenIn, params.TokenOut, maxHops)
	
	// Calculate route for each path
	for _, path := range paths {
		route := r.calculateRouteForPath(path, params.AmountIn)
		if route != nil && route.EstimatedOut.Sign() > 0 {
			routes = append(routes, route)
		}
	}
	
	return routes
}

// findSplitRoutes finds routes that split the swap across multiple paths
func (r *SwapRouter) findSplitRoutes(params SwapParams) []*SwapRoute {
	routes := make([]*SwapRoute, 0)
	
	// Find top 2 routes
	allRoutes := r.findMultiHopRoutes(params, 3)
	if len(allRoutes) < 2 {
		return routes
	}
	
	// Sort by output amount
	sort.Slice(allRoutes, func(i, j int) bool {
		return allRoutes[i].EstimatedOut.Cmp(allRoutes[j].EstimatedOut) > 0
	})
	
	// Try splitting 50/50 between top 2 routes
	halfAmount := new(big.Int).Div(params.AmountIn, big.NewInt(2))
	
	// Recalculate for half amounts
	route1 := r.calculateRouteForPath(allRoutes[0].Path, halfAmount)
	route2 := r.calculateRouteForPath(allRoutes[1].Path, halfAmount)
	
	if route1 != nil && route2 != nil {
		// Combine results
		totalOut := new(big.Int).Add(route1.EstimatedOut, route2.EstimatedOut)
		totalFees := new(big.Int).Add(route1.Fees, route2.Fees)
		avgImpact := (route1.PriceImpact + route2.PriceImpact) / 2
		
		splitRoute := &SwapRoute{
			Path:         append(route1.Path, route2.Path...),
			Pools:        append(route1.Pools, route2.Pools...),
			EstimatedOut: totalOut,
			PriceImpact:  avgImpact,
			Fees:         totalFees,
		}
		
		routes = append(routes, splitRoute)
	}
	
	return routes
}

// buildTokenGraph builds a graph of token connections
func (r *SwapRouter) buildTokenGraph() map[string][]string {
	graph := make(map[string][]string)
	
	for _, pool := range r.dex.pairs {
		// Add bidirectional edges
		graph[pool.TokenA] = append(graph[pool.TokenA], pool.TokenB)
		graph[pool.TokenB] = append(graph[pool.TokenB], pool.TokenA)
	}
	
	// Remove duplicates
	for token, connections := range graph {
		graph[token] = uniqueStrings(connections)
	}
	
	return graph
}

// findPaths finds all paths between two tokens
func (r *SwapRouter) findPaths(graph map[string][]string, start, end string, maxLength int) [][]string {
	paths := make([][]string, 0)
	
	// BFS queue
	type pathState struct {
		path    []string
		visited map[string]bool
	}
	
	queue := []pathState{{
		path:    []string{start},
		visited: map[string]bool{start: true},
	}}
	
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		
		lastToken := current.path[len(current.path)-1]
		
		// Check if we reached the destination
		if lastToken == end {
			paths = append(paths, current.path)
			continue
		}
		
		// Check max path length
		if len(current.path) >= maxLength {
			continue
		}
		
		// Explore neighbors
		for _, neighbor := range graph[lastToken] {
			if !current.visited[neighbor] {
				newPath := make([]string, len(current.path)+1)
				copy(newPath, current.path)
				newPath[len(current.path)] = neighbor
				
				newVisited := make(map[string]bool)
				for k, v := range current.visited {
					newVisited[k] = v
				}
				newVisited[neighbor] = true
				
				queue = append(queue, pathState{
					path:    newPath,
					visited: newVisited,
				})
			}
		}
	}
	
	return paths
}

// calculateRouteForPath calculates route details for a given path
func (r *SwapRouter) calculateRouteForPath(path []string, amountIn *big.Int) *SwapRoute {
	if len(path) < 2 {
		return nil
	}
	
	currentAmount := new(big.Int).Set(amountIn)
	totalFees := big.NewInt(0)
	totalImpact := 0.0
	pools := make([]string, 0)
	
	for i := 0; i < len(path)-1; i++ {
		tokenIn := path[i]
		tokenOut := path[i+1]
		pairID := generatePairID(tokenIn, tokenOut)
		
		pool, exists := r.dex.pairs[pairID]
		if !exists {
			return nil
		}
		
		// Calculate output for this hop
		amountOut, err := pool.GetAmountOut(tokenIn, currentAmount)
		if err != nil {
			return nil
		}
		
		// Calculate fees for this hop
		fees := calculateFee(currentAmount, pool.TradingFee+pool.ProtocolFee)
		totalFees.Add(totalFees, fees)
		
		// Calculate price impact for this hop
		impact, err := pool.GetPriceImpact(tokenIn, currentAmount)
		if err != nil {
			return nil
		}
		totalImpact += impact
		
		pools = append(pools, pairID)
		currentAmount = amountOut
	}
	
	return &SwapRoute{
		Path:         path,
		Pools:        pools,
		EstimatedOut: currentAmount,
		PriceImpact:  totalImpact,
		Fees:         totalFees,
	}
}

// selectBestRoute selects the best route based on criteria
func (r *SwapRouter) selectBestRoute(routes []*SwapRoute, params SwapParams) *SwapRoute {
	if len(routes) == 0 {
		return nil
	}
	
	// Sort by output amount (descending)
	sort.Slice(routes, func(i, j int) bool {
		return routes[i].EstimatedOut.Cmp(routes[j].EstimatedOut) > 0
	})
	
	// Filter by max slippage
	for _, route := range routes {
		if route.PriceImpact <= params.Slippage {
			return route
		}
	}
	
	// If no route meets slippage requirement, return best output
	return routes[0]
}

// getCacheKey generates a cache key for route
func (r *SwapRouter) getCacheKey(params SwapParams) string {
	return fmt.Sprintf("%s-%s-%s", params.TokenIn, params.TokenOut, params.AmountIn.String())
}

// getFromCache retrieves route from cache
func (r *SwapRouter) getFromCache(key string) *SwapRoute {
	r.mu.RLock()
	defer r.mu.RUnlock()
	
	cached, exists := r.routeCache[key]
	if !exists {
		return nil
	}
	
	// Check TTL (5 seconds)
	if timeNow()-cached.Timestamp > cached.TTL {
		return nil
	}
	
	return cached.Route
}

// cacheRoute stores route in cache
func (r *SwapRouter) cacheRoute(key string, route *SwapRoute) {
	r.mu.Lock()
	defer r.mu.Unlock()
	
	r.routeCache[key] = &RouteCache{
		Route:     route,
		Timestamp: timeNow(),
		TTL:       5, // 5 seconds TTL
	}
	
	// Clean old cache entries
	r.cleanCache()
}

// cleanCache removes expired cache entries
func (r *SwapRouter) cleanCache() {
	now := timeNow()
	for key, cached := range r.routeCache {
		if now-cached.Timestamp > cached.TTL {
			delete(r.routeCache, key)
		}
	}
}

// OptimizeRoute optimizes a given route
func (r *SwapRouter) OptimizeRoute(route *SwapRoute, params SwapParams) (*SwapRoute, error) {
	// Try different split ratios
	splitRatios := []float64{0.3, 0.4, 0.5, 0.6, 0.7}
	bestRoute := route
	
	for _, ratio := range splitRatios {
		// Calculate split amounts
		amount1 := new(big.Int).Mul(params.AmountIn, big.NewInt(int64(ratio*100)))
		amount1.Div(amount1, big.NewInt(100))
		amount2 := new(big.Int).Sub(params.AmountIn, amount1)
		
		// Calculate routes for split amounts
		route1 := r.calculateRouteForPath(route.Path, amount1)
		route2 := r.calculateRouteForPath(route.Path, amount2)
		
		if route1 != nil && route2 != nil {
			totalOut := new(big.Int).Add(route1.EstimatedOut, route2.EstimatedOut)
			
			if totalOut.Cmp(bestRoute.EstimatedOut) > 0 {
				bestRoute = &SwapRoute{
					Path:         route.Path,
					Pools:        route.Pools,
					EstimatedOut: totalOut,
					PriceImpact:  (route1.PriceImpact + route2.PriceImpact) / 2,
					Fees:         new(big.Int).Add(route1.Fees, route2.Fees),
				}
			}
		}
	}
	
	return bestRoute, nil
}

// Helper functions

func uniqueStrings(strings []string) []string {
	seen := make(map[string]bool)
	unique := make([]string, 0)
	
	for _, s := range strings {
		if !seen[s] {
			seen[s] = true
			unique = append(unique, s)
		}
	}
	
	return unique
}

func timeNow() int64 {
	return time.Now().Unix()
}
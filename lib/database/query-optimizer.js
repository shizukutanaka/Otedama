const { EventEmitter } = require('events');

class QueryOptimizer extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            analyzeThreshold: options.analyzeThreshold || 100,
            cacheSize: options.cacheSize || 1000,
            indexSuggestionThreshold: options.indexSuggestionThreshold || 0.7,
            slowQueryThreshold: options.slowQueryThreshold || 1000,
            ...options
        };
        
        this.queryCache = new Map();
        this.queryStats = new Map();
        this.executionPlans = new Map();
        this.indexSuggestions = new Map();
        this.rewriteRules = new Map();
        
        this.initializeRewriteRules();
    }

    initializeRewriteRules() {
        // Common query optimization patterns
        this.rewriteRules.set('select_star', {
            pattern: /SELECT\s+\*\s+FROM/i,
            rewrite: (query, context) => {
                if (context.fields) {
                    return query.replace(/SELECT\s+\*/, `SELECT ${context.fields.join(', ')}`);
                }
                return query;
            }
        });
        
        this.rewriteRules.set('in_to_exists', {
            pattern: /WHERE\s+(\w+)\s+IN\s*\(/i,
            condition: (query) => {
                const match = query.match(/IN\s*\(([^)]+)\)/i);
                return match && match[1].includes('SELECT');
            },
            rewrite: (query) => {
                return query.replace(/WHERE\s+(\w+)\s+IN\s*\(([^)]+)\)/i, 
                    'WHERE EXISTS ($2 AND $1 = subquery_column)');
            }
        });
        
        this.rewriteRules.set('or_to_union', {
            pattern: /WHERE.*OR/i,
            condition: (query) => {
                const orCount = (query.match(/\bOR\b/gi) || []).length;
                return orCount > 2;
            },
            rewrite: (query) => {
                // Convert multiple ORs to UNION for better index usage
                const conditions = query.split(/\bOR\b/i);
                const baseQuery = query.substring(0, query.indexOf('WHERE'));
                
                return conditions.map(cond => 
                    `${baseQuery} WHERE ${cond.trim()}`
                ).join(' UNION ');
            }
        });
    }

    async optimize(query, context = {}) {
        const startTime = Date.now();
        
        // Check cache first
        const cacheKey = this.getCacheKey(query, context);
        const cached = this.queryCache.get(cacheKey);
        
        if (cached && cached.expires > Date.now()) {
            this.updateStats(query, { cached: true, duration: Date.now() - startTime });
            return cached.result;
        }
        
        try {
            // Parse query
            const parsed = this.parseQuery(query);
            
            // Apply rewrite rules
            let optimized = this.applyRewriteRules(query, parsed, context);
            
            // Analyze execution plan
            const plan = await this.analyzeExecutionPlan(optimized, parsed);
            
            // Suggest indexes if needed
            const indexSuggestions = this.suggestIndexes(plan, parsed);
            
            // Further optimize based on statistics
            optimized = this.statisticalOptimization(optimized, parsed);
            
            const result = {
                original: query,
                optimized,
                plan,
                indexSuggestions,
                estimatedCost: plan.cost,
                cacheable: this.isCacheable(parsed)
            };
            
            // Cache result
            if (result.cacheable) {
                this.queryCache.set(cacheKey, {
                    result,
                    expires: Date.now() + 3600000 // 1 hour
                });
                
                this.maintainCacheSize();
            }
            
            const duration = Date.now() - startTime;
            this.updateStats(query, { cached: false, duration, optimized: true });
            
            if (duration > this.config.slowQueryThreshold) {
                this.emit('slow-query', { query, duration, plan });
            }
            
            return result;
            
        } catch (error) {
            this.emit('error', { query, error });
            return { original: query, optimized: query, error: error.message };
        }
    }

    parseQuery(query) {
        const parsed = {
            type: null,
            tables: [],
            fields: [],
            conditions: [],
            joins: [],
            orderBy: [],
            groupBy: [],
            limit: null
        };
        
        // Determine query type
        if (query.match(/^\s*SELECT/i)) parsed.type = 'SELECT';
        else if (query.match(/^\s*INSERT/i)) parsed.type = 'INSERT';
        else if (query.match(/^\s*UPDATE/i)) parsed.type = 'UPDATE';
        else if (query.match(/^\s*DELETE/i)) parsed.type = 'DELETE';
        
        // Extract tables
        const tableMatches = query.match(/FROM\s+(\w+)(\s+AS\s+\w+)?/gi);
        if (tableMatches) {
            parsed.tables = tableMatches.map(match => {
                const parts = match.split(/\s+/);
                return parts[1];
            });
        }
        
        // Extract fields (for SELECT)
        if (parsed.type === 'SELECT') {
            const fieldsMatch = query.match(/SELECT\s+(.+?)\s+FROM/i);
            if (fieldsMatch) {
                parsed.fields = fieldsMatch[1].split(',').map(f => f.trim());
            }
        }
        
        // Extract WHERE conditions
        const whereMatch = query.match(/WHERE\s+(.+?)(\s+ORDER\s+BY|\s+GROUP\s+BY|\s+LIMIT|$)/i);
        if (whereMatch) {
            parsed.conditions = this.parseConditions(whereMatch[1]);
        }
        
        // Extract JOINs
        const joinMatches = query.match(/(INNER|LEFT|RIGHT|FULL)\s+JOIN\s+\w+\s+ON\s+[^)]+/gi);
        if (joinMatches) {
            parsed.joins = joinMatches.map(join => this.parseJoin(join));
        }
        
        // Extract ORDER BY
        const orderMatch = query.match(/ORDER\s+BY\s+(.+?)(\s+LIMIT|$)/i);
        if (orderMatch) {
            parsed.orderBy = orderMatch[1].split(',').map(o => o.trim());
        }
        
        // Extract LIMIT
        const limitMatch = query.match(/LIMIT\s+(\d+)(\s+OFFSET\s+(\d+))?/i);
        if (limitMatch) {
            parsed.limit = {
                limit: parseInt(limitMatch[1]),
                offset: limitMatch[3] ? parseInt(limitMatch[3]) : 0
            };
        }
        
        return parsed;
    }

    parseConditions(whereClause) {
        const conditions = [];
        
        // Split by AND/OR
        const parts = whereClause.split(/\s+(AND|OR)\s+/i);
        
        for (let i = 0; i < parts.length; i += 2) {
            const condition = parts[i].trim();
            const operator = parts[i + 1];
            
            // Parse individual condition
            const condMatch = condition.match(/(\w+)\s*([=<>!]+|LIKE|IN|BETWEEN)\s*(.+)/i);
            if (condMatch) {
                conditions.push({
                    field: condMatch[1],
                    operator: condMatch[2],
                    value: condMatch[3],
                    logical: operator || 'AND'
                });
            }
        }
        
        return conditions;
    }

    parseJoin(joinClause) {
        const match = joinClause.match(/(INNER|LEFT|RIGHT|FULL)\s+JOIN\s+(\w+)\s+ON\s+(.+)/i);
        if (!match) return null;
        
        return {
            type: match[1],
            table: match[2],
            condition: match[3]
        };
    }

    applyRewriteRules(query, parsed, context) {
        let optimized = query;
        
        for (const [name, rule] of this.rewriteRules) {
            if (rule.pattern.test(optimized)) {
                if (!rule.condition || rule.condition(optimized, parsed)) {
                    const rewritten = rule.rewrite(optimized, context);
                    
                    if (rewritten !== optimized) {
                        this.emit('rewrite', { 
                            rule: name, 
                            before: optimized, 
                            after: rewritten 
                        });
                        
                        optimized = rewritten;
                    }
                }
            }
        }
        
        return optimized;
    }

    async analyzeExecutionPlan(query, parsed) {
        // Simulate execution plan analysis
        const plan = {
            type: 'QUERY PLAN',
            operations: [],
            cost: 0,
            rows: 0,
            width: 0
        };
        
        // Analyze table scans
        for (const table of parsed.tables) {
            const tableStat = this.getTableStatistics(table);
            const operation = {
                type: 'Seq Scan',
                table,
                cost: tableStat.rows * 0.01,
                rows: tableStat.rows
            };
            
            // Check if index scan is possible
            for (const condition of parsed.conditions) {
                if (tableStat.indexes[condition.field]) {
                    operation.type = 'Index Scan';
                    operation.index = condition.field;
                    operation.cost = Math.log2(tableStat.rows) * 0.1;
                    operation.rows = tableStat.rows * 0.1; // Assume 10% selectivity
                }
            }
            
            plan.operations.push(operation);
            plan.cost += operation.cost;
            plan.rows = Math.max(plan.rows, operation.rows);
        }
        
        // Analyze joins
        for (const join of parsed.joins) {
            const joinCost = this.estimateJoinCost(join, plan.rows);
            plan.operations.push({
                type: `${join.type} Join`,
                cost: joinCost,
                condition: join.condition
            });
            plan.cost += joinCost;
        }
        
        // Analyze sorting
        if (parsed.orderBy.length > 0) {
            const sortCost = plan.rows * Math.log2(plan.rows) * 0.01;
            plan.operations.push({
                type: 'Sort',
                keys: parsed.orderBy,
                cost: sortCost
            });
            plan.cost += sortCost;
        }
        
        this.executionPlans.set(query, plan);
        
        return plan;
    }

    getTableStatistics(table) {
        // Simulated table statistics
        const stats = {
            rows: 10000,
            pages: 100,
            indexes: {},
            cardinality: {}
        };
        
        // Common indexed fields
        const commonIndexes = ['id', 'user_id', 'created_at', 'status'];
        commonIndexes.forEach(field => {
            stats.indexes[field] = {
                type: 'btree',
                unique: field === 'id',
                size: stats.rows * 0.1
            };
        });
        
        return stats;
    }

    estimateJoinCost(join, leftRows) {
        const rightStats = this.getTableStatistics(join.table);
        
        switch (join.type.toUpperCase()) {
            case 'INNER':
                return leftRows * rightStats.rows * 0.001;
            case 'LEFT':
            case 'RIGHT':
                return leftRows * rightStats.rows * 0.0015;
            case 'FULL':
                return leftRows * rightStats.rows * 0.002;
            default:
                return leftRows * rightStats.rows * 0.001;
        }
    }

    suggestIndexes(plan, parsed) {
        const suggestions = [];
        
        // Check for sequential scans with WHERE conditions
        for (const operation of plan.operations) {
            if (operation.type === 'Seq Scan') {
                const conditions = parsed.conditions.filter(c => 
                    this.isIndexableCondition(c)
                );
                
                for (const condition of conditions) {
                    const benefit = this.calculateIndexBenefit(operation, condition);
                    
                    if (benefit > this.config.indexSuggestionThreshold) {
                        suggestions.push({
                            table: operation.table,
                            column: condition.field,
                            type: 'btree',
                            benefit,
                            estimatedImprovement: `${(benefit * 100).toFixed(1)}%`
                        });
                    }
                }
            }
        }
        
        // Check for sort operations
        const sortOps = plan.operations.filter(op => op.type === 'Sort');
        for (const sortOp of sortOps) {
            suggestions.push({
                type: 'compound',
                columns: sortOp.keys,
                benefit: 0.8,
                reason: 'Eliminate sort operation'
            });
        }
        
        // Store suggestions
        if (suggestions.length > 0) {
            const key = `${parsed.tables.join(',')}_${Date.now()}`;
            this.indexSuggestions.set(key, suggestions);
        }
        
        return suggestions;
    }

    isIndexableCondition(condition) {
        const indexableOperators = ['=', '<', '>', '<=', '>=', 'BETWEEN'];
        return indexableOperators.includes(condition.operator.toUpperCase());
    }

    calculateIndexBenefit(operation, condition) {
        const currentCost = operation.cost;
        const estimatedIndexCost = Math.log2(operation.rows) * 0.1;
        
        return (currentCost - estimatedIndexCost) / currentCost;
    }

    statisticalOptimization(query, parsed) {
        // Reorder joins based on statistics
        if (parsed.joins.length > 1) {
            const reorderedJoins = this.optimizeJoinOrder(parsed.joins);
            if (reorderedJoins !== parsed.joins) {
                query = this.rewriteJoinOrder(query, parsed.joins, reorderedJoins);
            }
        }
        
        // Push down predicates
        query = this.pushDownPredicates(query, parsed);
        
        // Eliminate redundant operations
        query = this.eliminateRedundancy(query, parsed);
        
        return query;
    }

    optimizeJoinOrder(joins) {
        // Use dynamic programming to find optimal join order
        const n = joins.length;
        const dp = new Array(1 << n).fill(Infinity);
        const parent = new Array(1 << n).fill(-1);
        
        dp[0] = 0;
        
        for (let mask = 0; mask < (1 << n); mask++) {
            for (let i = 0; i < n; i++) {
                if (!(mask & (1 << i))) {
                    const newMask = mask | (1 << i);
                    const cost = dp[mask] + this.estimateJoinCost(joins[i], 1000);
                    
                    if (cost < dp[newMask]) {
                        dp[newMask] = cost;
                        parent[newMask] = i;
                    }
                }
            }
        }
        
        // Reconstruct optimal order
        const optimalOrder = [];
        let mask = (1 << n) - 1;
        
        while (mask > 0) {
            const lastJoin = parent[mask];
            optimalOrder.unshift(joins[lastJoin]);
            mask ^= (1 << lastJoin);
        }
        
        return optimalOrder;
    }

    pushDownPredicates(query, parsed) {
        // Move WHERE conditions closer to table scans
        // This is a simplified implementation
        return query;
    }

    eliminateRedundancy(query, parsed) {
        // Remove redundant DISTINCT if unique constraint exists
        if (query.includes('DISTINCT') && parsed.fields.includes('id')) {
            query = query.replace(/\bDISTINCT\b/i, '');
        }
        
        return query;
    }

    isCacheable(parsed) {
        // Don't cache queries with non-deterministic functions
        const nonDeterministic = ['NOW()', 'RAND()', 'UUID()'];
        const queryStr = JSON.stringify(parsed);
        
        return !nonDeterministic.some(func => queryStr.includes(func));
    }

    getCacheKey(query, context) {
        const normalized = query.toLowerCase().replace(/\s+/g, ' ').trim();
        const contextStr = JSON.stringify(context);
        
        return `${normalized}_${contextStr}`;
    }

    maintainCacheSize() {
        if (this.queryCache.size > this.config.cacheSize) {
            // Remove oldest entries
            const entries = Array.from(this.queryCache.entries());
            entries.sort((a, b) => a[1].expires - b[1].expires);
            
            const toRemove = entries.slice(0, this.queryCache.size - this.config.cacheSize);
            toRemove.forEach(([key]) => this.queryCache.delete(key));
        }
    }

    updateStats(query, stats) {
        const key = this.getCacheKey(query, {});
        
        if (!this.queryStats.has(key)) {
            this.queryStats.set(key, {
                count: 0,
                totalDuration: 0,
                avgDuration: 0,
                cached: 0,
                optimized: 0
            });
        }
        
        const queryStats = this.queryStats.get(key);
        queryStats.count++;
        queryStats.totalDuration += stats.duration;
        queryStats.avgDuration = queryStats.totalDuration / queryStats.count;
        
        if (stats.cached) queryStats.cached++;
        if (stats.optimized) queryStats.optimized++;
    }

    getStatistics() {
        const stats = {
            totalQueries: 0,
            cachedQueries: 0,
            optimizedQueries: 0,
            avgDuration: 0,
            slowQueries: [],
            topQueries: []
        };
        
        for (const [query, stat] of this.queryStats) {
            stats.totalQueries += stat.count;
            stats.cachedQueries += stat.cached;
            stats.optimizedQueries += stat.optimized;
            
            if (stat.avgDuration > this.config.slowQueryThreshold) {
                stats.slowQueries.push({ query, ...stat });
            }
        }
        
        // Get top queries by frequency
        stats.topQueries = Array.from(this.queryStats.entries())
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 10)
            .map(([query, stat]) => ({ query, ...stat }));
        
        return stats;
    }

    reset() {
        this.queryCache.clear();
        this.queryStats.clear();
        this.executionPlans.clear();
        this.indexSuggestions.clear();
    }
}

module.exports = QueryOptimizer;
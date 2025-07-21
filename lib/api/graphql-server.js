import { graphqlHTTP } from 'express-graphql';
import { schema } from './graphql-schema.js';
import { logger } from '../core/logger.js';
import jwt from 'jsonwebtoken';

export class GraphQLServer {
    constructor(options = {}) {
        this.schema = schema;
        this.services = options.services || {};
        this.authManager = options.authManager;
    }

    /**
     * Create GraphQL middleware
     */
    createMiddleware() {
        return graphqlHTTP(async (req, res) => {
            // Extract user from JWT token if present
            let user = null;
            const authHeader = req.headers.authorization;
            
            if (authHeader && authHeader.startsWith('Bearer ')) {
                const token = authHeader.substring(7);
                try {
                    const decoded = jwt.verify(token, process.env.JWT_SECRET);
                    user = await this.authManager.getUserById(decoded.userId);
                } catch (error) {
                    // Invalid token - continue without user context
                    logger.debug('Invalid JWT token in GraphQL request');
                }
            }

            return {
                schema: this.schema,
                graphiql: process.env.NODE_ENV === 'development',
                context: {
                    user,
                    req,
                    res,
                    ...this.services
                },
                customFormatErrorFn: (error) => {
                    // Log the error
                    logger.error('GraphQL error:', error);

                    // Format error response
                    return {
                        message: error.message,
                        locations: error.locations,
                        path: error.path,
                        extensions: {
                            code: error.originalError?.code || 'INTERNAL_ERROR',
                            timestamp: new Date().toISOString()
                        }
                    };
                }
            };
        });
    }

    /**
     * Add custom resolvers
     */
    addResolvers(resolvers) {
        // This would extend the schema with additional resolvers
        // Implementation depends on specific needs
    }

    /**
     * Get schema documentation
     */
    getSchemaDocumentation() {
        const { printSchema } = require('graphql');
        return printSchema(this.schema);
    }
}

/**
 * Create GraphQL endpoint
 */
export function createGraphQLEndpoint(app, services, authManager) {
    const graphqlServer = new GraphQLServer({
        services,
        authManager
    });

    // Mount GraphQL endpoint
    app.use('/graphql', graphqlServer.createMiddleware());

    // Add GraphQL schema endpoint for development
    if (process.env.NODE_ENV === 'development') {
        app.get('/graphql/schema', (req, res) => {
            res.setHeader('Content-Type', 'text/plain');
            res.send(graphqlServer.getSchemaDocumentation());
        });
    }

    logger.info('GraphQL endpoint mounted at /graphql');
    
    return graphqlServer;
}

export default GraphQLServer;
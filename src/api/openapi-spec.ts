/**
 * OpenAPI 3.0 Specification for Otedama Pool API
 * Following OpenAPI best practices and comprehensive documentation
 */

import { OpenAPIV3 } from 'openapi-types';

export const openApiSpec: OpenAPIV3.Document = {
  openapi: '3.0.3',
  info: {
    title: 'Otedama Mining Pool API',
    version: '1.0.0',
    description: `
# Otedama Mining Pool API

A comprehensive REST API for the Otedama P2P distributed mining pool system.

## Features
- Real-time pool statistics
- Miner management and monitoring
- Payment tracking and history
- Block discovery information
- Authentication via JWT
- Rate limiting for API protection

## Authentication
Some endpoints require authentication. Use the \`/auth/login\` endpoint to obtain a JWT token.
Include the token in the Authorization header: \`Bearer YOUR_TOKEN\`
    `.trim(),
    contact: {
      name: 'Otedama Support',
      email: 'support@otedama.pool',
      url: 'https://otedama.pool'
    },
    license: {
      name: 'MIT',
      url: 'https://opensource.org/licenses/MIT'
    }
  },
  servers: [
    {
      url: 'http://localhost:8080/api/v1',
      description: 'Development server'
    },
    {
      url: 'https://api.otedama.pool/v1',
      description: 'Production server'
    },
    {
      url: '{protocol}://{host}:{port}/api/v1',
      description: 'Custom server',
      variables: {
        protocol: {
          enum: ['http', 'https'],
          default: 'https'
        },
        host: {
          default: 'localhost'
        },
        port: {
          default: '8080'
        }
      }
    }
  ],
  tags: [
    {
      name: 'Statistics',
      description: 'Pool and network statistics'
    },
    {
      name: 'Miners',
      description: 'Miner information and management'
    },
    {
      name: 'Blocks',
      description: 'Block discovery and information'
    },
    {
      name: 'Payments',
      description: 'Payment and payout information'
    },
    {
      name: 'Authentication',
      description: 'User authentication and authorization'
    },
    {
      name: 'Account',
      description: 'Account management'
    },
    {
      name: 'Admin',
      description: 'Administrative functions (requires admin role)'
    }
  ],
  paths: {
    '/health': {
      get: {
        summary: 'Health check',
        description: 'Check if the API server is running and healthy',
        operationId: 'getHealth',
        tags: ['Statistics'],
        responses: {
          '200': {
            description: 'Server is healthy',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/HealthResponse'
                }
              }
            }
          }
        }
      }
    },
    '/stats': {
      get: {
        summary: 'Get pool statistics',
        description: 'Returns comprehensive statistics about the mining pool',
        operationId: 'getPoolStats',
        tags: ['Statistics'],
        responses: {
          '200': {
            description: 'Pool statistics retrieved successfully',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/PoolStats'
                }
              }
            }
          },
          '500': {
            $ref: '#/components/responses/InternalServerError'
          }
        }
      }
    },
    '/stats/current': {
      get: {
        summary: 'Get current statistics',
        description: 'Returns real-time statistics for the pool',
        operationId: 'getCurrentStats',
        tags: ['Statistics'],
        responses: {
          '200': {
            description: 'Current statistics',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/CurrentStats'
                }
              }
            }
          }
        }
      }
    },
    '/stats/history/{period}': {
      get: {
        summary: 'Get historical statistics',
        description: 'Returns historical statistics for the specified period',
        operationId: 'getHistoricalStats',
        tags: ['Statistics'],
        parameters: [
          {
            name: 'period',
            in: 'path',
            required: true,
            description: 'Time period for historical data',
            schema: {
              type: 'string',
              enum: ['1h', '24h', '7d', '30d']
            }
          }
        ],
        responses: {
          '200': {
            description: 'Historical statistics',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/HistoricalStats'
                }
              }
            }
          },
          '400': {
            $ref: '#/components/responses/BadRequest'
          }
        }
      }
    },
    '/blocks': {
      get: {
        summary: 'Get blocks',
        description: 'Returns a paginated list of blocks found by the pool',
        operationId: 'getBlocks',
        tags: ['Blocks'],
        parameters: [
          {
            $ref: '#/components/parameters/PageParam'
          },
          {
            $ref: '#/components/parameters/LimitParam'
          }
        ],
        responses: {
          '200': {
            description: 'List of blocks',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/BlockList'
                }
              }
            }
          }
        }
      }
    },
    '/blocks/{height}': {
      get: {
        summary: 'Get block by height',
        description: 'Returns detailed information about a specific block',
        operationId: 'getBlock',
        tags: ['Blocks'],
        parameters: [
          {
            name: 'height',
            in: 'path',
            required: true,
            description: 'Block height',
            schema: {
              type: 'integer',
              minimum: 0
            }
          }
        ],
        responses: {
          '200': {
            description: 'Block details',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/Block'
                }
              }
            }
          },
          '404': {
            $ref: '#/components/responses/NotFound'
          }
        }
      }
    },
    '/miners': {
      get: {
        summary: 'Get miners statistics',
        description: 'Returns a list of active miners with their statistics',
        operationId: 'getMinersStats',
        tags: ['Miners'],
        parameters: [
          {
            $ref: '#/components/parameters/PageParam'
          },
          {
            $ref: '#/components/parameters/LimitParam'
          },
          {
            name: 'sortBy',
            in: 'query',
            description: 'Sort miners by field',
            schema: {
              type: 'string',
              enum: ['hashrate', 'shares', 'balance', 'lastSeen'],
              default: 'hashrate'
            }
          }
        ],
        responses: {
          '200': {
            description: 'List of miners',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/MinerList'
                }
              }
            }
          }
        }
      }
    },
    '/miners/{address}': {
      get: {
        summary: 'Get miner statistics',
        description: 'Returns detailed statistics for a specific miner',
        operationId: 'getMinerStats',
        tags: ['Miners'],
        parameters: [
          {
            name: 'address',
            in: 'path',
            required: true,
            description: 'Miner wallet address',
            schema: {
              type: 'string',
              pattern: '^[a-zA-Z0-9]{26,35}$'
            }
          }
        ],
        responses: {
          '200': {
            description: 'Miner statistics',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/MinerStats'
                }
              }
            }
          },
          '404': {
            $ref: '#/components/responses/NotFound'
          }
        }
      }
    },
    '/payments': {
      get: {
        summary: 'Get recent payments',
        description: 'Returns a list of recent payments made by the pool',
        operationId: 'getPayments',
        tags: ['Payments'],
        parameters: [
          {
            $ref: '#/components/parameters/PageParam'
          },
          {
            $ref: '#/components/parameters/LimitParam'
          }
        ],
        responses: {
          '200': {
            description: 'List of payments',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/PaymentList'
                }
              }
            }
          }
        }
      }
    },
    '/payments/{address}': {
      get: {
        summary: 'Get miner payments',
        description: 'Returns payment history for a specific miner',
        operationId: 'getMinerPayments',
        tags: ['Payments'],
        parameters: [
          {
            name: 'address',
            in: 'path',
            required: true,
            description: 'Miner wallet address',
            schema: {
              type: 'string'
            }
          },
          {
            $ref: '#/components/parameters/PageParam'
          },
          {
            $ref: '#/components/parameters/LimitParam'
          }
        ],
        responses: {
          '200': {
            description: 'Miner payment history',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/PaymentList'
                }
              }
            }
          }
        }
      }
    },
    '/auth/login': {
      post: {
        summary: 'Login',
        description: 'Authenticate with wallet address and signature',
        operationId: 'login',
        tags: ['Authentication'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/LoginRequest'
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Login successful',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/LoginResponse'
                }
              }
            }
          },
          '400': {
            $ref: '#/components/responses/BadRequest'
          },
          '401': {
            $ref: '#/components/responses/Unauthorized'
          }
        }
      }
    },
    '/auth/refresh': {
      post: {
        summary: 'Refresh token',
        description: 'Refresh an expired access token',
        operationId: 'refreshToken',
        tags: ['Authentication'],
        security: [
          {
            bearerAuth: []
          }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/RefreshTokenRequest'
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Token refreshed',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/RefreshTokenResponse'
                }
              }
            }
          },
          '401': {
            $ref: '#/components/responses/Unauthorized'
          }
        }
      }
    },
    '/account': {
      get: {
        summary: 'Get account information',
        description: 'Returns account details for the authenticated user',
        operationId: 'getAccount',
        tags: ['Account'],
        security: [
          {
            bearerAuth: []
          }
        ],
        responses: {
          '200': {
            description: 'Account information',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/Account'
                }
              }
            }
          },
          '401': {
            $ref: '#/components/responses/Unauthorized'
          }
        }
      }
    },
    '/account/settings': {
      put: {
        summary: 'Update account settings',
        description: 'Update settings for the authenticated account',
        operationId: 'updateSettings',
        tags: ['Account'],
        security: [
          {
            bearerAuth: []
          }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/AccountSettings'
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Settings updated',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/SuccessResponse'
                }
              }
            }
          },
          '401': {
            $ref: '#/components/responses/Unauthorized'
          }
        }
      }
    },
    '/account/withdraw': {
      post: {
        summary: 'Request withdrawal',
        description: 'Request a withdrawal of mined funds',
        operationId: 'requestWithdrawal',
        tags: ['Account'],
        security: [
          {
            bearerAuth: []
          }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/WithdrawalRequest'
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Withdrawal requested',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/WithdrawalResponse'
                }
              }
            }
          },
          '400': {
            $ref: '#/components/responses/BadRequest'
          },
          '401': {
            $ref: '#/components/responses/Unauthorized'
          }
        }
      }
    },
    '/admin/miners': {
      get: {
        summary: 'Get all miners (Admin)',
        description: 'Returns detailed information about all miners',
        operationId: 'getAdminMiners',
        tags: ['Admin'],
        security: [
          {
            bearerAuth: []
          }
        ],
        responses: {
          '200': {
            description: 'List of all miners',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: {
                    $ref: '#/components/schemas/MinerDetails'
                  }
                }
              }
            }
          },
          '403': {
            $ref: '#/components/responses/Forbidden'
          }
        }
      }
    },
    '/admin/ban/{address}': {
      post: {
        summary: 'Ban miner',
        description: 'Ban a miner from the pool',
        operationId: 'banMiner',
        tags: ['Admin'],
        security: [
          {
            bearerAuth: []
          }
        ],
        parameters: [
          {
            name: 'address',
            in: 'path',
            required: true,
            schema: {
              type: 'string'
            }
          }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/BanRequest'
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Miner banned',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/SuccessResponse'
                }
              }
            }
          },
          '403': {
            $ref: '#/components/responses/Forbidden'
          }
        }
      },
      delete: {
        summary: 'Unban miner',
        description: 'Remove ban from a miner',
        operationId: 'unbanMiner',
        tags: ['Admin'],
        security: [
          {
            bearerAuth: []
          }
        ],
        parameters: [
          {
            name: 'address',
            in: 'path',
            required: true,
            schema: {
              type: 'string'
            }
          }
        ],
        responses: {
          '200': {
            description: 'Miner unbanned',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/SuccessResponse'
                }
              }
            }
          },
          '403': {
            $ref: '#/components/responses/Forbidden'
          }
        }
      }
    }
  },
  components: {
    schemas: {
      HealthResponse: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['ok', 'degraded', 'error']
          },
          timestamp: {
            type: 'string',
            format: 'date-time'
          }
        },
        required: ['status', 'timestamp']
      },
      PoolStats: {
        type: 'object',
        properties: {
          pool: {
            type: 'object',
            properties: {
              hashrate: {
                type: 'number',
                description: 'Pool hashrate in H/s'
              },
              miners: {
                type: 'integer',
                description: 'Number of active miners'
              },
              workers: {
                type: 'integer',
                description: 'Number of active workers'
              },
              difficulty: {
                type: 'number',
                description: 'Current pool difficulty'
              },
              blockHeight: {
                type: 'integer',
                description: 'Current blockchain height'
              },
              networkDifficulty: {
                type: 'number',
                description: 'Network difficulty'
              },
              poolFee: {
                type: 'number',
                description: 'Pool fee percentage'
              }
            },
            required: ['hashrate', 'miners', 'workers', 'difficulty']
          },
          blocks: {
            type: 'object',
            properties: {
              pending: {
                type: 'integer'
              },
              confirmed: {
                type: 'integer'
              },
              orphaned: {
                type: 'integer'
              },
              total: {
                type: 'integer'
              },
              lastFound: {
                $ref: '#/components/schemas/BlockSummary'
              }
            },
            required: ['pending', 'confirmed', 'orphaned', 'total']
          },
          payments: {
            type: 'object',
            properties: {
              total: {
                type: 'number',
                description: 'Total amount paid out'
              },
              pending: {
                type: 'number',
                description: 'Pending payment amount'
              },
              lastPayout: {
                $ref: '#/components/schemas/PaymentSummary'
              }
            },
            required: ['total', 'pending']
          }
        },
        required: ['pool', 'blocks', 'payments']
      },
      CurrentStats: {
        type: 'object',
        properties: {
          timestamp: {
            type: 'string',
            format: 'date-time'
          },
          hashrate: {
            type: 'number'
          },
          miners: {
            type: 'integer'
          },
          difficulty: {
            type: 'number'
          },
          lastBlock: {
            $ref: '#/components/schemas/BlockSummary'
          }
        },
        required: ['timestamp', 'hashrate', 'miners', 'difficulty']
      },
      HistoricalStats: {
        type: 'object',
        properties: {
          period: {
            type: 'string'
          },
          data: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                timestamp: {
                  type: 'string',
                  format: 'date-time'
                },
                hashrate: {
                  type: 'number'
                },
                miners: {
                  type: 'integer'
                },
                difficulty: {
                  type: 'number'
                }
              }
            }
          }
        },
        required: ['period', 'data']
      },
      BlockList: {
        type: 'object',
        properties: {
          blocks: {
            type: 'array',
            items: {
              $ref: '#/components/schemas/Block'
            }
          },
          pagination: {
            $ref: '#/components/schemas/Pagination'
          }
        },
        required: ['blocks', 'pagination']
      },
      Block: {
        type: 'object',
        properties: {
          height: {
            type: 'integer'
          },
          hash: {
            type: 'string'
          },
          reward: {
            type: 'number'
          },
          timestamp: {
            type: 'string',
            format: 'date-time'
          },
          status: {
            type: 'string',
            enum: ['pending', 'confirmed', 'orphaned']
          },
          confirmations: {
            type: 'integer'
          },
          difficulty: {
            type: 'number'
          },
          shares: {
            type: 'integer'
          },
          luck: {
            type: 'number',
            description: 'Luck percentage'
          }
        },
        required: ['height', 'hash', 'reward', 'timestamp', 'status']
      },
      BlockSummary: {
        type: 'object',
        properties: {
          height: {
            type: 'integer'
          },
          hash: {
            type: 'string'
          },
          reward: {
            type: 'number'
          },
          timestamp: {
            type: 'string',
            format: 'date-time'
          }
        }
      },
      MinerList: {
        type: 'object',
        properties: {
          miners: {
            type: 'array',
            items: {
              $ref: '#/components/schemas/MinerStats'
            }
          },
          pagination: {
            $ref: '#/components/schemas/Pagination'
          }
        },
        required: ['miners', 'pagination']
      },
      MinerStats: {
        type: 'object',
        properties: {
          address: {
            type: 'string'
          },
          hashrate: {
            type: 'number',
            description: 'Current hashrate in H/s'
          },
          shares: {
            type: 'object',
            properties: {
              valid: {
                type: 'integer'
              },
              invalid: {
                type: 'integer'
              },
              stale: {
                type: 'integer'
              }
            }
          },
          balance: {
            type: 'number',
            description: 'Current balance'
          },
          paid: {
            type: 'number',
            description: 'Total amount paid'
          },
          lastShare: {
            type: 'string',
            format: 'date-time'
          },
          workers: {
            type: 'array',
            items: {
              $ref: '#/components/schemas/WorkerStats'
            }
          }
        },
        required: ['address', 'hashrate', 'shares', 'balance']
      },
      MinerDetails: {
        allOf: [
          {
            $ref: '#/components/schemas/MinerStats'
          },
          {
            type: 'object',
            properties: {
              email: {
                type: 'string',
                format: 'email'
              },
              ipAddress: {
                type: 'string'
              },
              joinedAt: {
                type: 'string',
                format: 'date-time'
              },
              settings: {
                $ref: '#/components/schemas/AccountSettings'
              }
            }
          }
        ]
      },
      WorkerStats: {
        type: 'object',
        properties: {
          name: {
            type: 'string'
          },
          hashrate: {
            type: 'number'
          },
          lastSeen: {
            type: 'string',
            format: 'date-time'
          },
          shares: {
            type: 'object',
            properties: {
              valid: {
                type: 'integer'
              },
              invalid: {
                type: 'integer'
              }
            }
          }
        },
        required: ['name', 'hashrate', 'lastSeen']
      },
      PaymentList: {
        type: 'object',
        properties: {
          payments: {
            type: 'array',
            items: {
              $ref: '#/components/schemas/Payment'
            }
          },
          pagination: {
            $ref: '#/components/schemas/Pagination'
          }
        },
        required: ['payments', 'pagination']
      },
      Payment: {
        type: 'object',
        properties: {
          id: {
            type: 'string'
          },
          address: {
            type: 'string'
          },
          amount: {
            type: 'number'
          },
          txHash: {
            type: 'string'
          },
          timestamp: {
            type: 'string',
            format: 'date-time'
          },
          status: {
            type: 'string',
            enum: ['pending', 'processing', 'confirmed', 'failed']
          },
          confirmations: {
            type: 'integer'
          }
        },
        required: ['id', 'address', 'amount', 'timestamp', 'status']
      },
      PaymentSummary: {
        type: 'object',
        properties: {
          amount: {
            type: 'number'
          },
          timestamp: {
            type: 'string',
            format: 'date-time'
          },
          txHash: {
            type: 'string'
          }
        }
      },
      LoginRequest: {
        type: 'object',
        properties: {
          address: {
            type: 'string',
            description: 'Wallet address'
          },
          signature: {
            type: 'string',
            description: 'Signed message proving ownership'
          }
        },
        required: ['address', 'signature']
      },
      LoginResponse: {
        type: 'object',
        properties: {
          token: {
            type: 'string',
            description: 'JWT access token'
          },
          refreshToken: {
            type: 'string',
            description: 'Refresh token for getting new access tokens'
          },
          expiresIn: {
            type: 'integer',
            description: 'Token expiration time in seconds'
          }
        },
        required: ['token', 'refreshToken', 'expiresIn']
      },
      RefreshTokenRequest: {
        type: 'object',
        properties: {
          refreshToken: {
            type: 'string'
          }
        },
        required: ['refreshToken']
      },
      RefreshTokenResponse: {
        type: 'object',
        properties: {
          token: {
            type: 'string'
          },
          expiresIn: {
            type: 'integer'
          }
        },
        required: ['token', 'expiresIn']
      },
      Account: {
        type: 'object',
        properties: {
          address: {
            type: 'string'
          },
          balance: {
            type: 'number'
          },
          paid: {
            type: 'number'
          },
          settings: {
            $ref: '#/components/schemas/AccountSettings'
          },
          stats: {
            $ref: '#/components/schemas/MinerStats'
          }
        },
        required: ['address', 'balance', 'paid']
      },
      AccountSettings: {
        type: 'object',
        properties: {
          payoutThreshold: {
            type: 'number',
            description: 'Minimum balance for automatic payout'
          },
          email: {
            type: 'string',
            format: 'email'
          },
          notifications: {
            type: 'object',
            properties: {
              blockFound: {
                type: 'boolean'
              },
              paymentSent: {
                type: 'boolean'
              },
              workerOffline: {
                type: 'boolean'
              }
            }
          }
        }
      },
      WithdrawalRequest: {
        type: 'object',
        properties: {
          amount: {
            type: 'number',
            minimum: 0
          }
        },
        required: ['amount']
      },
      WithdrawalResponse: {
        type: 'object',
        properties: {
          withdrawalId: {
            type: 'string'
          },
          amount: {
            type: 'number'
          },
          estimatedTime: {
            type: 'string',
            format: 'date-time'
          },
          status: {
            type: 'string',
            enum: ['pending', 'processing', 'completed', 'failed']
          }
        },
        required: ['withdrawalId', 'amount', 'status']
      },
      BanRequest: {
        type: 'object',
        properties: {
          reason: {
            type: 'string'
          },
          duration: {
            type: 'integer',
            description: 'Ban duration in seconds (0 for permanent)'
          }
        },
        required: ['reason']
      },
      SuccessResponse: {
        type: 'object',
        properties: {
          success: {
            type: 'boolean'
          },
          message: {
            type: 'string'
          }
        },
        required: ['success']
      },
      ErrorResponse: {
        type: 'object',
        properties: {
          error: {
            type: 'string'
          },
          message: {
            type: 'string'
          },
          details: {
            type: 'object'
          }
        },
        required: ['error', 'message']
      },
      Pagination: {
        type: 'object',
        properties: {
          page: {
            type: 'integer'
          },
          limit: {
            type: 'integer'
          },
          total: {
            type: 'integer'
          },
          pages: {
            type: 'integer'
          }
        },
        required: ['page', 'limit', 'total', 'pages']
      }
    },
    parameters: {
      PageParam: {
        name: 'page',
        in: 'query',
        description: 'Page number',
        schema: {
          type: 'integer',
          minimum: 1,
          default: 1
        }
      },
      LimitParam: {
        name: 'limit',
        in: 'query',
        description: 'Number of items per page',
        schema: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          default: 20
        }
      }
    },
    responses: {
      BadRequest: {
        description: 'Bad request',
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/ErrorResponse'
            }
          }
        }
      },
      Unauthorized: {
        description: 'Unauthorized',
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/ErrorResponse'
            }
          }
        }
      },
      Forbidden: {
        description: 'Forbidden',
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/ErrorResponse'
            }
          }
        }
      },
      NotFound: {
        description: 'Not found',
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/ErrorResponse'
            }
          }
        }
      },
      InternalServerError: {
        description: 'Internal server error',
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/ErrorResponse'
            }
          }
        }
      }
    },
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT token obtained from /auth/login endpoint'
      }
    }
  }
};

/**
 * Generate OpenAPI JSON file
 */
export function generateOpenApiJson(): string {
  return JSON.stringify(openApiSpec, null, 2);
}

/**
 * Generate OpenAPI YAML file
 */
export function generateOpenApiYaml(): string {
  // Simple YAML generator for OpenAPI spec
  const yaml = require('js-yaml');
  return yaml.dump(openApiSpec, {
    indent: 2,
    lineWidth: 120,
    noRefs: false
  });
}

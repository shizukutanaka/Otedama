/**
 * Event Handlers and Saga Pattern Implementation
 * 
 * 設計原則:
 * - Martin: 単一責任のイベントハンドラー
 * - Pike: 並行処理を活用したサガ実行
 * - Carmack: 効率的なステート管理
 */

import { EventBus, Event, EventHandler } from './event-bus';
import { EventStore } from './event-store';
import { createLogger } from '../utils/logger';
import { DomainEvent } from './domain-events';

export interface EventHandlerConfig {
    name: string;
    eventTypes: string[];
    concurrency?: number;
    timeout?: number;
    retryPolicy?: {
        maxRetries: number;
        retryDelay: number;
    };
}

export abstract class BaseEventHandler {
    protected logger;
    
    constructor(
        protected eventBus: EventBus,
        protected config: EventHandlerConfig
    ) {
        this.logger = createLogger(`EventHandler:${config.name}`);
    }

    public async start(): Promise<void> {
        for (const eventType of this.config.eventTypes) {
            this.eventBus.subscribe(
                eventType,
                this.handleEvent.bind(this),
                {
                    name: this.config.name,
                    timeout: this.config.timeout,
                    retryPolicy: this.config.retryPolicy
                }
            );
        }

        this.logger.info(`Started handling events: ${this.config.eventTypes.join(', ')}`);
    }

    private async handleEvent(event: Event): Promise<void> {
        try {
            await this.handle(event);
        } catch (error) {
            this.logger.error(`Error handling event ${event.type}:`, error);
            throw error;
        }
    }

    protected abstract handle(event: Event): Promise<void>;
}

// Saga implementation
export interface SagaStep<TData = any> {
    name: string;
    execute: (data: TData) => Promise<any>;
    compensate?: (data: TData, error?: Error) => Promise<void>;
}

export interface SagaContext<TData = any> {
    id: string;
    name: string;
    data: TData;
    currentStep: number;
    completedSteps: string[];
    status: 'running' | 'completed' | 'compensating' | 'failed';
    startedAt: Date;
    completedAt?: Date;
    error?: Error;
}

export abstract class Saga<TData = any> {
    protected logger;
    protected steps: SagaStep<TData>[] = [];
    protected context: SagaContext<TData>;

    constructor(
        protected name: string,
        protected eventBus: EventBus,
        protected eventStore?: EventStore
    ) {
        this.logger = createLogger(`Saga:${name}`);
        this.context = this.createContext();
    }

    protected abstract defineSteps(): SagaStep<TData>[];

    public async execute(data: TData): Promise<void> {
        this.context = this.createContext(data);
        this.steps = this.defineSteps();

        this.logger.info(`Starting saga: ${this.name}`, { sagaId: this.context.id });

        try {
            // Execute all steps
            for (let i = 0; i < this.steps.length; i++) {
                const step = this.steps[i];
                this.context.currentStep = i;

                this.logger.debug(`Executing step: ${step.name}`);
                
                await this.emitEvent('saga.step.started', {
                    sagaId: this.context.id,
                    stepName: step.name,
                    stepIndex: i
                });

                try {
                    const result = await step.execute(this.context.data);
                    
                    // Update context with result
                    if (result !== undefined) {
                        this.context.data = { ...this.context.data, ...result };
                    }

                    this.context.completedSteps.push(step.name);

                    await this.emitEvent('saga.step.completed', {
                        sagaId: this.context.id,
                        stepName: step.name,
                        stepIndex: i
                    });

                } catch (error) {
                    this.logger.error(`Step ${step.name} failed:`, error);
                    
                    await this.emitEvent('saga.step.failed', {
                        sagaId: this.context.id,
                        stepName: step.name,
                        stepIndex: i,
                        error: error.message
                    });

                    // Start compensation
                    await this.compensate(error);
                    throw error;
                }
            }

            // Saga completed successfully
            this.context.status = 'completed';
            this.context.completedAt = new Date();

            await this.emitEvent('saga.completed', {
                sagaId: this.context.id,
                sagaName: this.name,
                duration: Date.now() - this.context.startedAt.getTime()
            });

            this.logger.info(`Saga completed: ${this.name}`, { sagaId: this.context.id });

        } catch (error) {
            this.context.status = 'failed';
            this.context.error = error;

            await this.emitEvent('saga.failed', {
                sagaId: this.context.id,
                sagaName: this.name,
                error: error.message
            });

            this.logger.error(`Saga failed: ${this.name}`, { sagaId: this.context.id, error });
            throw error;
        }
    }

    private async compensate(error: Error): Promise<void> {
        this.context.status = 'compensating';
        
        this.logger.info(`Starting compensation for saga: ${this.name}`, { 
            sagaId: this.context.id,
            completedSteps: this.context.completedSteps 
        });

        await this.emitEvent('saga.compensation.started', {
            sagaId: this.context.id,
            sagaName: this.name
        });

        // Compensate in reverse order
        const stepsToCompensate = this.context.completedSteps.slice().reverse();

        for (const stepName of stepsToCompensate) {
            const step = this.steps.find(s => s.name === stepName);
            
            if (step && step.compensate) {
                try {
                    this.logger.debug(`Compensating step: ${stepName}`);
                    await step.compensate(this.context.data, error);
                    
                    await this.emitEvent('saga.step.compensated', {
                        sagaId: this.context.id,
                        stepName: stepName
                    });

                } catch (compensationError) {
                    this.logger.error(`Compensation failed for step ${stepName}:`, compensationError);
                    
                    await this.emitEvent('saga.compensation.failed', {
                        sagaId: this.context.id,
                        stepName: stepName,
                        error: compensationError.message
                    });
                }
            }
        }

        await this.emitEvent('saga.compensation.completed', {
            sagaId: this.context.id,
            sagaName: this.name
        });
    }

    private createContext(data?: TData): SagaContext<TData> {
        return {
            id: this.generateSagaId(),
            name: this.name,
            data: data || {} as TData,
            currentStep: 0,
            completedSteps: [],
            status: 'running',
            startedAt: new Date()
        };
    }

    private generateSagaId(): string {
        return `saga_${this.name}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    private async emitEvent(type: string, data: any): Promise<void> {
        await this.eventBus.publish(type, data, `Saga:${this.name}`);
    }
}

// Example implementations

/**
 * Payment Processing Saga
 */
export class PaymentProcessingSaga extends Saga<{
    minerId: string;
    amount: number;
    address: string;
    paymentId?: string;
    txHash?: string;
}> {
    protected defineSteps(): SagaStep[] {
        return [
            {
                name: 'validate_payment',
                execute: async (data) => {
                    this.logger.info('Validating payment', data);
                    
                    if (data.amount <= 0) {
                        throw new Error('Invalid payment amount');
                    }
                    
                    if (!data.address) {
                        throw new Error('Invalid payment address');
                    }

                    return { validated: true };
                }
            },
            {
                name: 'create_payment_record',
                execute: async (data) => {
                    this.logger.info('Creating payment record');
                    
                    const paymentId = `pay_${Date.now()}`;
                    
                    await this.eventBus.publish('payment.created', {
                        paymentId,
                        minerId: data.minerId,
                        amount: data.amount,
                        address: data.address
                    }, 'PaymentSaga');

                    return { paymentId };
                },
                compensate: async (data) => {
                    if (data.paymentId) {
                        this.logger.info('Deleting payment record', { paymentId: data.paymentId });
                        
                        await this.eventBus.publish('payment.cancelled', {
                            paymentId: data.paymentId
                        }, 'PaymentSaga');
                    }
                }
            },
            {
                name: 'reserve_funds',
                execute: async (data) => {
                    this.logger.info('Reserving funds', { amount: data.amount });
                    
                    // Simulate fund reservation
                    await new Promise(resolve => setTimeout(resolve, 100));
                    
                    return { fundsReserved: true };
                },
                compensate: async (data) => {
                    this.logger.info('Releasing reserved funds', { amount: data.amount });
                    
                    await this.eventBus.publish('funds.released', {
                        paymentId: data.paymentId,
                        amount: data.amount
                    }, 'PaymentSaga');
                }
            },
            {
                name: 'send_transaction',
                execute: async (data) => {
                    this.logger.info('Sending transaction', { 
                        address: data.address, 
                        amount: data.amount 
                    });
                    
                    // Simulate blockchain transaction
                    await new Promise(resolve => setTimeout(resolve, 500));
                    
                    const txHash = `0x${Math.random().toString(16).substr(2, 64)}`;
                    
                    await this.eventBus.publish('payment.sent', {
                        paymentId: data.paymentId,
                        txHash,
                        amount: data.amount,
                        address: data.address
                    }, 'PaymentSaga');

                    return { txHash };
                },
                compensate: async (data) => {
                    if (data.txHash) {
                        this.logger.warn('Cannot compensate sent transaction', { txHash: data.txHash });
                        // In real scenario, might need manual intervention
                    }
                }
            },
            {
                name: 'update_balance',
                execute: async (data) => {
                    this.logger.info('Updating miner balance', { 
                        minerId: data.minerId, 
                        amount: data.amount 
                    });
                    
                    await this.eventBus.publish('balance.updated', {
                        minerId: data.minerId,
                        amount: -data.amount,
                        reason: 'payment',
                        paymentId: data.paymentId
                    }, 'PaymentSaga');

                    return { balanceUpdated: true };
                },
                compensate: async (data) => {
                    this.logger.info('Reverting balance update', { 
                        minerId: data.minerId, 
                        amount: data.amount 
                    });
                    
                    await this.eventBus.publish('balance.updated', {
                        minerId: data.minerId,
                        amount: data.amount,
                        reason: 'payment_reversal',
                        paymentId: data.paymentId
                    }, 'PaymentSaga');
                }
            }
        ];
    }
}

/**
 * Share Validation Event Handler
 */
export class ShareValidationHandler extends BaseEventHandler {
    constructor(eventBus: EventBus) {
        super(eventBus, {
            name: 'ShareValidationHandler',
            eventTypes: ['share.submitted'],
            timeout: 5000,
            retryPolicy: {
                maxRetries: 3,
                retryDelay: 1000
            }
        });
    }

    protected async handle(event: Event): Promise<void> {
        const { shareId, minerId, difficulty, nonce } = event.data;

        try {
            // Validate share
            const isValid = await this.validateShare(nonce, difficulty);

            if (isValid) {
                await this.eventBus.publish('share.accepted', {
                    shareId,
                    minerId,
                    difficulty,
                    reward: this.calculateReward(difficulty)
                }, 'ShareValidator');
            } else {
                await this.eventBus.publish('share.rejected', {
                    shareId,
                    minerId,
                    reason: 'Invalid nonce',
                    errorCode: 'INVALID_NONCE'
                }, 'ShareValidator');
            }
        } catch (error) {
            await this.eventBus.publish('share.rejected', {
                shareId,
                minerId,
                reason: error.message,
                errorCode: 'VALIDATION_ERROR'
            }, 'ShareValidator');
        }
    }

    private async validateShare(nonce: string, difficulty: number): Promise<boolean> {
        // Simulate share validation
        await new Promise(resolve => setTimeout(resolve, 10));
        return Math.random() > 0.1; // 90% valid shares
    }

    private calculateReward(difficulty: number): number {
        // Simple reward calculation
        return difficulty * 0.001;
    }
}

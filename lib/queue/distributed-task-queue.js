const EventEmitter = require('events');
const crypto = require('crypto');
const cluster = require('cluster');
const os = require('os');

class DistributedTaskQueueSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      queues: options.queues || ['default', 'priority', 'scheduled', 'batch'],
      maxWorkers: options.maxWorkers || os.cpus().length,
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 5000,
      taskTimeout: options.taskTimeout || 300000, // 5 minutes
      persistence: options.persistence !== false,
      persistenceBackend: options.persistenceBackend || 'sqlite',
      redisConfig: options.redisConfig || null,
      priorityLevels: options.priorityLevels || 10,
      schedulerInterval: options.schedulerInterval || 1000,
      deadLetterQueue: options.deadLetterQueue !== false,
      rateLimit: options.rateLimit || null,
      clustering: options.clustering !== false,
      workerPooling: options.workerPooling !== false,
      taskDependencies: options.taskDependencies !== false,
      workflowSupport: options.workflowSupport !== false,
      monitoring: options.monitoring !== false
    };
    
    this.queues = new Map();
    this.workers = new Map();
    this.tasks = new Map();
    this.workflows = new Map();
    this.taskHandlers = new Map();
    this.scheduledTasks = new Map();
    this.dependencies = new Map();
    this.metrics = new QueueMetrics();
    this.isRunning = false;
    this.isPrimary = cluster.isPrimary || cluster.isMaster;
  }
  
  async initialize() {
    try {
      // Initialize queues
      this.initializeQueues();
      
      // Initialize persistence
      if (this.config.persistence) {
        await this.initializePersistence();
      }
      
      // Initialize clustering
      if (this.config.clustering && this.isPrimary) {
        await this.initializeClustering();
      }
      
      // Start scheduler
      this.startScheduler();
      
      // Start monitoring
      if (this.config.monitoring) {
        this.startMonitoring();
      }
      
      this.isRunning = true;
      
      this.emit('initialized', {
        queues: Array.from(this.queues.keys()),
        workers: this.config.maxWorkers
      });
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  initializeQueues() {
    for (const queueName of this.config.queues) {
      const queue = new TaskQueue({
        name: queueName,
        priority: queueName === 'priority',
        maxSize: queueName === 'batch' ? 10000 : 1000
      });
      
      this.queues.set(queueName, queue);
    }
    
    // Initialize dead letter queue if enabled
    if (this.config.deadLetterQueue) {
      this.queues.set('dead-letter', new TaskQueue({
        name: 'dead-letter',
        priority: false,
        maxSize: 10000
      }));
    }
  }
  
  async initializePersistence() {
    switch (this.config.persistenceBackend) {
      case 'sqlite':
        this.persistence = new SQLitePersistence();
        break;
      case 'redis':
        this.persistence = new RedisPersistence(this.config.redisConfig);
        break;
      case 'mongodb':
        this.persistence = new MongoDBPersistence(this.config.mongoConfig);
        break;
      default:
        throw new Error(`Unknown persistence backend: ${this.config.persistenceBackend}`);
    }
    
    await this.persistence.initialize();
    
    // Restore pending tasks
    const pendingTasks = await this.persistence.getPendingTasks();
    for (const taskData of pendingTasks) {
      const task = Task.fromJSON(taskData);
      this.tasks.set(task.id, task);
      
      const queue = this.queues.get(task.queue);
      if (queue) {
        queue.enqueue(task);
      }
    }
  }
  
  async initializeClustering() {
    if (cluster.isPrimary) {
      // Fork workers
      for (let i = 0; i < this.config.maxWorkers; i++) {
        const worker = cluster.fork();
        this.workers.set(worker.id, {
          id: worker.id,
          process: worker,
          status: 'idle',
          currentTask: null,
          tasksCompleted: 0,
          tasksFaile<d: 0
        });
      }
      
      // Handle worker messages
      cluster.on('message', (worker, message) => {
        this.handleWorkerMessage(worker, message);
      });
      
      // Handle worker exit
      cluster.on('exit', (worker, code, signal) => {
        this.handleWorkerExit(worker, code, signal);
      });
    } else {
      // Worker process
      this.initializeWorker();
    }
  }
  
  initializeWorker() {
    process.on('message', (message) => {
      this.handleMasterMessage(message);
    });
    
    // Send ready signal
    process.send({ type: 'ready', workerId: cluster.worker.id });
  }
  
  registerHandler(taskType, handler, options = {}) {
    const handlerConfig = {
      handler,
      concurrency: options.concurrency || 1,
      timeout: options.timeout || this.config.taskTimeout,
      retries: options.retries || this.config.maxRetries,
      rateLimit: options.rateLimit || null
    };
    
    this.taskHandlers.set(taskType, handlerConfig);
    
    this.emit('handlerRegistered', { taskType, options });
  }
  
  async enqueue(taskType, payload, options = {}) {
    if (!this.taskHandlers.has(taskType)) {
      throw new Error(`No handler registered for task type: ${taskType}`);
    }
    
    const task = new Task({
      id: this.generateTaskId(),
      type: taskType,
      payload,
      queue: options.queue || 'default',
      priority: options.priority || 5,
      retries: 0,
      maxRetries: options.maxRetries || this.config.maxRetries,
      timeout: options.timeout || this.config.taskTimeout,
      scheduledFor: options.scheduledFor || null,
      dependencies: options.dependencies || [],
      metadata: options.metadata || {}
    });
    
    // Check dependencies
    if (this.config.taskDependencies && task.dependencies.length > 0) {
      const unresolvedDeps = await this.checkDependencies(task.dependencies);
      if (unresolvedDeps.length > 0) {
        task.status = 'waiting';
        this.dependencies.set(task.id, unresolvedDeps);
      }
    }
    
    // Store task
    this.tasks.set(task.id, task);
    
    // Persist if enabled
    if (this.config.persistence) {
      await this.persistence.saveTask(task);
    }
    
    // Add to appropriate queue
    if (task.scheduledFor && task.scheduledFor > Date.now()) {
      this.scheduledTasks.set(task.id, task);
    } else if (task.status === 'waiting') {
      // Task is waiting for dependencies
    } else {
      const queue = this.queues.get(task.queue);
      if (!queue) {
        throw new Error(`Unknown queue: ${task.queue}`);
      }
      
      queue.enqueue(task);
      this.emit('taskEnqueued', { taskId: task.id, queue: task.queue });
    }
    
    // Process immediately if workers available
    this.processNextTask();
    
    return task.id;
  }
  
  async enqueueBatch(tasks, options = {}) {
    const taskIds = [];
    
    for (const { type, payload, taskOptions } of tasks) {
      const taskId = await this.enqueue(type, payload, {
        ...options,
        ...taskOptions,
        queue: options.queue || 'batch'
      });
      taskIds.push(taskId);
    }
    
    return taskIds;
  }
  
  async createWorkflow(name, definition, options = {}) {
    if (!this.config.workflowSupport) {
      throw new Error('Workflow support is not enabled');
    }
    
    const workflow = new Workflow({
      id: this.generateWorkflowId(),
      name,
      definition,
      status: 'created',
      currentStep: 0,
      results: {},
      options
    });
    
    this.workflows.set(workflow.id, workflow);
    
    this.emit('workflowCreated', { workflowId: workflow.id, name });
    
    return workflow.id;
  }
  
  async startWorkflow(workflowId, input = {}) {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    
    workflow.status = 'running';
    workflow.input = input;
    workflow.startedAt = Date.now();
    
    // Enqueue first step
    await this.executeWorkflowStep(workflow, 0);
    
    return workflow;
  }
  
  async executeWorkflowStep(workflow, stepIndex) {
    if (stepIndex >= workflow.definition.steps.length) {
      workflow.status = 'completed';
      workflow.completedAt = Date.now();
      this.emit('workflowCompleted', {
        workflowId: workflow.id,
        results: workflow.results
      });
      return;
    }
    
    const step = workflow.definition.steps[stepIndex];
    const stepInput = this.resolveStepInput(step, workflow);
    
    const taskId = await this.enqueue(step.task, stepInput, {
      queue: 'priority',
      metadata: {
        workflowId: workflow.id,
        stepIndex,
        stepName: step.name
      }
    });
    
    workflow.currentStep = stepIndex;
    workflow.currentTaskId = taskId;
  }
  
  resolveStepInput(step, workflow) {
    let input = { ...workflow.input };
    
    // Add results from previous steps
    if (step.dependencies) {
      for (const dep of step.dependencies) {
        if (workflow.results[dep]) {
          input[dep] = workflow.results[dep];
        }
      }
    }
    
    // Apply transformations
    if (step.transform) {
      input = step.transform(input);
    }
    
    return input;
  }
  
  async processNextTask() {
    if (!this.isRunning) return;
    
    // Find available worker
    const availableWorker = this.findAvailableWorker();
    if (!availableWorker) return;
    
    // Get next task from queues
    const task = this.getNextTask();
    if (!task) return;
    
    // Assign task to worker
    await this.assignTaskToWorker(task, availableWorker);
  }
  
  findAvailableWorker() {
    if (this.config.clustering && this.isPrimary) {
      // Find idle cluster worker
      for (const [id, worker] of this.workers) {
        if (worker.status === 'idle') {
          return worker;
        }
      }
    } else {
      // Check local worker availability
      const activeCount = Array.from(this.workers.values())
        .filter(w => w.status === 'busy').length;
      
      if (activeCount < this.config.maxWorkers) {
        return { id: `local-${Date.now()}`, type: 'local' };
      }
    }
    
    return null;
  }
  
  getNextTask() {
    // Priority queue first
    const priorityQueue = this.queues.get('priority');
    if (priorityQueue && !priorityQueue.isEmpty()) {
      return priorityQueue.dequeue();
    }
    
    // Then other queues in order
    for (const [name, queue] of this.queues) {
      if (name !== 'priority' && name !== 'dead-letter' && !queue.isEmpty()) {
        return queue.dequeue();
      }
    }
    
    return null;
  }
  
  async assignTaskToWorker(task, worker) {
    task.status = 'running';
    task.startedAt = Date.now();
    task.workerId = worker.id;
    
    worker.status = 'busy';
    worker.currentTask = task.id;
    
    // Update persistence
    if (this.config.persistence) {
      await this.persistence.updateTask(task);
    }
    
    // Send task to worker
    if (this.config.clustering && this.isPrimary) {
      worker.process.send({
        type: 'executeTask',
        task: task.toJSON()
      });
    } else {
      // Execute locally
      this.executeTaskLocally(task);
    }
    
    // Set timeout
    const timeout = setTimeout(() => {
      this.handleTaskTimeout(task);
    }, task.timeout);
    
    task.timeoutHandle = timeout;
    
    this.emit('taskStarted', { taskId: task.id, workerId: worker.id });
  }
  
  async executeTaskLocally(task) {
    const handlerConfig = this.taskHandlers.get(task.type);
    if (!handlerConfig) {
      await this.handleTaskError(task, new Error('Handler not found'));
      return;
    }
    
    try {
      // Apply rate limiting if configured
      if (handlerConfig.rateLimit) {
        await this.applyRateLimit(task.type, handlerConfig.rateLimit);
      }
      
      // Execute handler
      const result = await handlerConfig.handler(task.payload, {
        taskId: task.id,
        attempt: task.retries + 1,
        metadata: task.metadata
      });
      
      await this.handleTaskSuccess(task, result);
    } catch (error) {
      await this.handleTaskError(task, error);
    }
  }
  
  async handleTaskSuccess(task, result) {
    clearTimeout(task.timeoutHandle);
    
    task.status = 'completed';
    task.completedAt = Date.now();
    task.result = result;
    
    // Update worker
    const worker = this.workers.get(task.workerId);
    if (worker) {
      worker.status = 'idle';
      worker.currentTask = null;
      worker.tasksCompleted++;
    }
    
    // Update persistence
    if (this.config.persistence) {
      await this.persistence.updateTask(task);
    }
    
    // Handle workflow continuation
    if (task.metadata.workflowId) {
      await this.handleWorkflowStepComplete(task);
    }
    
    // Check dependent tasks
    if (this.config.taskDependencies) {
      await this.checkDependentTasks(task.id);
    }
    
    // Update metrics
    this.metrics.recordTaskComplete(task);
    
    this.emit('taskCompleted', {
      taskId: task.id,
      duration: task.completedAt - task.startedAt,
      result
    });
    
    // Process next task
    this.processNextTask();
  }
  
  async handleTaskError(task, error) {
    clearTimeout(task.timeoutHandle);
    
    task.retries++;
    task.lastError = error.message;
    task.lastErrorAt = Date.now();
    
    // Update worker
    const worker = this.workers.get(task.workerId);
    if (worker) {
      worker.status = 'idle';
      worker.currentTask = null;
      worker.tasksFailed++;
    }
    
    if (task.retries < task.maxRetries) {
      // Retry task
      task.status = 'pending';
      task.nextRetryAt = Date.now() + this.calculateRetryDelay(task.retries);
      
      // Re-enqueue for retry
      setTimeout(() => {
        const queue = this.queues.get(task.queue);
        if (queue) {
          queue.enqueue(task);
          this.processNextTask();
        }
      }, task.nextRetryAt - Date.now());
      
      this.emit('taskRetry', {
        taskId: task.id,
        attempt: task.retries,
        error: error.message
      });
    } else {
      // Move to dead letter queue
      task.status = 'failed';
      task.failedAt = Date.now();
      
      if (this.config.deadLetterQueue) {
        const dlq = this.queues.get('dead-letter');
        dlq.enqueue(task);
      }
      
      // Update persistence
      if (this.config.persistence) {
        await this.persistence.updateTask(task);
      }
      
      // Update metrics
      this.metrics.recordTaskFailed(task);
      
      this.emit('taskFailed', {
        taskId: task.id,
        error: error.message,
        attempts: task.retries
      });
    }
    
    // Process next task
    this.processNextTask();
  }
  
  async handleTaskTimeout(task) {
    const error = new Error(`Task timeout after ${task.timeout}ms`);
    await this.handleTaskError(task, error);
  }
  
  calculateRetryDelay(attemptNumber) {
    // Exponential backoff with jitter
    const baseDelay = this.config.retryDelay;
    const maxDelay = baseDelay * Math.pow(2, attemptNumber);
    const jitter = Math.random() * 1000;
    
    return Math.min(maxDelay + jitter, 300000); // Max 5 minutes
  }
  
  async handleWorkflowStepComplete(task) {
    const workflow = this.workflows.get(task.metadata.workflowId);
    if (!workflow) return;
    
    const stepIndex = task.metadata.stepIndex;
    const stepName = task.metadata.stepName;
    
    // Store step result
    workflow.results[stepName] = task.result;
    
    // Execute next step
    await this.executeWorkflowStep(workflow, stepIndex + 1);
  }
  
  async checkDependencies(dependencies) {
    const unresolved = [];
    
    for (const depId of dependencies) {
      const depTask = this.tasks.get(depId);
      if (!depTask || depTask.status !== 'completed') {
        unresolved.push(depId);
      }
    }
    
    return unresolved;
  }
  
  async checkDependentTasks(completedTaskId) {
    const tasksToCheck = [];
    
    for (const [taskId, deps] of this.dependencies) {
      if (deps.includes(completedTaskId)) {
        tasksToCheck.push(taskId);
      }
    }
    
    for (const taskId of tasksToCheck) {
      const task = this.tasks.get(taskId);
      if (!task) continue;
      
      const unresolvedDeps = await this.checkDependencies(task.dependencies);
      
      if (unresolvedDeps.length === 0) {
        // All dependencies resolved
        this.dependencies.delete(taskId);
        task.status = 'pending';
        
        const queue = this.queues.get(task.queue);
        if (queue) {
          queue.enqueue(task);
          this.processNextTask();
        }
      } else {
        // Update remaining dependencies
        this.dependencies.set(taskId, unresolvedDeps);
      }
    }
  }
  
  async applyRateLimit(taskType, limit) {
    // Simple rate limiting implementation
    const key = `rateLimit:${taskType}`;
    const now = Date.now();
    
    if (!this.rateLimitBuckets) {
      this.rateLimitBuckets = new Map();
    }
    
    let bucket = this.rateLimitBuckets.get(key);
    if (!bucket) {
      bucket = { tokens: limit, lastRefill: now };
      this.rateLimitBuckets.set(key, bucket);
    }
    
    // Refill tokens
    const timePassed = now - bucket.lastRefill;
    const tokensToAdd = (timePassed / 60000) * limit;
    bucket.tokens = Math.min(limit, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
    
    if (bucket.tokens < 1) {
      // Wait for token
      const waitTime = (1 - bucket.tokens) * 60000 / limit;
      await new Promise(resolve => setTimeout(resolve, waitTime));
      bucket.tokens = 0;
    } else {
      bucket.tokens--;
    }
  }
  
  handleWorkerMessage(worker, message) {
    switch (message.type) {
      case 'ready':
        this.workers.get(worker.id).status = 'idle';
        this.processNextTask();
        break;
        
      case 'taskComplete':
        this.handleRemoteTaskComplete(message.taskId, message.result);
        break;
        
      case 'taskError':
        this.handleRemoteTaskError(message.taskId, message.error);
        break;
        
      case 'heartbeat':
        this.workers.get(worker.id).lastHeartbeat = Date.now();
        break;
    }
  }
  
  async handleRemoteTaskComplete(taskId, result) {
    const task = this.tasks.get(taskId);
    if (task) {
      await this.handleTaskSuccess(task, result);
    }
  }
  
  async handleRemoteTaskError(taskId, errorMessage) {
    const task = this.tasks.get(taskId);
    if (task) {
      await this.handleTaskError(task, new Error(errorMessage));
    }
  }
  
  handleWorkerExit(worker, code, signal) {
    const workerInfo = this.workers.get(worker.id);
    if (!workerInfo) return;
    
    this.emit('workerExit', {
      workerId: worker.id,
      code,
      signal,
      currentTask: workerInfo.currentTask
    });
    
    // Handle task reassignment
    if (workerInfo.currentTask) {
      const task = this.tasks.get(workerInfo.currentTask);
      if (task) {
        // Re-enqueue task
        task.status = 'pending';
        const queue = this.queues.get(task.queue);
        if (queue) {
          queue.enqueue(task);
        }
      }
    }
    
    // Remove worker
    this.workers.delete(worker.id);
    
    // Fork new worker
    if (this.isRunning) {
      const newWorker = cluster.fork();
      this.workers.set(newWorker.id, {
        id: newWorker.id,
        process: newWorker,
        status: 'idle',
        currentTask: null,
        tasksCompleted: 0,
        tasksFailed: 0
      });
    }
  }
  
  handleMasterMessage(message) {
    switch (message.type) {
      case 'executeTask':
        this.executeWorkerTask(message.task);
        break;
        
      case 'shutdown':
        process.exit(0);
        break;
    }
  }
  
  async executeWorkerTask(taskData) {
    const task = Task.fromJSON(taskData);
    
    try {
      const handlerConfig = this.taskHandlers.get(task.type);
      if (!handlerConfig) {
        throw new Error('Handler not found');
      }
      
      const result = await handlerConfig.handler(task.payload, {
        taskId: task.id,
        attempt: task.retries + 1,
        metadata: task.metadata
      });
      
      process.send({
        type: 'taskComplete',
        taskId: task.id,
        result
      });
    } catch (error) {
      process.send({
        type: 'taskError',
        taskId: task.id,
        error: error.message
      });
    }
  }
  
  startScheduler() {
    setInterval(() => {
      const now = Date.now();
      
      for (const [taskId, task] of this.scheduledTasks) {
        if (task.scheduledFor <= now) {
          this.scheduledTasks.delete(taskId);
          
          const queue = this.queues.get(task.queue);
          if (queue) {
            task.status = 'pending';
            queue.enqueue(task);
            this.processNextTask();
          }
        }
      }
    }, this.config.schedulerInterval);
  }
  
  startMonitoring() {
    setInterval(() => {
      const stats = this.getStats();
      this.emit('stats', stats);
      
      // Check worker health
      if (this.config.clustering && this.isPrimary) {
        for (const [id, worker] of this.workers) {
          if (worker.lastHeartbeat && 
              Date.now() - worker.lastHeartbeat > 30000) {
            this.emit('workerUnresponsive', { workerId: id });
          }
        }
      }
    }, 5000);
  }
  
  generateTaskId() {
    return `task_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
  }
  
  generateWorkflowId() {
    return `workflow_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
  }
  
  // Public API methods
  
  async getTask(taskId) {
    const task = this.tasks.get(taskId);
    return task ? task.toJSON() : null;
  }
  
  async cancelTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    
    if (task.status === 'running') {
      // Cannot cancel running task
      return false;
    }
    
    task.status = 'cancelled';
    task.cancelledAt = Date.now();
    
    // Remove from queue
    for (const queue of this.queues.values()) {
      queue.remove(task);
    }
    
    // Update persistence
    if (this.config.persistence) {
      await this.persistence.updateTask(task);
    }
    
    this.emit('taskCancelled', { taskId });
    
    return true;
  }
  
  async retryTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'failed') return false;
    
    task.status = 'pending';
    task.retries = 0;
    
    const queue = this.queues.get(task.queue);
    if (queue) {
      queue.enqueue(task);
      this.processNextTask();
    }
    
    return true;
  }
  
  getStats() {
    const stats = {
      queues: {},
      workers: {},
      tasks: {
        total: this.tasks.size,
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
        waiting: 0
      },
      workflows: {
        total: this.workflows.size,
        running: 0,
        completed: 0
      },
      performance: this.metrics.getPerformanceStats()
    };
    
    // Queue stats
    for (const [name, queue] of this.queues) {
      stats.queues[name] = {
        size: queue.size(),
        processing: queue.processing
      };
    }
    
    // Worker stats
    for (const [id, worker] of this.workers) {
      stats.workers[id] = {
        status: worker.status,
        tasksCompleted: worker.tasksCompleted,
        tasksFailed: worker.tasksFailed,
        currentTask: worker.currentTask
      };
    }
    
    // Task stats
    for (const task of this.tasks.values()) {
      stats.tasks[task.status]++;
    }
    
    // Workflow stats
    for (const workflow of this.workflows.values()) {
      if (workflow.status === 'running') {
        stats.workflows.running++;
      } else if (workflow.status === 'completed') {
        stats.workflows.completed++;
      }
    }
    
    return stats;
  }
  
  async shutdown() {
    this.isRunning = false;
    
    // Wait for running tasks to complete
    const timeout = 30000; // 30 seconds
    const startTime = Date.now();
    
    while (this.hasRunningTasks() && (Date.now() - startTime) < timeout) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Shutdown workers
    if (this.config.clustering && this.isPrimary) {
      for (const worker of this.workers.values()) {
        worker.process.send({ type: 'shutdown' });
      }
    }
    
    // Close persistence
    if (this.persistence) {
      await this.persistence.close();
    }
    
    this.emit('shutdown');
  }
  
  hasRunningTasks() {
    for (const task of this.tasks.values()) {
      if (task.status === 'running') {
        return true;
      }
    }
    return false;
  }
}

// Task class
class Task {
  constructor(options) {
    this.id = options.id;
    this.type = options.type;
    this.payload = options.payload;
    this.queue = options.queue;
    this.priority = options.priority;
    this.status = 'pending';
    this.retries = options.retries || 0;
    this.maxRetries = options.maxRetries;
    this.timeout = options.timeout;
    this.scheduledFor = options.scheduledFor;
    this.dependencies = options.dependencies;
    this.metadata = options.metadata;
    this.createdAt = Date.now();
  }
  
  toJSON() {
    return {
      id: this.id,
      type: this.type,
      payload: this.payload,
      queue: this.queue,
      priority: this.priority,
      status: this.status,
      retries: this.retries,
      maxRetries: this.maxRetries,
      timeout: this.timeout,
      scheduledFor: this.scheduledFor,
      dependencies: this.dependencies,
      metadata: this.metadata,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      failedAt: this.failedAt,
      result: this.result,
      lastError: this.lastError
    };
  }
  
  static fromJSON(data) {
    const task = new Task(data);
    Object.assign(task, data);
    return task;
  }
}

// Workflow class
class Workflow {
  constructor(options) {
    this.id = options.id;
    this.name = options.name;
    this.definition = options.definition;
    this.status = options.status;
    this.currentStep = options.currentStep;
    this.results = options.results;
    this.options = options.options;
    this.createdAt = Date.now();
  }
}

// Task Queue implementation
class TaskQueue {
  constructor(options) {
    this.name = options.name;
    this.priority = options.priority;
    this.maxSize = options.maxSize;
    this.items = [];
    this.processing = 0;
  }
  
  enqueue(task) {
    if (this.items.length >= this.maxSize) {
      throw new Error('Queue is full');
    }
    
    if (this.priority) {
      // Insert based on priority
      let inserted = false;
      for (let i = 0; i < this.items.length; i++) {
        if (task.priority > this.items[i].priority) {
          this.items.splice(i, 0, task);
          inserted = true;
          break;
        }
      }
      if (!inserted) {
        this.items.push(task);
      }
    } else {
      this.items.push(task);
    }
  }
  
  dequeue() {
    const task = this.items.shift();
    if (task) {
      this.processing++;
    }
    return task;
  }
  
  remove(task) {
    const index = this.items.findIndex(t => t.id === task.id);
    if (index !== -1) {
      this.items.splice(index, 1);
    }
  }
  
  isEmpty() {
    return this.items.length === 0;
  }
  
  size() {
    return this.items.length;
  }
}

// Metrics collector
class QueueMetrics {
  constructor() {
    this.taskCounts = {
      completed: 0,
      failed: 0,
      retried: 0
    };
    this.taskDurations = [];
    this.queueWaitTimes = [];
  }
  
  recordTaskComplete(task) {
    this.taskCounts.completed++;
    
    if (task.startedAt && task.completedAt) {
      this.taskDurations.push(task.completedAt - task.startedAt);
    }
    
    if (task.createdAt && task.startedAt) {
      this.queueWaitTimes.push(task.startedAt - task.createdAt);
    }
  }
  
  recordTaskFailed(task) {
    this.taskCounts.failed++;
  }
  
  getPerformanceStats() {
    const avgDuration = this.taskDurations.length > 0 ?
      this.taskDurations.reduce((a, b) => a + b, 0) / this.taskDurations.length : 0;
    
    const avgWaitTime = this.queueWaitTimes.length > 0 ?
      this.queueWaitTimes.reduce((a, b) => a + b, 0) / this.queueWaitTimes.length : 0;
    
    return {
      tasksCompleted: this.taskCounts.completed,
      tasksFailed: this.taskCounts.failed,
      averageDuration: avgDuration,
      averageWaitTime: avgWaitTime,
      throughput: this.taskCounts.completed / (Date.now() / 1000)
    };
  }
}

// Persistence implementations (simplified)
class SQLitePersistence {
  async initialize() {
    // Initialize SQLite database
  }
  
  async saveTask(task) {
    // Save task to database
  }
  
  async updateTask(task) {
    // Update task in database
  }
  
  async getPendingTasks() {
    // Get pending tasks from database
    return [];
  }
  
  async close() {
    // Close database connection
  }
}

class RedisPersistence {
  constructor(config) {
    this.config = config;
  }
  
  async initialize() {
    // Initialize Redis connection
  }
  
  async saveTask(task) {
    // Save task to Redis
  }
  
  async updateTask(task) {
    // Update task in Redis
  }
  
  async getPendingTasks() {
    // Get pending tasks from Redis
    return [];
  }
  
  async close() {
    // Close Redis connection
  }
}

class MongoDBPersistence {
  constructor(config) {
    this.config = config;
  }
  
  async initialize() {
    // Initialize MongoDB connection
  }
  
  async saveTask(task) {
    // Save task to MongoDB
  }
  
  async updateTask(task) {
    // Update task in MongoDB
  }
  
  async getPendingTasks() {
    // Get pending tasks from MongoDB
    return [];
  }
  
  async close() {
    // Close MongoDB connection
  }
}

module.exports = DistributedTaskQueueSystem;
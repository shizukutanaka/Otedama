/**
 * Auto-Tuning System - Otedama
 * Intelligent performance optimization through machine learning
 * 
 * Features:
 * - Adaptive parameter tuning
 * - Performance prediction
 * - Workload classification
 * - Reinforcement learning optimization
 * - Multi-objective optimization
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('AutoTuning');

/**
 * Genetic algorithm for parameter optimization
 */
export class GeneticOptimizer {
  constructor(parameters, fitnessFunction) {
    this.parameters = parameters;
    this.fitnessFunction = fitnessFunction;
    
    this.populationSize = 50;
    this.generations = 100;
    this.mutationRate = 0.1;
    this.crossoverRate = 0.7;
    this.eliteSize = 5;
    
    this.population = [];
    this.bestIndividual = null;
    this.bestFitness = -Infinity;
  }
  
  /**
   * Initialize random population
   */
  initializePopulation() {
    this.population = [];
    
    for (let i = 0; i < this.populationSize; i++) {
      const individual = {};
      
      for (const [name, param] of Object.entries(this.parameters)) {
        individual[name] = this.randomValue(param);
      }
      
      this.population.push({
        genes: individual,
        fitness: 0
      });
    }
  }
  
  /**
   * Generate random value for parameter
   */
  randomValue(param) {
    if (param.type === 'int') {
      return Math.floor(Math.random() * (param.max - param.min + 1)) + param.min;
    } else if (param.type === 'float') {
      return Math.random() * (param.max - param.min) + param.min;
    } else if (param.type === 'choice') {
      return param.choices[Math.floor(Math.random() * param.choices.length)];
    }
  }
  
  /**
   * Evaluate population fitness
   */
  async evaluateFitness() {
    for (const individual of this.population) {
      individual.fitness = await this.fitnessFunction(individual.genes);
      
      if (individual.fitness > this.bestFitness) {
        this.bestFitness = individual.fitness;
        this.bestIndividual = { ...individual };
      }
    }
    
    // Sort by fitness
    this.population.sort((a, b) => b.fitness - a.fitness);
  }
  
  /**
   * Tournament selection
   */
  tournamentSelect(tournamentSize = 3) {
    const tournament = [];
    
    for (let i = 0; i < tournamentSize; i++) {
      const idx = Math.floor(Math.random() * this.population.length);
      tournament.push(this.population[idx]);
    }
    
    return tournament.reduce((best, current) => 
      current.fitness > best.fitness ? current : best
    );
  }
  
  /**
   * Crossover two parents
   */
  crossover(parent1, parent2) {
    if (Math.random() > this.crossoverRate) {
      return { ...parent1 };
    }
    
    const child = { genes: {}, fitness: 0 };
    
    for (const name of Object.keys(this.parameters)) {
      if (Math.random() < 0.5) {
        child.genes[name] = parent1.genes[name];
      } else {
        child.genes[name] = parent2.genes[name];
      }
    }
    
    return child;
  }
  
  /**
   * Mutate individual
   */
  mutate(individual) {
    for (const [name, param] of Object.entries(this.parameters)) {
      if (Math.random() < this.mutationRate) {
        if (param.type === 'int' || param.type === 'float') {
          // Gaussian mutation
          const range = param.max - param.min;
          const delta = (Math.random() - 0.5) * range * 0.1;
          let newValue = individual.genes[name] + delta;
          
          // Clamp to bounds
          newValue = Math.max(param.min, Math.min(param.max, newValue));
          
          if (param.type === 'int') {
            newValue = Math.floor(newValue);
          }
          
          individual.genes[name] = newValue;
        } else if (param.type === 'choice') {
          individual.genes[name] = this.randomValue(param);
        }
      }
    }
  }
  
  /**
   * Run optimization
   */
  async optimize() {
    this.initializePopulation();
    
    for (let generation = 0; generation < this.generations; generation++) {
      await this.evaluateFitness();
      
      const newPopulation = [];
      
      // Elite preservation
      for (let i = 0; i < this.eliteSize; i++) {
        newPopulation.push({ ...this.population[i] });
      }
      
      // Generate new individuals
      while (newPopulation.length < this.populationSize) {
        const parent1 = this.tournamentSelect();
        const parent2 = this.tournamentSelect();
        
        const child = this.crossover(parent1, parent2);
        this.mutate(child);
        
        newPopulation.push(child);
      }
      
      this.population = newPopulation;
      
      logger.debug(`Generation ${generation}: Best fitness = ${this.bestFitness}`);
    }
    
    return this.bestIndividual.genes;
  }
}

/**
 * Bayesian optimization for continuous parameters
 */
export class BayesianOptimizer {
  constructor(parameters, objectiveFunction) {
    this.parameters = parameters;
    this.objectiveFunction = objectiveFunction;
    
    this.observations = [];
    this.kernel = new MaternKernel();
    this.acquisitionFunction = 'ei'; // Expected Improvement
  }
  
  /**
   * Gaussian process prediction
   */
  predict(X) {
    if (this.observations.length === 0) {
      return { mean: 0, variance: 1 };
    }
    
    // Build kernel matrix
    const K = this.buildKernelMatrix();
    const k = this.buildKernelVector(X);
    
    // Compute mean and variance
    const Kinv = this.invertMatrix(K);
    const y = this.observations.map(obs => obs.value);
    
    const mean = this.dotProduct(k, this.matrixVectorMultiply(Kinv, y));
    const variance = 1 - this.dotProduct(k, this.matrixVectorMultiply(Kinv, k));
    
    return { mean, variance: Math.max(0, variance) };
  }
  
  /**
   * Build kernel matrix
   */
  buildKernelMatrix() {
    const n = this.observations.length;
    const K = Array(n).fill(null).map(() => Array(n).fill(0));
    
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        K[i][j] = this.kernel.compute(
          this.observations[i].params,
          this.observations[j].params
        );
      }
    }
    
    // Add noise term
    for (let i = 0; i < n; i++) {
      K[i][i] += 0.01;
    }
    
    return K;
  }
  
  /**
   * Build kernel vector
   */
  buildKernelVector(X) {
    return this.observations.map(obs => 
      this.kernel.compute(X, obs.params)
    );
  }
  
  /**
   * Expected improvement acquisition function
   */
  expectedImprovement(X) {
    const { mean, variance } = this.predict(X);
    const std = Math.sqrt(variance);
    
    if (std === 0) return 0;
    
    const bestValue = Math.max(...this.observations.map(o => o.value));
    const z = (mean - bestValue) / std;
    
    // Standard normal CDF and PDF
    const cdf = 0.5 * (1 + this.erf(z / Math.sqrt(2)));
    const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
    
    return std * (z * cdf + pdf);
  }
  
  /**
   * Error function approximation
   */
  erf(x) {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;
    
    const sign = x >= 0 ? 1 : -1;
    x = Math.abs(x);
    
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    
    return sign * y;
  }
  
  /**
   * Find next point to evaluate
   */
  suggest() {
    // Random search for acquisition function maximum
    let bestX = null;
    let bestAcq = -Infinity;
    
    for (let i = 0; i < 1000; i++) {
      const X = {};
      
      for (const [name, param] of Object.entries(this.parameters)) {
        X[name] = Math.random() * (param.max - param.min) + param.min;
      }
      
      const acq = this.expectedImprovement(X);
      
      if (acq > bestAcq) {
        bestAcq = acq;
        bestX = X;
      }
    }
    
    return bestX;
  }
  
  /**
   * Update with observation
   */
  observe(params, value) {
    this.observations.push({ params, value });
  }
  
  /**
   * Matrix operations (simplified)
   */
  invertMatrix(A) {
    // Simple matrix inversion for small matrices
    // In production, use a proper linear algebra library
    const n = A.length;
    const I = Array(n).fill(null).map((_, i) => 
      Array(n).fill(0).map((_, j) => i === j ? 1 : 0)
    );
    
    // Gauss-Jordan elimination
    for (let i = 0; i < n; i++) {
      let pivot = A[i][i];
      
      for (let j = 0; j < n; j++) {
        A[i][j] /= pivot;
        I[i][j] /= pivot;
      }
      
      for (let k = 0; k < n; k++) {
        if (k !== i) {
          const factor = A[k][i];
          for (let j = 0; j < n; j++) {
            A[k][j] -= factor * A[i][j];
            I[k][j] -= factor * I[i][j];
          }
        }
      }
    }
    
    return I;
  }
  
  matrixVectorMultiply(A, v) {
    return A.map(row => this.dotProduct(row, v));
  }
  
  dotProduct(a, b) {
    return a.reduce((sum, val, i) => sum + val * b[i], 0);
  }
}

/**
 * Matern kernel for Gaussian process
 */
class MaternKernel {
  constructor(nu = 2.5) {
    this.nu = nu;
    this.lengthScale = 1.0;
  }
  
  compute(x1, x2) {
    const d = this.euclideanDistance(x1, x2);
    
    if (d === 0) return 1;
    
    if (this.nu === 0.5) {
      return Math.exp(-d / this.lengthScale);
    } else if (this.nu === 1.5) {
      const sqrt3d = Math.sqrt(3) * d / this.lengthScale;
      return (1 + sqrt3d) * Math.exp(-sqrt3d);
    } else if (this.nu === 2.5) {
      const sqrt5d = Math.sqrt(5) * d / this.lengthScale;
      return (1 + sqrt5d + sqrt5d * sqrt5d / 3) * Math.exp(-sqrt5d);
    }
    
    // General case (not implemented)
    return Math.exp(-d * d / (2 * this.lengthScale * this.lengthScale));
  }
  
  euclideanDistance(x1, x2) {
    let sum = 0;
    
    for (const key of Object.keys(x1)) {
      const diff = x1[key] - x2[key];
      sum += diff * diff;
    }
    
    return Math.sqrt(sum);
  }
}

/**
 * Reinforcement learning tuner
 */
export class RLTuner {
  constructor(stateSpace, actionSpace) {
    this.stateSpace = stateSpace;
    this.actionSpace = actionSpace;
    
    // Q-learning parameters
    this.learningRate = 0.1;
    this.discountFactor = 0.95;
    this.epsilon = 0.1;
    
    // Q-table
    this.qTable = new Map();
    
    // Experience replay
    this.replayBuffer = [];
    this.replaySize = 10000;
    this.batchSize = 32;
  }
  
  /**
   * Get Q-value
   */
  getQ(state, action) {
    const key = this.stateActionKey(state, action);
    return this.qTable.get(key) || 0;
  }
  
  /**
   * Set Q-value
   */
  setQ(state, action, value) {
    const key = this.stateActionKey(state, action);
    this.qTable.set(key, value);
  }
  
  /**
   * State-action key
   */
  stateActionKey(state, action) {
    return JSON.stringify({ state, action });
  }
  
  /**
   * Choose action using epsilon-greedy
   */
  chooseAction(state) {
    if (Math.random() < this.epsilon) {
      // Random exploration
      const idx = Math.floor(Math.random() * this.actionSpace.length);
      return this.actionSpace[idx];
    } else {
      // Exploit best action
      let bestAction = this.actionSpace[0];
      let bestQ = this.getQ(state, bestAction);
      
      for (const action of this.actionSpace) {
        const q = this.getQ(state, action);
        if (q > bestQ) {
          bestQ = q;
          bestAction = action;
        }
      }
      
      return bestAction;
    }
  }
  
  /**
   * Update Q-value
   */
  update(state, action, reward, nextState) {
    // Store experience
    this.replayBuffer.push({ state, action, reward, nextState });
    
    if (this.replayBuffer.length > this.replaySize) {
      this.replayBuffer.shift();
    }
    
    // Sample batch for training
    if (this.replayBuffer.length >= this.batchSize) {
      this.trainBatch();
    }
  }
  
  /**
   * Train on batch of experiences
   */
  trainBatch() {
    const batch = this.sampleBatch();
    
    for (const exp of batch) {
      const currentQ = this.getQ(exp.state, exp.action);
      
      // Find max Q-value for next state
      let maxNextQ = -Infinity;
      for (const nextAction of this.actionSpace) {
        const nextQ = this.getQ(exp.nextState, nextAction);
        maxNextQ = Math.max(maxNextQ, nextQ);
      }
      
      // Q-learning update
      const targetQ = exp.reward + this.discountFactor * maxNextQ;
      const newQ = currentQ + this.learningRate * (targetQ - currentQ);
      
      this.setQ(exp.state, exp.action, newQ);
    }
  }
  
  /**
   * Sample batch from replay buffer
   */
  sampleBatch() {
    const batch = [];
    
    for (let i = 0; i < this.batchSize; i++) {
      const idx = Math.floor(Math.random() * this.replayBuffer.length);
      batch.push(this.replayBuffer[idx]);
    }
    
    return batch;
  }
  
  /**
   * Decay exploration rate
   */
  decayEpsilon(decayRate = 0.995) {
    this.epsilon *= decayRate;
    this.epsilon = Math.max(0.01, this.epsilon);
  }
}

/**
 * Auto-tuning system
 */
export class AutoTuningSystem extends EventEmitter {
  constructor(monitor) {
    super();
    
    this.monitor = monitor;
    this.parameters = {};
    this.tuners = new Map();
    this.history = [];
    
    // Current configuration
    this.currentConfig = {};
    this.baselinePerformance = null;
    
    // Tuning state
    this.tuning = false;
    this.tuningInterval = 300000; // 5 minutes
    this.lastTuning = 0;
  }
  
  /**
   * Register tunable parameter
   */
  registerParameter(name, config) {
    this.parameters[name] = {
      type: config.type || 'int',
      min: config.min,
      max: config.max,
      choices: config.choices,
      current: config.default,
      impact: config.impact || 'medium'
    };
    
    this.currentConfig[name] = config.default;
  }
  
  /**
   * Start auto-tuning
   */
  async start() {
    if (this.tuning) return;
    
    this.tuning = true;
    
    // Measure baseline performance
    this.baselinePerformance = await this.measurePerformance();
    
    // Initialize tuners
    this.initializeTuners();
    
    // Start tuning loop
    this.tuningLoop();
    
    logger.info('Auto-tuning system started', {
      parameters: Object.keys(this.parameters).length,
      baseline: this.baselinePerformance
    });
  }
  
  /**
   * Initialize parameter tuners
   */
  initializeTuners() {
    // Group parameters by impact
    const highImpact = {};
    const lowImpact = {};
    
    for (const [name, param] of Object.entries(this.parameters)) {
      if (param.impact === 'high') {
        highImpact[name] = param;
      } else {
        lowImpact[name] = param;
      }
    }
    
    // Use Bayesian optimization for high-impact parameters
    if (Object.keys(highImpact).length > 0) {
      this.tuners.set('high', new BayesianOptimizer(
        highImpact,
        (params) => this.evaluateConfig({ ...this.currentConfig, ...params })
      ));
    }
    
    // Use genetic algorithm for low-impact parameters
    if (Object.keys(lowImpact).length > 0) {
      this.tuners.set('low', new GeneticOptimizer(
        lowImpact,
        (params) => this.evaluateConfig({ ...this.currentConfig, ...params })
      ));
    }
  }
  
  /**
   * Tuning loop
   */
  async tuningLoop() {
    while (this.tuning) {
      const now = Date.now();
      
      if (now - this.lastTuning >= this.tuningInterval) {
        await this.tune();
        this.lastTuning = now;
      }
      
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
  
  /**
   * Perform tuning iteration
   */
  async tune() {
    logger.info('Starting tuning iteration');
    
    // High-impact parameters (Bayesian optimization)
    const highTuner = this.tuners.get('high');
    if (highTuner) {
      const suggestion = highTuner.suggest();
      const performance = await this.evaluateConfig({
        ...this.currentConfig,
        ...suggestion
      });
      
      highTuner.observe(suggestion, performance);
      
      if (performance > this.baselinePerformance * 1.05) {
        Object.assign(this.currentConfig, suggestion);
        this.emit('config-updated', this.currentConfig);
      }
    }
    
    // Low-impact parameters (Genetic algorithm)
    const lowTuner = this.tuners.get('low');
    if (lowTuner && Math.random() < 0.2) { // Less frequent
      const optimized = await lowTuner.optimize();
      const performance = await this.evaluateConfig({
        ...this.currentConfig,
        ...optimized
      });
      
      if (performance > this.baselinePerformance) {
        Object.assign(this.currentConfig, optimized);
        this.emit('config-updated', this.currentConfig);
      }
    }
    
    // Record history
    this.history.push({
      timestamp: Date.now(),
      config: { ...this.currentConfig },
      performance: await this.measurePerformance()
    });
    
    // Keep only recent history
    if (this.history.length > 1000) {
      this.history.shift();
    }
  }
  
  /**
   * Evaluate configuration
   */
  async evaluateConfig(config) {
    // Apply configuration
    this.emit('apply-config', config);
    
    // Wait for system to stabilize
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Measure performance
    return this.measurePerformance();
  }
  
  /**
   * Measure current performance
   */
  async measurePerformance() {
    const snapshot = this.monitor.getSnapshot();
    const metrics = snapshot.metrics;
    
    // Composite performance score
    let score = 0;
    let weights = 0;
    
    // Throughput (higher is better)
    if (metrics['requests_per_second']) {
      const throughput = metrics['requests_per_second'].stats.mean;
      score += throughput * 1.0;
      weights += 1.0;
    }
    
    // Latency (lower is better)
    if (metrics['request_latency']) {
      const latency = metrics['request_latency'].stats.p95;
      score += (1000 / latency) * 0.5; // Inverse for scoring
      weights += 0.5;
    }
    
    // CPU usage (lower is better)
    if (metrics['system.cpu']) {
      const cpu = metrics['system.cpu'].stats.mean;
      score += (100 - cpu) * 0.3;
      weights += 0.3;
    }
    
    // Memory usage (lower is better)
    if (metrics['system.memory']) {
      const memory = metrics['system.memory'].stats.mean;
      score += (100 - memory) * 0.2;
      weights += 0.2;
    }
    
    return weights > 0 ? score / weights : 0;
  }
  
  /**
   * Get tuning recommendations
   */
  getRecommendations() {
    if (this.history.length < 10) {
      return [];
    }
    
    const recommendations = [];
    const recent = this.history.slice(-50);
    
    // Find best performing configuration
    const best = recent.reduce((best, current) => 
      current.performance > best.performance ? current : best
    );
    
    // Compare with current
    for (const [param, value] of Object.entries(best.config)) {
      if (value !== this.currentConfig[param]) {
        recommendations.push({
          parameter: param,
          current: this.currentConfig[param],
          recommended: value,
          expectedImprovement: ((best.performance / this.baselinePerformance) - 1) * 100
        });
      }
    }
    
    return recommendations;
  }
  
  /**
   * Stop auto-tuning
   */
  stop() {
    this.tuning = false;
    logger.info('Auto-tuning system stopped');
  }
}

export default {
  AutoTuningSystem,
  GeneticOptimizer,
  BayesianOptimizer,
  RLTuner
};
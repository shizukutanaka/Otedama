package optimization

import (
	"crypto/rand"
	"fmt"
	"math"
	"math/big"
	"sort"
	"sync"
	"time"

	"go.uber.org/zap"
)

type GeneticOptimizer struct {
	logger     *zap.Logger
	config     *GeneticConfig
	mu         sync.RWMutex
	
	// Population management
	populations map[string]*Population
	
	// Optimization history
	optimizationHistory []*OptimizationRun
	
	// Performance metrics
	metrics    *GeneticMetrics
}

type GeneticConfig struct {
	PopulationSize    int     `json:"population_size"`
	MaxGenerations    int     `json:"max_generations"`
	MutationRate      float64 `json:"mutation_rate"`
	CrossoverRate     float64 `json:"crossover_rate"`
	ElitismRate       float64 `json:"elitism_rate"`
	TournamentSize    int     `json:"tournament_size"`
	ConvergenceThreshold float64 `json:"convergence_threshold"`
	MaxStagnation     int     `json:"max_stagnation"`
	ParallelEvaluations bool  `json:"parallel_evaluations"`
}

type Population struct {
	DeviceType     string        `json:"device_type"`
	Algorithm      string        `json:"algorithm"`
	Individuals    []*Individual `json:"individuals"`
	Generation     int           `json:"generation"`
	BestFitness    float64       `json:"best_fitness"`
	AverageFitness float64       `json:"average_fitness"`
	Diversity      float64       `json:"diversity"`
	StagnationCount int          `json:"stagnation_count"`
	CreatedAt      time.Time     `json:"created_at"`
	LastUpdated    time.Time     `json:"last_updated"`
}

type Individual struct {
	Genes        []float64     `json:"genes"`
	Settings     DeviceSettings `json:"settings"`
	Fitness      float64       `json:"fitness"`
	Age          int           `json:"age"`
	Evaluated    bool          `json:"evaluated"`
}

type OptimizationRun struct {
	DeviceID       string        `json:"device_id"`
	DeviceType     string        `json:"device_type"`
	Algorithm      string        `json:"algorithm"`
	StartTime      time.Time     `json:"start_time"`
	EndTime        time.Time     `json:"end_time"`
	Generations    int           `json:"generations"`
	BestFitness    float64       `json:"best_fitness"`
	InitialFitness float64       `json:"initial_fitness"`
	Improvement    float64       `json:"improvement"`
	BestSettings   DeviceSettings `json:"best_settings"`
	ConvergedEarly bool          `json:"converged_early"`
}

type GeneticMetrics struct {
	mu                   sync.RWMutex
	TotalOptimizations   int64         `json:"total_optimizations"`
	SuccessfulRuns       int64         `json:"successful_runs"`
	AverageGenerations   float64       `json:"average_generations"`
	AverageImprovement   float64       `json:"average_improvement"`
	BestImprovement      float64       `json:"best_improvement"`
	TotalComputeTime     time.Duration `json:"total_compute_time"`
	ConvergenceRate      float64       `json:"convergence_rate"`
}

type GeneRange struct {
	Min    float64 `json:"min"`
	Max    float64 `json:"max"`
	Step   float64 `json:"step"`
	Type   string  `json:"type"` // "int", "float", "bool"
}

func NewGeneticOptimizer(logger *zap.Logger, engineConfig *EngineConfig) *GeneticOptimizer {
	config := &GeneticConfig{
		PopulationSize:       50,
		MaxGenerations:       100,
		MutationRate:         0.1,
		CrossoverRate:        0.8,
		ElitismRate:          0.1,
		TournamentSize:       5,
		ConvergenceThreshold: 0.001,
		MaxStagnation:        20,
		ParallelEvaluations:  true,
	}
	
	return &GeneticOptimizer{
		logger:              logger,
		config:              config,
		populations:         make(map[string]*Population),
		optimizationHistory: make([]*OptimizationRun, 0),
		metrics:             &GeneticMetrics{},
	}
}

func (ga *GeneticOptimizer) OptimizeSettings(device *DeviceState) (DeviceSettings, float64, error) {
	startTime := time.Now()
	
	populationKey := fmt.Sprintf("%s_%s", device.Type, device.CurrentAlgorithm)
	
	// Get or create population
	population := ga.getOrCreatePopulation(device, populationKey)
	
	// Initialize if this is a new population
	if len(population.Individuals) == 0 {
		err := ga.initializePopulation(population, device)
		if err != nil {
			return device.Settings, 0, fmt.Errorf("failed to initialize population: %w", err)
		}
	}
	
	// Run genetic algorithm
	run := &OptimizationRun{
		DeviceID:       device.ID,
		DeviceType:     device.Type,
		Algorithm:      device.CurrentAlgorithm,
		StartTime:      startTime,
		InitialFitness: ga.evaluateSettings(device, device.Settings),
	}
	
	bestIndividual, err := ga.evolvePopulation(population, device, run)
	if err != nil {
		return device.Settings, 0, fmt.Errorf("evolution failed: %w", err)
	}
	
	// Complete optimization run
	run.EndTime = time.Now()
	run.BestFitness = bestIndividual.Fitness
	run.BestSettings = bestIndividual.Settings
	run.Improvement = (run.BestFitness - run.InitialFitness) / run.InitialFitness * 100
	run.Generations = population.Generation
	
	// Update metrics
	ga.updateMetrics(run)
	
	// Store optimization history
	ga.mu.Lock()
	ga.optimizationHistory = append(ga.optimizationHistory, run)
	if len(ga.optimizationHistory) > 1000 {
		ga.optimizationHistory = ga.optimizationHistory[100:] // Keep recent 900
	}
	ga.mu.Unlock()
	
	ga.logger.Info("Genetic optimization completed",
		zap.String("device_id", device.ID),
		zap.Int("generations", run.Generations),
		zap.Float64("improvement", run.Improvement),
		zap.Duration("duration", run.EndTime.Sub(run.StartTime)))
	
	return bestIndividual.Settings, run.Improvement, nil
}

func (ga *GeneticOptimizer) getOrCreatePopulation(device *DeviceState, key string) *Population {
	ga.mu.Lock()
	defer ga.mu.Unlock()
	
	population, exists := ga.populations[key]
	if !exists {
		population = &Population{
			DeviceType:     device.Type,
			Algorithm:      device.CurrentAlgorithm,
			Individuals:    make([]*Individual, 0),
			Generation:     0,
			CreatedAt:      time.Now(),
			LastUpdated:    time.Now(),
		}
		ga.populations[key] = population
	}
	
	return population
}

func (ga *GeneticOptimizer) initializePopulation(population *Population, device *DeviceState) error {
	geneRanges := ga.getGeneRanges(device.Type)
	
	population.Individuals = make([]*Individual, ga.config.PopulationSize)
	
	for i := 0; i < ga.config.PopulationSize; i++ {
		individual := &Individual{
			Genes:     ga.generateRandomGenes(geneRanges),
			Age:       0,
			Evaluated: false,
		}
		
		individual.Settings = ga.genesToSettings(individual.Genes, device.Type)
		population.Individuals[i] = individual
	}
	
	// Add current settings as one of the individuals
	if len(population.Individuals) > 0 {
		currentGenes := ga.settingsToGenes(device.Settings, device.Type)
		population.Individuals[0].Genes = currentGenes
		population.Individuals[0].Settings = device.Settings
	}
	
	ga.logger.Info("Population initialized",
		zap.String("device_type", device.Type),
		zap.String("algorithm", device.CurrentAlgorithm),
		zap.Int("size", len(population.Individuals)))
	
	return nil
}

func (ga *GeneticOptimizer) evolvePopulation(population *Population, device *DeviceState, run *OptimizationRun) (*Individual, error) {
	var bestIndividual *Individual
	lastBestFitness := -math.Inf(1)
	
	for generation := 0; generation < ga.config.MaxGenerations; generation++ {
		population.Generation = generation
		
		// Evaluate population
		err := ga.evaluatePopulation(population, device)
		if err != nil {
			return nil, fmt.Errorf("evaluation failed at generation %d: %w", generation, err)
		}
		
		// Find best individual
		currentBest := ga.getBestIndividual(population)
		if bestIndividual == nil || currentBest.Fitness > bestIndividual.Fitness {
			bestIndividual = ga.copyIndividual(currentBest)
		}
		
		// Update population statistics
		ga.updatePopulationStats(population)
		
		// Check for convergence
		improvement := population.BestFitness - lastBestFitness
		if improvement < ga.config.ConvergenceThreshold {
			population.StagnationCount++
		} else {
			population.StagnationCount = 0
		}
		
		if population.StagnationCount >= ga.config.MaxStagnation {
			run.ConvergedEarly = true
			ga.logger.Info("Early convergence detected",
				zap.Int("generation", generation),
				zap.Float64("fitness", population.BestFitness))
			break
		}
		
		lastBestFitness = population.BestFitness
		
		// Create next generation
		if generation < ga.config.MaxGenerations-1 {
			err = ga.createNextGeneration(population, device)
			if err != nil {
				return nil, fmt.Errorf("failed to create next generation: %w", err)
			}
		}
		
		// Log progress
		if generation%10 == 0 {
			ga.logger.Debug("Generation progress",
				zap.Int("generation", generation),
				zap.Float64("best_fitness", population.BestFitness),
				zap.Float64("avg_fitness", population.AverageFitness),
				zap.Float64("diversity", population.Diversity))
		}
	}
	
	population.LastUpdated = time.Now()
	
	if bestIndividual == nil {
		return nil, fmt.Errorf("no valid individual found")
	}
	
	return bestIndividual, nil
}

func (ga *GeneticOptimizer) evaluatePopulation(population *Population, device *DeviceState) error {
	if ga.config.ParallelEvaluations {
		return ga.evaluatePopulationParallel(population, device)
	}
	
	return ga.evaluatePopulationSequential(population, device)
}

func (ga *GeneticOptimizer) evaluatePopulationSequential(population *Population, device *DeviceState) error {
	for _, individual := range population.Individuals {
		if !individual.Evaluated {
			individual.Fitness = ga.evaluateSettings(device, individual.Settings)
			individual.Evaluated = true
		}
	}
	return nil
}

func (ga *GeneticOptimizer) evaluatePopulationParallel(population *Population, device *DeviceState) error {
	const maxWorkers = 10
	
	// Channel for individuals to evaluate
	jobs := make(chan *Individual, len(population.Individuals))
	
	// Worker pool
	var wg sync.WaitGroup
	workerCount := maxWorkers
	if len(population.Individuals) < maxWorkers {
		workerCount = len(population.Individuals)
	}
	
	for w := 0; w < workerCount; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for individual := range jobs {
				if !individual.Evaluated {
					individual.Fitness = ga.evaluateSettings(device, individual.Settings)
					individual.Evaluated = true
				}
			}
		}()
	}
	
	// Send jobs
	for _, individual := range population.Individuals {
		jobs <- individual
	}
	close(jobs)
	
	// Wait for completion
	wg.Wait()
	
	return nil
}

func (ga *GeneticOptimizer) evaluateSettings(device *DeviceState, settings DeviceSettings) float64 {
	// Multi-objective fitness function
	
	// Predict hashrate with these settings
	predictedHashrate := ga.predictHashrate(device, settings)
	
	// Predict power consumption
	predictedPower := ga.predictPower(device, settings)
	
	// Predict temperature
	predictedTemp := ga.predictTemperature(device, settings)
	
	// Calculate fitness components
	hashrateScore := predictedHashrate / (device.Performance.Hashrate + 1) // Normalized improvement
	
	powerScore := 1.0
	if predictedPower > 0 {
		powerScore = math.Min(1.0, device.Power.CurrentPower/predictedPower) // Prefer lower power
	}
	
	tempScore := 1.0
	if predictedTemp > 85 { // Thermal penalty
		tempScore = math.Max(0.1, (100-predictedTemp)/15)
	}
	
	stabilityScore := ga.predictStability(device, settings)
	
	// Weighted combination
	fitness := hashrateScore*0.4 + powerScore*0.2 + tempScore*0.2 + stabilityScore*0.2
	
	// Apply constraints
	if predictedTemp > 95 || predictedPower > device.Power.PowerLimit*1.1 {
		fitness *= 0.1 // Heavy penalty for dangerous settings
	}
	
	return fitness
}

func (ga *GeneticOptimizer) predictHashrate(device *DeviceState, settings DeviceSettings) float64 {
	// Simplified prediction model
	baseHashrate := device.Performance.Hashrate
	
	// Intensity impact
	intensityFactor := float64(settings.Intensity) / float64(device.Settings.Intensity)
	
	// Clock impacts
	coreClockFactor := 1.0
	if device.Settings.CoreClock > 0 {
		coreClockFactor = float64(settings.CoreClock) / float64(device.Settings.CoreClock)
	}
	
	memClockFactor := 1.0
	if device.Settings.MemoryClock > 0 && device.Type == "GPU" {
		memClockFactor = float64(settings.MemoryClock) / float64(device.Settings.MemoryClock)
	}
	
	// Combined impact with diminishing returns
	combinedFactor := intensityFactor*0.4 + coreClockFactor*0.3 + memClockFactor*0.3
	efficiency := 1.0 - (combinedFactor-1.0)*0.1 // Diminishing returns
	
	return baseHashrate * combinedFactor * efficiency
}

func (ga *GeneticOptimizer) predictPower(device *DeviceState, settings DeviceSettings) float64 {
	basePower := device.Power.CurrentPower
	
	// Power scales with intensity and clocks
	intensityFactor := float64(settings.Intensity) / float64(device.Settings.Intensity)
	
	coreClockFactor := 1.0
	if device.Settings.CoreClock > 0 {
		coreClockFactor = float64(settings.CoreClock) / float64(device.Settings.CoreClock)
	}
	
	// Power consumption is typically quadratic with clock speeds
	powerFactor := intensityFactor*0.5 + math.Pow(coreClockFactor, 1.8)*0.5
	
	// Apply power limit constraint
	predictedPower := basePower * powerFactor
	if settings.PowerLimit > 0 {
		predictedPower = math.Min(predictedPower, float64(settings.PowerLimit))
	}
	
	return predictedPower
}

func (ga *GeneticOptimizer) predictTemperature(device *DeviceState, settings DeviceSettings) float64 {
	baseTemp := device.Thermal.CoreTemp
	
	// Temperature increases with power and decreases with fan speed
	powerIncrease := ga.predictPower(device, settings) - device.Power.CurrentPower
	tempIncrease := powerIncrease * 0.02 // Rough approximation: 2°C per 100W
	
	fanFactor := 1.0
	if device.Settings.FanSpeed > 0 {
		fanFactor = float64(device.Settings.FanSpeed) / float64(settings.FanSpeed)
	}
	
	predictedTemp := baseTemp + tempIncrease*fanFactor
	
	return math.Max(20, predictedTemp) // Minimum room temperature
}

func (ga *GeneticOptimizer) predictStability(device *DeviceState, settings DeviceSettings) float64 {
	// Stability decreases with aggressive settings
	currentStability := 1.0 - device.Performance.ErrorRate
	
	// Penalty for extreme settings
	intensityPenalty := 0.0
	if settings.Intensity > device.Settings.Intensity*1.5 {
		intensityPenalty = 0.2
	}
	
	clockPenalty := 0.0
	if device.Type == "GPU" {
		coreIncrease := float64(settings.CoreClock-device.Settings.CoreClock) / 1000
		memIncrease := float64(settings.MemoryClock-device.Settings.MemoryClock) / 1000
		clockPenalty = math.Max(0, (coreIncrease+memIncrease)*0.1)
	}
	
	predictedStability := currentStability - intensityPenalty - clockPenalty
	
	return math.Max(0.1, math.Min(1.0, predictedStability))
}

func (ga *GeneticOptimizer) createNextGeneration(population *Population, device *DeviceState) error {
	newIndividuals := make([]*Individual, 0, ga.config.PopulationSize)
	
	// Elitism: keep best individuals
	eliteCount := int(float64(ga.config.PopulationSize) * ga.config.ElitismRate)
	sortedIndividuals := ga.sortIndividualsByFitness(population.Individuals)
	
	for i := 0; i < eliteCount && i < len(sortedIndividuals); i++ {
		elite := ga.copyIndividual(sortedIndividuals[i])
		elite.Age++
		newIndividuals = append(newIndividuals, elite)
	}
	
	// Generate offspring through crossover and mutation
	for len(newIndividuals) < ga.config.PopulationSize {
		// Tournament selection
		parent1 := ga.tournamentSelection(population)
		parent2 := ga.tournamentSelection(population)
		
		// Crossover
		var offspring1, offspring2 *Individual
		if rand.Float64() < ga.config.CrossoverRate {
			offspring1, offspring2 = ga.crossover(parent1, parent2, device.Type)
		} else {
			offspring1 = ga.copyIndividual(parent1)
			offspring2 = ga.copyIndividual(parent2)
		}
		
		// Mutation
		if rand.Float64() < ga.config.MutationRate {
			ga.mutate(offspring1, device.Type)
		}
		if rand.Float64() < ga.config.MutationRate {
			ga.mutate(offspring2, device.Type)
		}
		
		offspring1.Age = 0
		offspring1.Evaluated = false
		offspring2.Age = 0
		offspring2.Evaluated = false
		
		newIndividuals = append(newIndividuals, offspring1)
		if len(newIndividuals) < ga.config.PopulationSize {
			newIndividuals = append(newIndividuals, offspring2)
		}
	}
	
	population.Individuals = newIndividuals
	return nil
}

func (ga *GeneticOptimizer) tournamentSelection(population *Population) *Individual {
	tournamentSize := ga.config.TournamentSize
	if tournamentSize > len(population.Individuals) {
		tournamentSize = len(population.Individuals)
	}
	
	var best *Individual
	
	for i := 0; i < tournamentSize; i++ {
		candidate := population.Individuals[rand.Intn(len(population.Individuals))]
		if best == nil || candidate.Fitness > best.Fitness {
			best = candidate
		}
	}
	
	return best
}

func (ga *GeneticOptimizer) crossover(parent1, parent2 *Individual, deviceType string) (*Individual, *Individual) {
	// Single-point crossover
	crossoverPoint := rand.Intn(len(parent1.Genes))
	
	offspring1 := &Individual{
		Genes: make([]float64, len(parent1.Genes)),
		Age:   0,
	}
	
	offspring2 := &Individual{
		Genes: make([]float64, len(parent2.Genes)),
		Age:   0,
	}
	
	// Copy genes
	for i := 0; i < len(parent1.Genes); i++ {
		if i < crossoverPoint {
			offspring1.Genes[i] = parent1.Genes[i]
			offspring2.Genes[i] = parent2.Genes[i]
		} else {
			offspring1.Genes[i] = parent2.Genes[i]
			offspring2.Genes[i] = parent1.Genes[i]
		}
	}
	
	// Convert genes to settings
	offspring1.Settings = ga.genesToSettings(offspring1.Genes, deviceType)
	offspring2.Settings = ga.genesToSettings(offspring2.Genes, deviceType)
	
	return offspring1, offspring2
}

func (ga *GeneticOptimizer) mutate(individual *Individual, deviceType string) {
	geneRanges := ga.getGeneRanges(deviceType)
	
	for i := range individual.Genes {
		if rand.Float64() < 0.1 { // 10% chance to mutate each gene
			geneRange := geneRanges[i]
			
			// Gaussian mutation
			mutation := rand.NormFloat64() * 0.1 * (geneRange.Max - geneRange.Min)
			individual.Genes[i] += mutation
			
			// Clamp to valid range
			individual.Genes[i] = math.Max(geneRange.Min, math.Min(geneRange.Max, individual.Genes[i]))
		}
	}
	
	// Convert mutated genes back to settings
	individual.Settings = ga.genesToSettings(individual.Genes, deviceType)
}

func (ga *GeneticOptimizer) getGeneRanges(deviceType string) []GeneRange {
	switch deviceType {
	case "GPU":
		return []GeneRange{
			{Min: 1, Max: 31, Step: 1, Type: "int"},     // Intensity
			{Min: 800, Max: 2200, Step: 25, Type: "int"}, // Core clock
			{Min: 800, Max: 2500, Step: 50, Type: "int"}, // Memory clock
			{Min: 50, Max: 400, Step: 10, Type: "int"},    // Power limit
			{Min: 30, Max: 100, Step: 5, Type: "int"},     // Fan speed
		}
	case "CPU":
		return []GeneRange{
			{Min: 1, Max: 16, Step: 1, Type: "int"},       // Intensity
			{Min: 1, Max: 64, Step: 1, Type: "int"},       // Threads
			{Min: 1000, Max: 5000, Step: 100, Type: "int"}, // Frequency
		}
	case "ASIC":
		return []GeneRange{
			{Min: 1, Max: 1, Step: 1, Type: "int"},        // Intensity (fixed)
			{Min: 500, Max: 900, Step: 25, Type: "int"},   // Frequency
			{Min: 30, Max: 100, Step: 5, Type: "int"},     // Fan speed
		}
	default:
		return []GeneRange{
			{Min: 1, Max: 20, Step: 1, Type: "int"},
		}
	}
}

func (ga *GeneticOptimizer) generateRandomGenes(ranges []GeneRange) []float64 {
	genes := make([]float64, len(ranges))
	
	for i, geneRange := range ranges {
		switch geneRange.Type {
		case "int":
			min := int(geneRange.Min)
			max := int(geneRange.Max)
			genes[i] = float64(min + rand.Intn(max-min+1))
		case "float":
			genes[i] = geneRange.Min + rand.Float64()*(geneRange.Max-geneRange.Min)
		case "bool":
			genes[i] = 0
			if rand.Float64() < 0.5 {
				genes[i] = 1
			}
		}
	}
	
	return genes
}

func (ga *GeneticOptimizer) genesToSettings(genes []float64, deviceType string) DeviceSettings {
	settings := DeviceSettings{}
	
	switch deviceType {
	case "GPU":
		if len(genes) >= 5 {
			settings.Intensity = int(genes[0])
			settings.CoreClock = int(genes[1])
			settings.MemoryClock = int(genes[2])
			settings.PowerLimit = int(genes[3])
			settings.FanSpeed = int(genes[4])
		}
	case "CPU":
		if len(genes) >= 3 {
			settings.Intensity = int(genes[0])
			settings.Threads = int(genes[1])
			settings.CoreClock = int(genes[2]) // CPU frequency
		}
	case "ASIC":
		if len(genes) >= 3 {
			settings.Intensity = int(genes[0])
			settings.CoreClock = int(genes[1]) // ASIC frequency
			settings.FanSpeed = int(genes[2])
		}
	}
	
	return settings
}

func (ga *GeneticOptimizer) settingsToGenes(settings DeviceSettings, deviceType string) []float64 {
	switch deviceType {
	case "GPU":
		return []float64{
			float64(settings.Intensity),
			float64(settings.CoreClock),
			float64(settings.MemoryClock),
			float64(settings.PowerLimit),
			float64(settings.FanSpeed),
		}
	case "CPU":
		return []float64{
			float64(settings.Intensity),
			float64(settings.Threads),
			float64(settings.CoreClock),
		}
	case "ASIC":
		return []float64{
			float64(settings.Intensity),
			float64(settings.CoreClock),
			float64(settings.FanSpeed),
		}
	default:
		return []float64{float64(settings.Intensity)}
	}
}

func (ga *GeneticOptimizer) getBestIndividual(population *Population) *Individual {
	if len(population.Individuals) == 0 {
		return nil
	}
	
	best := population.Individuals[0]
	for _, individual := range population.Individuals[1:] {
		if individual.Fitness > best.Fitness {
			best = individual
		}
	}
	
	return best
}

func (ga *GeneticOptimizer) sortIndividualsByFitness(individuals []*Individual) []*Individual {
	sorted := make([]*Individual, len(individuals))
	copy(sorted, individuals)
	
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i].Fitness > sorted[j].Fitness
	})
	
	return sorted
}

func (ga *GeneticOptimizer) copyIndividual(original *Individual) *Individual {
	copy := &Individual{
		Genes:     make([]float64, len(original.Genes)),
		Settings:  original.Settings,
		Fitness:   original.Fitness,
		Age:       original.Age,
		Evaluated: original.Evaluated,
	}
	
	copy.Genes = append(copy.Genes[:0], original.Genes...)
	
	return copy
}

func (ga *GeneticOptimizer) updatePopulationStats(population *Population) {
	if len(population.Individuals) == 0 {
		return
	}
	
	// Calculate best and average fitness
	totalFitness := 0.0
	bestFitness := population.Individuals[0].Fitness
	
	for _, individual := range population.Individuals {
		totalFitness += individual.Fitness
		if individual.Fitness > bestFitness {
			bestFitness = individual.Fitness
		}
	}
	
	population.BestFitness = bestFitness
	population.AverageFitness = totalFitness / float64(len(population.Individuals))
	
	// Calculate diversity (average distance between individuals)
	diversity := 0.0
	count := 0
	
	for i := 0; i < len(population.Individuals); i++ {
		for j := i + 1; j < len(population.Individuals); j++ {
			distance := ga.calculateGeneticDistance(population.Individuals[i], population.Individuals[j])
			diversity += distance
			count++
		}
	}
	
	if count > 0 {
		population.Diversity = diversity / float64(count)
	}
}

func (ga *GeneticOptimizer) calculateGeneticDistance(ind1, ind2 *Individual) float64 {
	if len(ind1.Genes) != len(ind2.Genes) {
		return 1.0 // Maximum distance for incompatible individuals
	}
	
	distance := 0.0
	for i := range ind1.Genes {
		diff := ind1.Genes[i] - ind2.Genes[i]
		distance += diff * diff
	}
	
	return math.Sqrt(distance / float64(len(ind1.Genes)))
}

func (ga *GeneticOptimizer) updateMetrics(run *OptimizationRun) {
	ga.metrics.mu.Lock()
	defer ga.metrics.mu.Unlock()
	
	ga.metrics.TotalOptimizations++
	ga.metrics.TotalComputeTime += run.EndTime.Sub(run.StartTime)
	
	if run.Improvement > 0 {
		ga.metrics.SuccessfulRuns++
		
		// Update average improvement
		totalSuccessful := float64(ga.metrics.SuccessfulRuns)
		ga.metrics.AverageImprovement = (ga.metrics.AverageImprovement*(totalSuccessful-1) + run.Improvement) / totalSuccessful
		
		if run.Improvement > ga.metrics.BestImprovement {
			ga.metrics.BestImprovement = run.Improvement
		}
	}
	
	// Update average generations
	totalOpt := float64(ga.metrics.TotalOptimizations)
	ga.metrics.AverageGenerations = (ga.metrics.AverageGenerations*(totalOpt-1) + float64(run.Generations)) / totalOpt
	
	// Update convergence rate
	if run.ConvergedEarly {
		converged := 0.0
		for _, histRun := range ga.optimizationHistory {
			if histRun.ConvergedEarly {
				converged++
			}
		}
		ga.metrics.ConvergenceRate = converged / float64(len(ga.optimizationHistory))
	}
}

func (ga *GeneticOptimizer) GetMetrics() *GeneticMetrics {
	ga.metrics.mu.RLock()
	defer ga.metrics.mu.RUnlock()
	
	return &GeneticMetrics{
		TotalOptimizations: ga.metrics.TotalOptimizations,
		SuccessfulRuns:     ga.metrics.SuccessfulRuns,
		AverageGenerations: ga.metrics.AverageGenerations,
		AverageImprovement: ga.metrics.AverageImprovement,
		BestImprovement:    ga.metrics.BestImprovement,
		TotalComputeTime:   ga.metrics.TotalComputeTime,
		ConvergenceRate:    ga.metrics.ConvergenceRate,
	}
}

func (ga *GeneticOptimizer) GetPopulationStatus() map[string]*Population {
	ga.mu.RLock()
	defer ga.mu.RUnlock()
	
	status := make(map[string]*Population)
	for key, pop := range ga.populations {
		// Return copy with limited individual data
		status[key] = &Population{
			DeviceType:      pop.DeviceType,
			Algorithm:       pop.Algorithm,
			Generation:      pop.Generation,
			BestFitness:     pop.BestFitness,
			AverageFitness:  pop.AverageFitness,
			Diversity:       pop.Diversity,
			StagnationCount: pop.StagnationCount,
			CreatedAt:       pop.CreatedAt,
			LastUpdated:     pop.LastUpdated,
		}
	}
	
	return status
}

func (ga *GeneticOptimizer) GetOptimizationHistory() []*OptimizationRun {
	ga.mu.RLock()
	defer ga.mu.RUnlock()
	
	// Return copy of recent runs
	recentCount := 50
	if len(ga.optimizationHistory) < recentCount {
		recentCount = len(ga.optimizationHistory)
	}
	
	history := make([]*OptimizationRun, recentCount)
	startIndex := len(ga.optimizationHistory) - recentCount
	copy(history, ga.optimizationHistory[startIndex:])
	
	return history
}
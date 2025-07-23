/**
 * Contextual Translation System
 * 
 * Advanced context-aware translation with domain adaptation
 * Following Rob Pike's simplicity with Martin's clean architecture
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { getErrorHandler, OtedamaError, ErrorCategory } from '../core/standardized-error-handler.js';

export class ContextualTranslationSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      enableContextCache: options.enableContextCache !== false,
      enableDomainAdaptation: options.enableDomainAdaptation !== false,
      enableUserPersonalization: options.enableUserPersonalization !== false,
      enableTemporalContext: options.enableTemporalContext !== false,
      cacheExpiry: options.cacheExpiry || 24 * 60 * 60 * 1000, // 24 hours
      maxContextHistory: options.maxContextHistory || 100,
      ...options
    };
    
    this.errorHandler = getErrorHandler();
    this.contextCache = new Map();
    this.domainKnowledge = new Map();
    this.userProfiles = new Map();
    this.contextHistory = [];
    this.translationContexts = new Map();
    
    // Domain-specific translation rules
    this.domainRules = {
      mining: {
        terminology: new Map([
          ['hashrate', { formal: 'hash rate', informal: 'hashing power' }],
          ['difficulty', { formal: 'mining difficulty', informal: 'diff' }],
          ['shares', { formal: 'mining shares', informal: 'shares' }]
        ]),
        formality: 'technical',
        audience: 'miners'
      },
      dex: {
        terminology: new Map([
          ['slippage', { formal: 'price slippage', informal: 'slip' }],
          ['liquidity', { formal: 'market liquidity', informal: 'liq' }],
          ['orderbook', { formal: 'order book', informal: 'book' }]
        ]),
        formality: 'business',
        audience: 'traders'
      },
      defi: {
        terminology: new Map([
          ['yield', { formal: 'annual percentage yield', informal: 'APY' }],
          ['staking', { formal: 'token staking', informal: 'staking' }],
          ['governance', { formal: 'protocol governance', informal: 'voting' }]
        ]),
        formality: 'technical',
        audience: 'defi_users'
      }
    };
    
    this.initialize();
  }
  
  /**
   * Initialize contextual translation system
   */
  async initialize() {
    try {
      // Load domain knowledge
      await this.loadDomainKnowledge();
      
      // Setup context tracking
      this.setupContextTracking();
      
      this.emit('initialized');
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'contextual-translation',
        category: ErrorCategory.INITIALIZATION
      });
    }
  }
  
  /**
   * Translate with context awareness
   */
  async translateWithContext(key, options = {}) {
    try {
      const context = this.buildTranslationContext(options);
      const cacheKey = this.generateContextCacheKey(key, context);
      
      // Check context cache first
      if (this.options.enableContextCache && this.contextCache.has(cacheKey)) {
        const cached = this.contextCache.get(cacheKey);
        if (Date.now() - cached.timestamp < this.options.cacheExpiry) {
          this.emit('translation:cache_hit', { key, context });
          return cached.translation;
        }
      }
      
      // Get base translation
      const baseTranslation = await this.getBaseTranslation(key, context.language);
      
      // Apply contextual modifications
      const contextualTranslation = await this.applyContextualModifications(
        baseTranslation,
        context
      );
      
      // Cache the result
      if (this.options.enableContextCache) {
        this.contextCache.set(cacheKey, {
          translation: contextualTranslation,
          timestamp: Date.now(),
          context: { ...context }
        });
      }
      
      // Track context usage
      this.trackContextUsage(key, context);
      
      this.emit('translation:contextual', {
        key,
        baseTranslation,
        contextualTranslation,
        context
      });
      
      return contextualTranslation;
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'contextual-translation',
        category: ErrorCategory.TRANSLATION,
        key,
        context: options
      });
      
      // Fallback to base translation
      return await this.getBaseTranslation(key, options.language || 'en');
    }
  }
  
  /**
   * Build comprehensive translation context
   */
  buildTranslationContext(options) {
    const context = {
      // Basic context
      language: options.language || 'en',
      domain: options.domain || 'general',
      formality: options.formality || 'neutral',
      audience: options.audience || 'general',
      
      // Advanced context
      userId: options.userId,
      sessionId: options.sessionId,
      timestamp: Date.now(),
      
      // UI context
      component: options.component,
      screen: options.screen,
      action: options.action,
      
      // Business context
      feature: options.feature,
      userRole: options.userRole,
      subscription: options.subscription,
      
      // Technical context
      platform: options.platform,
      deviceType: options.deviceType,
      
      // Temporal context
      timeOfDay: this.getTimeOfDay(),
      dayOfWeek: this.getDayOfWeek(),
      
      // Custom context
      ...options.custom
    };
    
    // Enhance with user profile if available
    if (this.options.enableUserPersonalization && context.userId) {
      const userProfile = this.getUserProfile(context.userId);
      if (userProfile) {
        context.userPreferences = userProfile.preferences;
        context.userExperience = userProfile.experience;
        context.preferredFormality = userProfile.formality;
      }
    }
    
    // Enhance with domain knowledge
    if (this.options.enableDomainAdaptation && this.domainRules[context.domain]) {
      context.domainRules = this.domainRules[context.domain];
    }
    
    return context;
  }
  
  /**
   * Apply contextual modifications to translation
   */
  async applyContextualModifications(baseTranslation, context) {
    let translation = baseTranslation;
    
    // Apply domain-specific modifications
    if (context.domainRules) {
      translation = this.applyDomainModifications(translation, context);
    }
    
    // Apply formality adjustments
    translation = this.applyFormalityModifications(translation, context);
    
    // Apply audience-specific modifications
    translation = this.applyAudienceModifications(translation, context);
    
    // Apply user personalization
    if (context.userPreferences) {
      translation = this.applyPersonalization(translation, context);
    }
    
    // Apply temporal context
    if (this.options.enableTemporalContext) {
      translation = this.applyTemporalModifications(translation, context);
    }
    
    return translation;
  }
  
  /**
   * Apply domain-specific modifications
   */
  applyDomainModifications(translation, context) {
    if (!context.domainRules || !context.domainRules.terminology) {
      return translation;
    }
    
    let modifiedTranslation = translation;
    
    // Replace domain-specific terms
    for (const [term, variants] of context.domainRules.terminology) {
      const pattern = new RegExp(`\\b${term}\\b`, 'gi');
      
      if (pattern.test(modifiedTranslation)) {
        const variant = variants[context.formality] || variants.formal || term;
        modifiedTranslation = modifiedTranslation.replace(pattern, variant);
      }
    }
    
    return modifiedTranslation;
  }
  
  /**
   * Apply formality adjustments
   */
  applyFormalityModifications(translation, context) {
    const formality = context.preferredFormality || context.formality;
    
    if (formality === 'formal') {
      return this.makeFormal(translation, context.language);
    } else if (formality === 'informal') {
      return this.makeInformal(translation, context.language);
    }
    
    return translation;
  }
  
  /**
   * Make translation more formal
   */
  makeFormal(translation, language) {
    const formalizations = {
      'en': [
        { pattern: /\\bcan't\\b/gi, replacement: 'cannot' },
        { pattern: /\\bwon't\\b/gi, replacement: 'will not' },
        { pattern: /\\bdon't\\b/gi, replacement: 'do not' },
        { pattern: /\\bisn't\\b/gi, replacement: 'is not' },
        { pattern: /\\baren't\\b/gi, replacement: 'are not' },
        { pattern: /\\bit's\\b/gi, replacement: 'it is' },
        { pattern: /\\bthat's\\b/gi, replacement: 'that is' }
      ],
      'ja': [
        { pattern: /である/g, replacement: 'でございます' },
        { pattern: /だ$/g, replacement: 'です' },
        { pattern: /する/g, replacement: 'いたします' }
      ]
    };
    
    const rules = formalizations[language] || [];
    let formalTranslation = translation;
    
    rules.forEach(rule => {
      formalTranslation = formalTranslation.replace(rule.pattern, rule.replacement);
    });
    
    return formalTranslation;
  }
  
  /**
   * Make translation more informal
   */
  makeInformal(translation, language) {
    const informalizations = {
      'en': [
        { pattern: /\\bcannot\\b/gi, replacement: "can't" },
        { pattern: /\\bwill not\\b/gi, replacement: "won't" },
        { pattern: /\\bdo not\\b/gi, replacement: "don't" },
        { pattern: /\\bis not\\b/gi, replacement: "isn't" },
        { pattern: /\\bare not\\b/gi, replacement: "aren't" }
      ],
      'ja': [
        { pattern: /でございます/g, replacement: 'だよ' },
        { pattern: /です$/g, replacement: 'だ' },
        { pattern: /いたします/g, replacement: 'する' }
      ]
    };
    
    const rules = informalizations[language] || [];
    let informalTranslation = translation;
    
    rules.forEach(rule => {
      informalTranslation = informalTranslation.replace(rule.pattern, rule.replacement);
    });
    
    return informalTranslation;
  }
  
  /**
   * Apply audience-specific modifications
   */
  applyAudienceModifications(translation, context) {
    const audienceAdaptations = {
      beginners: {
        addExplanations: true,
        simplifyTerms: true,
        addHelpfulHints: true
      },
      experts: {
        useTechnicalTerms: true,
        removeExplanations: true,
        useShortcuts: true
      },
      traders: {
        emphasizeNumbers: true,
        useMarketTerms: true,
        addTimeReferences: true
      },
      miners: {
        useTechnicalSpecs: true,
        emphasizePerformance: true,
        addHardwareReferences: true
      }
    };
    
    const adaptation = audienceAdaptations[context.audience];
    if (!adaptation) return translation;
    
    let modifiedTranslation = translation;
    
    // Apply audience-specific adaptations
    if (adaptation.simplifyTerms) {
      modifiedTranslation = this.simplifyTechnicalTerms(modifiedTranslation);
    }
    
    if (adaptation.useTechnicalTerms) {
      modifiedTranslation = this.enhanceWithTechnicalTerms(modifiedTranslation, context.domain);
    }
    
    return modifiedTranslation;
  }
  
  /**
   * Apply user personalization
   */
  applyPersonalization(translation, context) {
    const preferences = context.userPreferences;
    
    if (preferences.preferredTerminology) {
      // Replace terms with user's preferred terminology
      for (const [standard, preferred] of Object.entries(preferences.preferredTerminology)) {
        const pattern = new RegExp(`\\b${standard}\\b`, 'gi');
        translation = translation.replace(pattern, preferred);
      }
    }
    
    if (preferences.culturalAdaptation) {
      translation = this.applyCulturalAdaptation(translation, preferences.culturalAdaptation);
    }
    
    return translation;
  }
  
  /**
   * Apply temporal modifications
   */
  applyTemporalModifications(translation, context) {
    const timeContext = {
      hour: new Date().getHours(),
      dayOfWeek: new Date().getDay(),
      isWeekend: [0, 6].includes(new Date().getDay())
    };
    
    // Add time-sensitive greetings or context
    if (translation.includes('{{timeGreeting}}')) {
      let greeting = 'Hello';
      
      if (timeContext.hour < 12) greeting = 'Good morning';
      else if (timeContext.hour < 18) greeting = 'Good afternoon';
      else greeting = 'Good evening';
      
      translation = translation.replace('{{timeGreeting}}', greeting);
    }
    
    // Adjust urgency based on time
    if (timeContext.isWeekend && translation.includes('urgent')) {
      translation = translation.replace(/urgent/gi, 'important');
    }
    
    return translation;
  }
  
  /**
   * Get base translation
   */
  async getBaseTranslation(key, language) {
    // This would typically call the main i18n system
    // For now, return a placeholder
    return `[${key}]`;
  }
  
  /**
   * Track context usage for analytics
   */
  trackContextUsage(key, context) {
    const usage = {
      key,
      context: {
        domain: context.domain,
        audience: context.audience,
        formality: context.formality,
        language: context.language
      },
      timestamp: Date.now()
    };
    
    this.contextHistory.push(usage);
    
    // Keep history within limits
    if (this.contextHistory.length > this.options.maxContextHistory) {
      this.contextHistory.shift();
    }
    
    this.emit('context:tracked', usage);
  }
  
  /**
   * Get user profile
   */
  getUserProfile(userId) {
    return this.userProfiles.get(userId);
  }
  
  /**
   * Update user profile
   */
  updateUserProfile(userId, profile) {
    const existingProfile = this.userProfiles.get(userId) || {};
    const updatedProfile = {
      ...existingProfile,
      ...profile,
      lastUpdated: Date.now()
    };
    
    this.userProfiles.set(userId, updatedProfile);
    
    this.emit('user:profile_updated', {
      userId,
      profile: updatedProfile
    });
  }
  
  /**
   * Load domain knowledge
   */
  async loadDomainKnowledge() {
    // Initialize with default domain knowledge
    this.domainKnowledge.set('mining', {
      commonTerms: ['hashrate', 'difficulty', 'shares', 'pool', 'miner'],
      technicalLevel: 'high',
      audience: ['miners', 'pool_operators', 'hardware_enthusiasts']
    });
    
    this.domainKnowledge.set('dex', {
      commonTerms: ['swap', 'liquidity', 'slippage', 'orderbook', 'trading'],
      technicalLevel: 'medium',
      audience: ['traders', 'defi_users', 'investors']
    });
    
    this.domainKnowledge.set('defi', {
      commonTerms: ['yield', 'staking', 'governance', 'vault', 'farming'],
      technicalLevel: 'high',
      audience: ['defi_users', 'yield_farmers', 'protocol_users']
    });
  }
  
  /**
   * Setup context tracking
   */
  setupContextTracking() {
    // Track context patterns for optimization
    setInterval(() => {
      this.analyzeContextPatterns();
    }, 60 * 60 * 1000); // Every hour
  }
  
  /**
   * Analyze context usage patterns
   */
  analyzeContextPatterns() {
    const patterns = {
      domainUsage: {},
      audiencePreferences: {},
      formalityTrends: {},
      temporalPatterns: {}
    };
    
    this.contextHistory.forEach(usage => {
      const { context } = usage;
      
      // Domain usage
      patterns.domainUsage[context.domain] = (patterns.domainUsage[context.domain] || 0) + 1;
      
      // Audience preferences
      patterns.audiencePreferences[context.audience] = (patterns.audiencePreferences[context.audience] || 0) + 1;
      
      // Formality trends
      patterns.formalityTrends[context.formality] = (patterns.formalityTrends[context.formality] || 0) + 1;
    });
    
    this.emit('context:patterns_analyzed', patterns);
  }
  
  /**
   * Generate context cache key
   */
  generateContextCacheKey(key, context) {
    const contextHash = createHash('md5')
      .update(JSON.stringify({
        domain: context.domain,
        formality: context.formality,
        audience: context.audience,
        language: context.language,
        userPreferences: context.userPreferences
      }))
      .digest('hex');
    
    return `${key}:${contextHash}`;
  }
  
  /**
   * Get time of day category
   */
  getTimeOfDay() {
    const hour = new Date().getHours();
    if (hour < 6) return 'night';
    if (hour < 12) return 'morning';
    if (hour < 18) return 'afternoon';
    return 'evening';
  }
  
  /**
   * Get day of week category
   */
  getDayOfWeek() {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    return days[new Date().getDay()];
  }
  
  /**
   * Simplify technical terms
   */
  simplifyTechnicalTerms(translation) {
    const simplifications = {
      'hash rate': 'mining speed',
      'difficulty adjustment': 'mining difficulty change',
      'liquidity pool': 'trading pool',
      'slippage tolerance': 'price change limit',
      'yield farming': 'earning rewards',
      'governance token': 'voting token'
    };
    
    let simplified = translation;
    
    Object.entries(simplifications).forEach(([technical, simple]) => {
      const pattern = new RegExp(`\\b${technical}\\b`, 'gi');
      simplified = simplified.replace(pattern, simple);
    });
    
    return simplified;
  }
  
  /**
   * Enhance with technical terms
   */
  enhanceWithTechnicalTerms(translation, domain) {
    // Add domain-specific technical enhancements
    // This is a simplified implementation
    return translation;
  }
  
  /**
   * Apply cultural adaptation
   */
  applyCulturalAdaptation(translation, culturalContext) {
    // Apply cultural adaptations based on user's cultural background
    // This is a simplified implementation
    return translation;
  }
  
  /**
   * Get context analytics
   */
  getContextAnalytics() {
    return {
      totalTranslations: this.contextHistory.length,
      cacheSize: this.contextCache.size,
      userProfiles: this.userProfiles.size,
      domainKnowledge: Array.from(this.domainKnowledge.keys()),
      recentPatterns: this.contextHistory.slice(-20)
    };
  }
  
  /**
   * Clear context data
   */
  clearContextData(userId = null) {
    if (userId) {
      this.userProfiles.delete(userId);
      
      // Clear user-specific context history
      this.contextHistory = this.contextHistory.filter(
        usage => !usage.context.userId || usage.context.userId !== userId
      );
    } else {
      this.contextCache.clear();
      this.userProfiles.clear();
      this.contextHistory = [];
    }
    
    this.emit('context:cleared', { userId });
  }
}

export default ContextualTranslationSystem;
/**
 * Translation Quality Manager
 * 
 * Automated translation quality assessment and improvement
 * Following Martin's clean code principles
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { getErrorHandler, OtedamaError, ErrorCategory } from '../error-handler.js';

export class TranslationQualityManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      enableAutomaticChecks: options.enableAutomaticChecks !== false,
      enableLengthChecks: options.enableLengthChecks !== false,
      enablePlaceholderChecks: options.enablePlaceholderChecks !== false,
      enableConsistencyChecks: options.enableConsistencyChecks !== false,
      enableContextChecks: options.enableContextChecks !== false,
      lengthVarianceThreshold: options.lengthVarianceThreshold || 2.0, // 200% variance
      placeholderPattern: options.placeholderPattern || /\{\{(\w+)\}\}/g,
      minTranslationLength: options.minTranslationLength || 1,
      maxTranslationLength: options.maxTranslationLength || 1000,
      ...options
    };
    
    this.errorHandler = getErrorHandler();
    this.qualityReports = new Map();
    this.translationMetrics = new Map();
    this.consistencyDatabase = new Map();
    this.contextPatterns = new Map();
    
    // Quality scoring weights
    this.weights = {
      length: 0.2,
      placeholders: 0.3,
      consistency: 0.3,
      context: 0.2
    };
    
    // Quality thresholds
    this.thresholds = {
      excellent: 0.9,
      good: 0.7,
      acceptable: 0.5,
      poor: 0.3
    };
    
    this.initialize();
  }
  
  /**
   * Initialize quality manager
   */
  initialize() {
    this.setupQualityChecks();
    this.emit('initialized');
  }
  
  /**
   * Assess translation quality
   */
  async assessTranslationQuality(originalText, translatedText, languageCode, context = {}) {
    const assessment = {
      timestamp: Date.now(),
      originalText,
      translatedText,
      languageCode,
      context,
      scores: {},
      issues: [],
      suggestions: [],
      overallScore: 0,
      quality: 'unknown'
    };
    
    try {
      // Perform individual quality checks
      if (this.options.enableLengthChecks) {
        assessment.scores.length = this.checkLength(originalText, translatedText, languageCode);
      }
      
      if (this.options.enablePlaceholderChecks) {
        assessment.scores.placeholders = this.checkPlaceholders(originalText, translatedText);
      }
      
      if (this.options.enableConsistencyChecks) {
        assessment.scores.consistency = this.checkConsistency(originalText, translatedText, languageCode);
      }
      
      if (this.options.enableContextChecks) {
        assessment.scores.context = this.checkContext(translatedText, context);
      }
      
      // Calculate overall score
      assessment.overallScore = this.calculateOverallScore(assessment.scores);
      assessment.quality = this.determineQuality(assessment.overallScore);
      
      // Generate issues and suggestions
      this.generateIssuesAndSuggestions(assessment);
      
      // Store assessment
      const key = this.generateAssessmentKey(originalText, languageCode);
      this.qualityReports.set(key, assessment);
      
      // Update metrics
      this.updateMetrics(languageCode, assessment);
      
      this.emit('quality:assessed', {
        language: languageCode,
        score: assessment.overallScore,
        quality: assessment.quality,
        issues: assessment.issues.length
      });
      
      return assessment;
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'translation-quality',
        category: ErrorCategory.VALIDATION,
        language: languageCode
      });
      
      return {
        ...assessment,
        overallScore: 0,
        quality: 'error',
        issues: [{ type: 'system', message: 'Quality assessment failed' }]
      };
    }
  }
  
  /**
   * Check translation length appropriateness
   */
  checkLength(originalText, translatedText, languageCode) {
    const originalLength = originalText.length;
    const translatedLength = translatedText.length;
    
    if (originalLength === 0) return 1.0;
    
    const ratio = translatedLength / originalLength;
    
    // Language-specific length expectations
    const expectedRatios = {
      'en': 1.0,
      'zh': 0.4,  // Chinese is typically much shorter
      'ja': 0.8,  // Japanese is somewhat shorter
      'de': 1.3,  // German tends to be longer
      'fi': 1.2,  // Finnish tends to be longer
      'ar': 0.9,  // Arabic is typically shorter
      'es': 1.1,  // Spanish is slightly longer
      'fr': 1.1,  // French is slightly longer
      'ru': 1.0,  // Russian is similar
      'default': 1.0
    };
    
    const expectedRatio = expectedRatios[languageCode] || expectedRatios.default;
    const variance = Math.abs(ratio - expectedRatio) / expectedRatio;
    
    // Score based on variance from expected ratio
    if (variance <= 0.2) return 1.0;      // Within 20% is excellent
    if (variance <= 0.5) return 0.8;      // Within 50% is good
    if (variance <= 1.0) return 0.6;      // Within 100% is acceptable
    if (variance <= 2.0) return 0.4;      // Within 200% is poor
    return 0.2;                           // Beyond 200% is very poor
  }
  
  /**
   * Check placeholder consistency
   */
  checkPlaceholders(originalText, translatedText) {
    const originalPlaceholders = this.extractPlaceholders(originalText);
    const translatedPlaceholders = this.extractPlaceholders(translatedText);
    
    // Check if all placeholders are present
    const missing = originalPlaceholders.filter(p => !translatedPlaceholders.includes(p));
    const extra = translatedPlaceholders.filter(p => !originalPlaceholders.includes(p));
    
    if (missing.length === 0 && extra.length === 0) {
      return 1.0; // Perfect match
    }
    
    const totalPlaceholders = originalPlaceholders.length;
    if (totalPlaceholders === 0) {
      return extra.length === 0 ? 1.0 : 0.5; // No placeholders expected
    }
    
    const errorCount = missing.length + extra.length;
    const score = Math.max(0, 1 - (errorCount / totalPlaceholders));
    
    return score;
  }
  
  /**
   * Extract placeholders from text
   */
  extractPlaceholders(text) {
    const matches = text.match(this.options.placeholderPattern) || [];
    return matches.map(match => match.replace(/[{}]/g, ''));
  }
  
  /**
   * Check translation consistency
   */
  checkConsistency(originalText, translatedText, languageCode) {
    const key = this.generateConsistencyKey(originalText);
    const consistencyData = this.consistencyDatabase.get(key) || {
      translations: new Map(),
      totalCount: 0
    };
    
    // Add current translation
    const currentCount = consistencyData.translations.get(translatedText) || 0;
    consistencyData.translations.set(translatedText, currentCount + 1);
    consistencyData.totalCount++;
    
    this.consistencyDatabase.set(key, consistencyData);
    
    // Calculate consistency score
    if (consistencyData.totalCount === 1) {
      return 1.0; // First translation, assume consistent
    }
    
    const mostFrequent = Math.max(...consistencyData.translations.values());
    const consistencyRatio = mostFrequent / consistencyData.totalCount;
    
    return consistencyRatio;
  }
  
  /**
   * Check contextual appropriateness
   */
  checkContext(translatedText, context) {
    let score = 1.0;
    
    // Check domain-specific terms
    if (context.domain) {
      score *= this.checkDomainTerms(translatedText, context.domain);
    }
    
    // Check formality level
    if (context.formality) {
      score *= this.checkFormality(translatedText, context.formality);
    }
    
    // Check target audience
    if (context.audience) {
      score *= this.checkAudience(translatedText, context.audience);
    }
    
    return Math.max(0, Math.min(1, score));
  }
  
  /**
   * Check domain-specific terminology
   */
  checkDomainTerms(text, domain) {
    const domainTerms = {
      mining: ['hashrate', 'difficulty', 'shares', 'pool', 'miner', 'algorithm'],
      dex: ['liquidity', 'slippage', 'swap', 'trading', 'orderbook', 'pair'],
      defi: ['yield', 'staking', 'governance', 'protocol', 'vault', 'farming'],
      crypto: ['wallet', 'private key', 'address', 'transaction', 'blockchain']
    };
    
    const terms = domainTerms[domain] || [];
    if (terms.length === 0) return 1.0;
    
    const foundTerms = terms.filter(term => 
      text.toLowerCase().includes(term.toLowerCase())
    );
    
    // Score based on appropriate domain term usage
    return foundTerms.length > 0 ? 1.0 : 0.8;
  }
  
  /**
   * Check formality level
   */
  checkFormality(text, expectedFormality) {
    // Simple formality indicators (language-specific logic would be needed)
    const formalIndicators = ['please', 'kindly', 'would you', 'could you'];
    const informalIndicators = ['hey', 'gonna', 'wanna', 'ok'];
    
    const formalCount = formalIndicators.filter(indicator => 
      text.toLowerCase().includes(indicator)
    ).length;
    
    const informalCount = informalIndicators.filter(indicator => 
      text.toLowerCase().includes(indicator)
    ).length;
    
    if (expectedFormality === 'formal') {
      return informalCount === 0 ? 1.0 : Math.max(0.5, 1.0 - (informalCount * 0.2));
    } else if (expectedFormality === 'informal') {
      return formalCount === 0 ? 1.0 : Math.max(0.5, 1.0 - (formalCount * 0.2));
    }
    
    return 1.0; // Neutral formality
  }
  
  /**
   * Check target audience appropriateness
   */
  checkAudience(text, audience) {
    const audiencePatterns = {
      technical: ['API', 'configuration', 'implementation', 'deployment'],
      business: ['ROI', 'revenue', 'strategy', 'market'],
      general: ['user-friendly', 'easy', 'simple', 'intuitive']
    };
    
    const patterns = audiencePatterns[audience] || [];
    if (patterns.length === 0) return 1.0;
    
    const matches = patterns.filter(pattern => 
      text.toLowerCase().includes(pattern.toLowerCase())
    );
    
    return matches.length > 0 ? 1.0 : 0.9;
  }
  
  /**
   * Calculate overall quality score
   */
  calculateOverallScore(scores) {
    let totalScore = 0;
    let totalWeight = 0;
    
    Object.entries(scores).forEach(([category, score]) => {
      const weight = this.weights[category] || 0.1;
      totalScore += score * weight;
      totalWeight += weight;
    });
    
    return totalWeight > 0 ? totalScore / totalWeight : 0;
  }
  
  /**
   * Determine quality level
   */
  determineQuality(score) {
    if (score >= this.thresholds.excellent) return 'excellent';
    if (score >= this.thresholds.good) return 'good';
    if (score >= this.thresholds.acceptable) return 'acceptable';
    if (score >= this.thresholds.poor) return 'poor';
    return 'unacceptable';
  }
  
  /**
   * Generate issues and suggestions
   */
  generateIssuesAndSuggestions(assessment) {
    const { scores, originalText, translatedText, languageCode } = assessment;
    
    // Length issues
    if (scores.length < 0.7) {
      assessment.issues.push({
        type: 'length',
        severity: scores.length < 0.5 ? 'high' : 'medium',
        message: `Translation length seems inappropriate for ${languageCode}`
      });
      
      assessment.suggestions.push({
        type: 'length',
        message: 'Consider adjusting translation length to match expected language patterns'
      });
    }
    
    // Placeholder issues
    if (scores.placeholders < 1.0) {
      assessment.issues.push({
        type: 'placeholders',
        severity: 'high',
        message: 'Placeholder variables are missing or incorrect'
      });
      
      assessment.suggestions.push({
        type: 'placeholders',
        message: 'Ensure all placeholder variables from the original text are included'
      });
    }
    
    // Consistency issues
    if (scores.consistency < 0.8) {
      assessment.issues.push({
        type: 'consistency',
        severity: 'medium',
        message: 'Translation differs from previous translations of the same text'
      });
      
      assessment.suggestions.push({
        type: 'consistency',
        message: 'Review previous translations for consistency'
      });
    }
    
    // Context issues
    if (scores.context < 0.8) {
      assessment.issues.push({
        type: 'context',
        severity: 'low',
        message: 'Translation may not be appropriate for the given context'
      });
      
      assessment.suggestions.push({
        type: 'context',
        message: 'Consider domain-specific terminology and target audience'
      });
    }
  }
  
  /**
   * Batch assess translations
   */
  async batchAssessTranslations(translations, languageCode, context = {}) {
    const assessments = [];
    
    for (const { original, translated, itemContext } of translations) {
      const assessment = await this.assessTranslationQuality(
        original,
        translated,
        languageCode,
        { ...context, ...itemContext }
      );
      assessments.push(assessment);
    }
    
    const summary = this.generateBatchSummary(assessments, languageCode);
    
    this.emit('batch:assessed', {
      language: languageCode,
      count: assessments.length,
      summary
    });
    
    return { assessments, summary };
  }
  
  /**
   * Generate batch assessment summary
   */
  generateBatchSummary(assessments, languageCode) {
    const summary = {
      total: assessments.length,
      averageScore: 0,
      qualityDistribution: {},
      commonIssues: {},
      recommendations: []
    };
    
    let totalScore = 0;
    const qualityCounts = {};
    const issueCounts = {};
    
    assessments.forEach(assessment => {
      totalScore += assessment.overallScore;
      
      // Count quality levels
      qualityCounts[assessment.quality] = (qualityCounts[assessment.quality] || 0) + 1;
      
      // Count issue types
      assessment.issues.forEach(issue => {
        issueCounts[issue.type] = (issueCounts[issue.type] || 0) + 1;
      });
    });
    
    summary.averageScore = totalScore / assessments.length;
    summary.qualityDistribution = qualityCounts;
    summary.commonIssues = issueCounts;
    
    // Generate recommendations
    summary.recommendations = this.generateBatchRecommendations(summary, languageCode);
    
    return summary;
  }
  
  /**
   * Generate batch recommendations
   */
  generateBatchRecommendations(summary, languageCode) {
    const recommendations = [];
    
    if (summary.averageScore < 0.7) {
      recommendations.push({
        priority: 'high',
        message: `Overall translation quality for ${languageCode} needs improvement`
      });
    }
    
    // Check most common issues
    const sortedIssues = Object.entries(summary.commonIssues)
      .sort(([,a], [,b]) => b - a);
    
    if (sortedIssues.length > 0) {
      const [topIssue, count] = sortedIssues[0];
      if (count > summary.total * 0.3) {
        recommendations.push({
          priority: 'medium',
          message: `${topIssue} issues are common - consider focused review`
        });
      }
    }
    
    return recommendations;
  }
  
  /**
   * Get quality metrics for language
   */
  getLanguageMetrics(languageCode) {
    return this.translationMetrics.get(languageCode) || {
      totalAssessments: 0,
      averageScore: 0,
      qualityDistribution: {},
      lastAssessment: null
    };
  }
  
  /**
   * Update metrics for language
   */
  updateMetrics(languageCode, assessment) {
    const metrics = this.getLanguageMetrics(languageCode);
    
    metrics.totalAssessments++;
    metrics.averageScore = (
      (metrics.averageScore * (metrics.totalAssessments - 1) + assessment.overallScore) /
      metrics.totalAssessments
    );
    
    const quality = assessment.quality;
    metrics.qualityDistribution[quality] = (metrics.qualityDistribution[quality] || 0) + 1;
    metrics.lastAssessment = assessment.timestamp;
    
    this.translationMetrics.set(languageCode, metrics);
  }
  
  /**
   * Generate assessment key
   */
  generateAssessmentKey(originalText, languageCode) {
    return createHash('md5')
      .update(`${originalText}:${languageCode}`)
      .digest('hex');
  }
  
  /**
   * Generate consistency key
   */
  generateConsistencyKey(originalText) {
    return createHash('md5')
      .update(originalText.toLowerCase().trim())
      .digest('hex');
  }
  
  /**
   * Setup automatic quality checks
   */
  setupQualityChecks() {
    // Setup periodic consistency analysis
    setInterval(() => {
      this.analyzeConsistencyTrends();
    }, 24 * 60 * 60 * 1000); // Daily
  }
  
  /**
   * Analyze consistency trends
   */
  analyzeConsistencyTrends() {
    const trends = [];
    
    for (const [key, data] of this.consistencyDatabase.entries()) {
      if (data.totalCount > 5) { // Only analyze items with sufficient data
        const uniqueTranslations = data.translations.size;
        const mostFrequent = Math.max(...data.translations.values());
        const consistency = mostFrequent / data.totalCount;
        
        if (consistency < 0.7) {
          trends.push({
            key,
            consistency,
            uniqueTranslations,
            totalTranslations: data.totalCount,
            severity: consistency < 0.5 ? 'high' : 'medium'
          });
        }
      }
    }
    
    if (trends.length > 0) {
      this.emit('consistency:trends', { trends });
    }
  }
  
  /**
   * Get comprehensive quality report
   */
  getQualityReport(languageCode = null) {
    const report = {
      timestamp: Date.now(),
      languages: {},
      globalStats: {
        totalAssessments: 0,
        averageScore: 0,
        qualityDistribution: {}
      }
    };
    
    const languages = languageCode ? [languageCode] : Array.from(this.translationMetrics.keys());
    
    languages.forEach(lang => {
      const metrics = this.getLanguageMetrics(lang);
      report.languages[lang] = metrics;
      
      report.globalStats.totalAssessments += metrics.totalAssessments;
    });
    
    // Calculate global average
    if (languages.length > 0) {
      const totalScore = languages.reduce((sum, lang) => {
        const metrics = this.getLanguageMetrics(lang);
        return sum + (metrics.averageScore * metrics.totalAssessments);
      }, 0);
      
      report.globalStats.averageScore = totalScore / report.globalStats.totalAssessments;
    }
    
    return report;
  }
  
  /**
   * Clear quality data
   */
  clearQualityData(languageCode = null) {
    if (languageCode) {
      this.translationMetrics.delete(languageCode);
      
      // Clear related quality reports
      for (const [key, report] of this.qualityReports.entries()) {
        if (report.languageCode === languageCode) {
          this.qualityReports.delete(key);
        }
      }
    } else {
      this.qualityReports.clear();
      this.translationMetrics.clear();
      this.consistencyDatabase.clear();
    }
    
    this.emit('quality:cleared', { language: languageCode });
  }
}

export default TranslationQualityManager;
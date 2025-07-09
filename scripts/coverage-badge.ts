#!/usr/bin/env node
// Coverage badge generator for README
// Rob Pike: "Data dominates. If you've chosen the right data structures and organized things well, the algorithms will almost always be self-evident."

import * as fs from 'fs/promises';
import * as path from 'path';

interface BadgeConfig {
  label: string;
  message: string;
  color: string;
}

class CoverageBadgeGenerator {
  private readonly coverageFile = path.join(process.cwd(), 'coverage', 'coverage-summary.json');
  private readonly outputDir = path.join(process.cwd(), 'coverage', 'badges');

  /**
   * Generate all coverage badges
   */
  async generate(): Promise<void> {
    try {
      // Ensure output directory exists
      await fs.mkdir(this.outputDir, { recursive: true });

      // Read coverage summary
      const coverageData = await fs.readFile(this.coverageFile, 'utf-8');
      const coverage = JSON.parse(coverageData);
      const total = coverage.total;

      // Generate badges for each metric
      const metrics = ['lines', 'statements', 'functions', 'branches'];
      
      for (const metric of metrics) {
        const percentage = total[metric].pct;
        await this.generateBadge(metric, percentage);
      }

      // Generate overall badge (minimum of all metrics)
      const overallPercentage = Math.min(
        total.lines.pct,
        total.statements.pct,
        total.functions.pct,
        total.branches.pct
      );
      await this.generateBadge('coverage', overallPercentage);

      console.log('✅ Coverage badges generated successfully');
      
    } catch (error) {
      console.error('❌ Failed to generate coverage badges:', error);
      process.exit(1);
    }
  }

  /**
   * Generate a single badge
   */
  private async generateBadge(metric: string, percentage: number): Promise<void> {
    const config = this.getBadgeConfig(metric, percentage);
    const svg = this.createBadgeSVG(config);
    
    const filename = path.join(this.outputDir, `${metric}.svg`);
    await fs.writeFile(filename, svg);
  }

  /**
   * Get badge configuration based on metric and percentage
   */
  private getBadgeConfig(metric: string, percentage: number): BadgeConfig {
    const label = metric.charAt(0).toUpperCase() + metric.slice(1);
    const message = `${percentage.toFixed(1)}%`;
    const color = this.getColorForPercentage(percentage);
    
    return { label, message, color };
  }

  /**
   * Get color based on percentage
   */
  private getColorForPercentage(percentage: number): string {
    if (percentage >= 90) return '4c1'; // Bright green
    if (percentage >= 80) return '97ca00'; // Green
    if (percentage >= 70) return 'dfb317'; // Yellow
    if (percentage >= 60) return 'fe7d37'; // Orange
    return 'e05d44'; // Red
  }

  /**
   * Create SVG badge
   */
  private createBadgeSVG(config: BadgeConfig): string {
    const labelWidth = config.label.length * 7 + 10;
    const messageWidth = config.message.length * 7 + 10;
    const totalWidth = labelWidth + messageWidth;
    
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${totalWidth}" height="20">
  <linearGradient id="b" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="a">
    <rect width="${totalWidth}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#a)">
    <path fill="#555" d="M0 0h${labelWidth}v20H0z"/>
    <path fill="#${config.color}" d="M${labelWidth} 0h${messageWidth}v20H${labelWidth}z"/>
    <path fill="url(#b)" d="M0 0h${totalWidth}v20H0z"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="110">
    <text x="${labelWidth * 5}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(labelWidth - 10) * 10}">${config.label}</text>
    <text x="${labelWidth * 5}" y="140" transform="scale(.1)" textLength="${(labelWidth - 10) * 10}">${config.label}</text>
    <text x="${(labelWidth + messageWidth / 2) * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(messageWidth - 10) * 10}">${config.message}</text>
    <text x="${(labelWidth + messageWidth / 2) * 10}" y="140" transform="scale(.1)" textLength="${(messageWidth - 10) * 10}">${config.message}</text>
  </g>
</svg>`;
  }

  /**
   * Update README with badge URLs
   */
  async updateReadme(): Promise<void> {
    const readmePath = path.join(process.cwd(), 'README.md');
    
    try {
      let readme = await fs.readFile(readmePath, 'utf-8');
      
      // Badge URLs (for GitHub)
      const badges = [
        '![Coverage](./coverage/badges/coverage.svg)',
        '![Lines](./coverage/badges/lines.svg)',
        '![Functions](./coverage/badges/functions.svg)',
        '![Branches](./coverage/badges/branches.svg)',
        '![Statements](./coverage/badges/statements.svg)',
      ];
      
      // Find or create badges section
      const badgesSection = badges.join(' ');
      const badgesRegex = /<!-- coverage-badges-start -->[\s\S]*<!-- coverage-badges-end -->/;
      
      if (badgesRegex.test(readme)) {
        // Update existing badges
        readme = readme.replace(
          badgesRegex,
          `<!-- coverage-badges-start -->\n${badgesSection}\n<!-- coverage-badges-end -->`
        );
      } else {
        // Add badges after title
        const lines = readme.split('\n');
        const titleIndex = lines.findIndex(line => line.startsWith('# '));
        
        if (titleIndex !== -1) {
          lines.splice(
            titleIndex + 1,
            0,
            '',
            '<!-- coverage-badges-start -->',
            badgesSection,
            '<!-- coverage-badges-end -->',
            ''
          );
          readme = lines.join('\n');
        }
      }
      
      await fs.writeFile(readmePath, readme);
      console.log('✅ README updated with coverage badges');
      
    } catch (error) {
      console.log('⚠️  Could not update README:', error);
    }
  }
}

// Main execution
async function main() {
  const generator = new CoverageBadgeGenerator();
  
  await generator.generate();
  
  if (process.argv.includes('--update-readme')) {
    await generator.updateReadme();
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

export { CoverageBadgeGenerator };

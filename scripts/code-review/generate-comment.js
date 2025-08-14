#!/usr/bin/env node
/*
  Generate a PR code review comment from available analysis artifacts.
  Inputs (optional):
    --complexity <path>    JSON from complexity-report
    --size <path>          JSON from size-limit --json
    --out <path>           Output markdown file (default: code-review-comment.md)

  Notes:
  - Produces stable, versionless, emoji-free Markdown.
  - Gracefully handles missing inputs.
*/
const fs = require('fs');
const path = require('path');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { complexity: 'complexity.json', size: 'size-limit.json', out: 'code-review-comment.md' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--complexity' && args[i + 1]) { out.complexity = args[++i]; }
    else if (a === '--size' && args[i + 1]) { out.size = args[++i]; }
    else if (a === '--out' && args[i + 1]) { out.out = args[++i]; }
  }
  return out;
}

function safeReadJSON(file) {
  try {
    if (!file) return undefined;
    if (!fs.existsSync(file)) return undefined;
    const data = fs.readFileSync(file, 'utf8');
    if (!data) return undefined;
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function hasContent(str) { return typeof str === 'string' && str.trim().length > 0; }

function sectionComplexity(data) {
  if (!data || !Array.isArray(data.reports) || data.reports.length === 0) return '';
  const rows = data.reports
    .filter(r => typeof r.complexity === 'number')
    .sort((a, b) => b.complexity - a.complexity)
    .slice(0, 10)
    .map(r => {
      const level = r.complexity > 20 ? 'High' : r.complexity > 15 ? 'Medium' : 'Low';
      const maintain = typeof r.maintainability === 'number' ? r.maintainability.toFixed(2) : 'N/A';
      return `| ${r.path || 'unknown'} | ${level} (${r.complexity}) | ${maintain} |`;
    });
  if (rows.length === 0) return '';
  return [
    '### Complexity Analysis',
    '',
    '| File | Complexity | Maintainability |',
    '|------|------------|----------------|',
    ...rows,
    ''
  ].join('\n');
}

function sectionSizeLimit(data) {
  if (!Array.isArray(data) || data.length === 0) return '';
  const rows = data.map(item => {
    const status = item.passed ? 'PASS' : 'FAIL';
    const size = typeof item.size === 'string' ? item.size : (typeof item.size === 'number' ? `${item.size}` : 'N/A');
    const limit = hasContent(item.limit) ? item.limit : 'N/A';
    return `| ${item.name || 'bundle'} | ${size} | ${limit} | ${status} |`;
  });
  if (rows.length === 0) return '';
  return [
    '### Bundle Size',
    '',
    '| Name | Size | Limit | Status |',
    '|------|------|-------|--------|',
    ...rows,
    ''
  ].join('\n');
}

function sectionChecklist() {
  return [
    '### Review Checklist',
    '',
    '- [ ] Code follows style guidelines',
    '- [ ] Self-review performed',
    '- [ ] Comments added for complex code',
    '- [ ] Documentation updated',
    '- [ ] Tests added or updated',
    '- [ ] No debug logs present',
    '- [ ] Security considerations addressed',
    '- [ ] Performance impact considered',
    ''
  ].join('\n');
}

(function main() {
  const args = parseArgs();
  const complexity = safeReadJSON(args.complexity);
  const sizeLimit = safeReadJSON(args.size);

  const parts = ['## Automated Code Review', ''];
  const comp = sectionComplexity(complexity);
  const size = sectionSizeLimit(sizeLimit);
  const checklist = sectionChecklist();

  if (hasContent(comp)) parts.push(comp);
  if (hasContent(size)) parts.push(size);
  parts.push(checklist);

  const body = parts.join('\n');
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, body, 'utf8');
  // Also echo to stdout for convenience
  process.stdout.write(body + '\n');
})();

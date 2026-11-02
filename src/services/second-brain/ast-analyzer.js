'use strict';

const path = require('path');

/**
 * AST & Symbol Analyzer
 *
 * Lightweight, high-speed syntax-directed symbol and structure extractor.
 * Extracts functions, classes, interfaces, Express/Next routes, Prisma models,
 * SQL tables/triggers/procedures, and React components with line ranges.
 */

class AstAnalyzer {
  analyzeFile(filePath, content) {
    if (!content || typeof content !== 'string') return [];
    const ext = path.extname(filePath).toLowerCase();
    const lines = content.split('\n');

    switch (ext) {
      case '.ts':
      case '.tsx':
      case '.js':
      case '.jsx':
      case '.mjs':
        return this.analyzeEcmaScript(filePath, lines);
      case '.py':
        return this.analyzePython(filePath, lines);
      case '.sql':
        return this.analyzeSql(filePath, lines);
      case '.prisma':
        return this.analyzePrisma(filePath, lines);
      case '.md':
        return this.analyzeMarkdown(filePath, lines);
      default:
        return [];
    }
  }

  analyzeEcmaScript(filePath, lines) {
    const symbols = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const lineNum = i + 1;

      // Class declaration
      const classMatch = line.match(/^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z0-9_$]+)/);
      if (classMatch) {
        symbols.push({
          name: classMatch[1],
          kind: 'class',
          line: lineNum,
          file: filePath,
          signature: classMatch[0]
        });
        continue;
      }

      // Interface / Type declaration (TypeScript)
      const typeMatch = line.match(/^(?:export\s+)?(?:interface|type)\s+([A-Za-z0-9_$]+)/);
      if (typeMatch) {
        symbols.push({
          name: typeMatch[1],
          kind: 'type',
          line: lineNum,
          file: filePath,
          signature: typeMatch[0]
        });
        continue;
      }

      // Function declaration
      const funcMatch = line.match(/^(?:export\s+)?(?:async\s+)?function(?:\s+([A-Za-z0-9_$]+))?\s*\(([^)]*)\)/);
      if (funcMatch && funcMatch[1]) {
        symbols.push({
          name: funcMatch[1],
          kind: 'function',
          line: lineNum,
          file: filePath,
          signature: `function ${funcMatch[1]}(${funcMatch[2].trim()})`
        });
        continue;
      }

      // Exported const/let arrow function or component
      const arrowMatch = line.match(/^(?:export\s+)?(?:const|let)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/);
      if (arrowMatch) {
        const isComponent = /^[A-Z]/.test(arrowMatch[1]);
        symbols.push({
          name: arrowMatch[1],
          kind: isComponent ? 'component' : 'function',
          line: lineNum,
          file: filePath,
          signature: arrowMatch[0]
        });
        continue;
      }

      // Next.js App Router / Express HTTP route handlers
      const routeMatch = line.match(/(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/i);
      if (routeMatch) {
        symbols.push({
          name: `${routeMatch[1].toUpperCase()} ${routeMatch[2]}`,
          kind: 'api_route',
          line: lineNum,
          file: filePath,
          signature: routeMatch[0]
        });
        continue;
      }

      // Next.js Route Handler export (GET, POST, etc.)
      const nextRouteMatch = line.match(/^export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH)\s*\(/);
      if (nextRouteMatch) {
        symbols.push({
          name: nextRouteMatch[1],
          kind: 'api_route',
          line: lineNum,
          file: filePath,
          signature: nextRouteMatch[0]
        });
        continue;
      }
    }

    return symbols;
  }

  analyzePython(filePath, lines) {
    const symbols = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      const classMatch = trimmed.match(/^class\s+([A-Za-z0-9_]+)(?:\(([^)]*)\))?:/);
      if (classMatch) {
        symbols.push({
          name: classMatch[1],
          kind: 'class',
          line: lineNum,
          file: filePath,
          signature: classMatch[0]
        });
        continue;
      }

      const defMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(([^)]*)\):/);
      if (defMatch) {
        symbols.push({
          name: defMatch[1],
          kind: 'function',
          line: lineNum,
          file: filePath,
          signature: `def ${defMatch[1]}(${defMatch[2].trim()})`
        });
        continue;
      }
    }
    return symbols;
  }

  analyzeSql(filePath, lines) {
    const symbols = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const lineNum = i + 1;

      // Table definition
      const tableMatch = line.match(/^CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z0-9_".]+)/i);
      if (tableMatch) {
        symbols.push({
          name: tableMatch[1].replace(/["`]/g, ''),
          kind: 'database_table',
          line: lineNum,
          file: filePath,
          signature: tableMatch[0]
        });
        continue;
      }

      // View definition
      const viewMatch = line.match(/^CREATE(?:\s+OR\s+REPLACE)?\s+(?:MATERIALIZED\s+)?VIEW\s+([A-Za-z0-9_".]+)/i);
      if (viewMatch) {
        symbols.push({
          name: viewMatch[1].replace(/["`]/g, ''),
          kind: 'database_view',
          line: lineNum,
          file: filePath,
          signature: viewMatch[0]
        });
        continue;
      }

      // Trigger definition
      const trgMatch = line.match(/^CREATE\s+TRIGGER\s+([A-Za-z0-9_".]+)/i);
      if (trgMatch) {
        symbols.push({
          name: trgMatch[1].replace(/["`]/g, ''),
          kind: 'database_trigger',
          line: lineNum,
          file: filePath,
          signature: trgMatch[0]
        });
        continue;
      }

      // Procedure / Function definition
      const procMatch = line.match(/^CREATE(?:\s+OR\s+REPLACE)?\s+(?:FUNCTION|PROCEDURE)\s+([A-Za-z0-9_".]+)/i);
      if (procMatch) {
        symbols.push({
          name: procMatch[1].replace(/["`]/g, ''),
          kind: 'database_procedure',
          line: lineNum,
          file: filePath,
          signature: procMatch[0]
        });
        continue;
      }
    }
    return symbols;
  }

  analyzePrisma(filePath, lines) {
    const symbols = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const lineNum = i + 1;

      const modelMatch = line.match(/^model\s+([A-Za-z0-9_]+)\s*\{/);
      if (modelMatch) {
        symbols.push({
          name: modelMatch[1],
          kind: 'prisma_model',
          line: lineNum,
          file: filePath,
          signature: `model ${modelMatch[1]}`
        });
        continue;
      }

      const enumMatch = line.match(/^enum\s+([A-Za-z0-9_]+)\s*\{/);
      if (enumMatch) {
        symbols.push({
          name: enumMatch[1],
          kind: 'prisma_enum',
          line: lineNum,
          file: filePath,
          signature: `enum ${enumMatch[1]}`
        });
        continue;
      }
    }
    return symbols;
  }

  analyzeMarkdown(filePath, lines) {
    const symbols = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const lineNum = i + 1;

      const headerMatch = line.match(/^(#{1,3})\s+(.+)$/);
      if (headerMatch) {
        symbols.push({
          name: headerMatch[2].trim(),
          kind: `heading_h${headerMatch[1].length}`,
          line: lineNum,
          file: filePath,
          signature: headerMatch[0]
        });
      }
    }
    return symbols;
  }
}

module.exports = {
  AstAnalyzer,
  astAnalyzer: new AstAnalyzer()
};


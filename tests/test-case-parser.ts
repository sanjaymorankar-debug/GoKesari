import * as XLSX from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';

interface TestCase {
  tcId: string;
  module: string;
  featureIds: string;
  testCase: string;
  type: string;
  priority: 'P0' | 'P1' | 'P2';
  role: string;
  method: string;
  steps?: string;
  expectedResult?: string;
  status?: 'Not run' | 'Pass' | 'Fail' | 'Blocked';
  notes?: string;
}

interface TestModule {
  name: string;
  totalCases: number;
  p0Cases: number;
  p1Cases: number;
  p2Cases: number;
  cases: TestCase[];
}

interface ParsedTestSuite {
  totalCases: number;
  modules: Map<string, TestModule>;
  casesByPriority: {
    p0: TestCase[];
    p1: TestCase[];
    p2: TestCase[];
  };
}

/**
 * Parse test cases from Excel file
 */
export function parseTestCases(filePath: string): ParsedTestSuite {
  const workbook = XLSX.readFile(filePath);
  const testCasesSheet = workbook.Sheets['Test cases'];

  if (!testCasesSheet) {
    throw new Error('Test cases sheet not found');
  }

  const rows = XLSX.utils.sheet_to_json<any>(testCasesSheet);
  const modules = new Map<string, TestModule>();
  const casesByPriority = {
    p0: [] as TestCase[],
    p1: [] as TestCase[],
    p2: [] as TestCase[],
  };

  let totalCases = 0;

  for (const row of rows) {
    if (!row['TC ID'] || row['TC ID'].startsWith('TC ID')) continue;

    const testCase: TestCase = {
      tcId: row['TC ID'],
      module: row['Module'],
      featureIds: row['Feature IDs'],
      testCase: row['Test case'],
      type: row['Type'],
      priority: row['Priority'] as 'P0' | 'P1' | 'P2',
      role: row['Role'],
      method: row['Method'],
      steps: row['Steps'],
      expectedResult: row['Expected Result'],
      status: 'Not run',
      notes: '',
    };

    // Group by module
    if (!modules.has(testCase.module)) {
      modules.set(testCase.module, {
        name: testCase.module,
        totalCases: 0,
        p0Cases: 0,
        p1Cases: 0,
        p2Cases: 0,
        cases: [],
      });
    }

    const moduleData = modules.get(testCase.module)!;
    moduleData.cases.push(testCase);
    moduleData.totalCases++;

    if (testCase.priority === 'P0') {
      moduleData.p0Cases++;
      casesByPriority.p0.push(testCase);
    } else if (testCase.priority === 'P1') {
      moduleData.p1Cases++;
      casesByPriority.p1.push(testCase);
    } else {
      moduleData.p2Cases++;
      casesByPriority.p2.push(testCase);
    }

    totalCases++;
  }

  return {
    totalCases,
    modules,
    casesByPriority,
  };
}

/**
 * Parse open features from Excel file
 */
export function parseOpenFeatures(filePath: string): any {
  const workbook = XLSX.readFile(filePath);
  const summarySheet = workbook.Sheets['Summary'];

  if (!summarySheet) {
    throw new Error('Summary sheet not found');
  }

  const rows = XLSX.utils.sheet_to_json<any>(summarySheet);
  return rows;
}

/**
 * Generate test execution report
 */
export function generateExecutionReport(
  suite: ParsedTestSuite,
  results: Map<string, 'Pass' | 'Fail' | 'Blocked' | 'Not run'>
): any {
  const report = {
    timestamp: new Date().toISOString(),
    totalCases: suite.totalCases,
    executed: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    notRun: 0,
    passRate: 0,
    byModule: {} as any,
    byPriority: {
      p0: { total: 0, pass: 0, fail: 0, blocked: 0, passRate: 0 },
      p1: { total: 0, pass: 0, fail: 0, blocked: 0, passRate: 0 },
      p2: { total: 0, pass: 0, fail: 0, blocked: 0, passRate: 0 },
    },
    failedTests: [] as any[],
  };

  // Process by module
  for (const [moduleName, moduleData] of suite.modules) {
    report.byModule[moduleName] = {
      total: moduleData.totalCases,
      pass: 0,
      fail: 0,
      blocked: 0,
      notRun: 0,
      p0: moduleData.p0Cases,
      p1: moduleData.p1Cases,
      p2: moduleData.p2Cases,
    };

    for (const testCase of moduleData.cases) {
      const status = results.get(testCase.tcId) || 'Not run';

      if (status !== 'Not run') {
        report.executed++;
      }

      if (status === 'Pass') {
        report.passed++;
        report.byModule[moduleName].pass++;
        if (testCase.priority === 'P0') report.byPriority.p0.pass++;
        else if (testCase.priority === 'P1') report.byPriority.p1.pass++;
        else report.byPriority.p2.pass++;
      } else if (status === 'Fail') {
        report.failed++;
        report.byModule[moduleName].fail++;
        report.failedTests.push({
          tcId: testCase.tcId,
          module: testCase.module,
          priority: testCase.priority,
          description: testCase.testCase,
        });
        if (testCase.priority === 'P0') report.byPriority.p0.fail++;
        else if (testCase.priority === 'P1') report.byPriority.p1.fail++;
        else report.byPriority.p2.fail++;
      } else if (status === 'Blocked') {
        report.blocked++;
        report.byModule[moduleName].blocked++;
        if (testCase.priority === 'P0') report.byPriority.p0.blocked++;
        else if (testCase.priority === 'P1') report.byPriority.p1.blocked++;
        else report.byPriority.p2.blocked++;
      } else {
        report.notRun++;
        report.byModule[moduleName].notRun++;
      }
    }

    // Calculate pass rate per module
    if (report.byModule[moduleName].total > 0) {
      const passable =
        report.byModule[moduleName].total - report.byModule[moduleName].notRun;
      report.byModule[moduleName].passRate =
        passable > 0
          ? (report.byModule[moduleName].pass / passable) * 100
          : 0;
    }
  }

  // Calculate overall pass rate
  if (report.executed > 0) {
    report.passRate = (report.passed / report.executed) * 100;
  }

  // Calculate priority pass rates
  for (const priority of ['p0', 'p1', 'p2'] as const) {
    const total = report.byPriority[priority].pass + report.byPriority[priority].fail;
    if (total > 0) {
      report.byPriority[priority].passRate =
        (report.byPriority[priority].pass / total) * 100;
    }
    report.byPriority[priority].total = suite.casesByPriority[priority].length;
  }

  return report;
}

/**
 * Export report to JSON
 */
export function exportReportJSON(report: any, outputPath: string): void {
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(`Report exported to ${outputPath}`);
}

/**
 * Export report to markdown
 */
export function exportReportMarkdown(report: any, outputPath: string): void {
  const markdown = `# Test Execution Report
Generated: ${report.timestamp}

## Summary
- **Total Cases**: ${report.totalCases}
- **Executed**: ${report.executed}
- **Passed**: ${report.passed} (${report.passRate.toFixed(1)}%)
- **Failed**: ${report.failed}
- **Blocked**: ${report.blocked}
- **Not Run**: ${report.notRun}

## By Priority
### P0 (Critical)
- **Total**: ${report.byPriority.p0.total}
- **Passed**: ${report.byPriority.p0.pass}
- **Failed**: ${report.byPriority.p0.fail}
- **Pass Rate**: ${report.byPriority.p0.passRate.toFixed(1)}%

### P1 (High)
- **Total**: ${report.byPriority.p1.total}
- **Passed**: ${report.byPriority.p1.pass}
- **Failed**: ${report.byPriority.p1.fail}
- **Pass Rate**: ${report.byPriority.p1.passRate.toFixed(1)}%

### P2 (Medium)
- **Total**: ${report.byPriority.p2.total}
- **Passed**: ${report.byPriority.p2.pass}
- **Failed**: ${report.byPriority.p2.fail}
- **Pass Rate**: ${report.byPriority.p2.passRate.toFixed(1)}%

## Failed Tests
${
  report.failedTests.length > 0
    ? report.failedTests
        .map(
          (tc: any) =>
            `- **${tc.tcId}** (${tc.priority}) [${tc.module}]: ${tc.description}`
        )
        .join('\n')
    : 'No failed tests'
}

## By Module
${Object.entries(report.byModule)
  .map(
    ([module, stats]: any) =>
      `### ${module}
- Total: ${stats.total} (P0: ${stats.p0}, P1: ${stats.p1}, P2: ${stats.p2})
- Passed: ${stats.pass}
- Failed: ${stats.fail}
- Pass Rate: ${stats.passRate.toFixed(1)}%`
  )
  .join('\n\n')}
`;

  fs.writeFileSync(outputPath, markdown);
  console.log(`Report exported to ${outputPath}`);
}

// Main execution
if (require.main === module) {
  try {
    const testCasesPath = path.join(__dirname, '..', 'test-cases.xlsx');
    const openFeaturesPath = path.join(__dirname, '..', 'open-features.xlsx');

    console.log('Parsing test cases...');
    const suite = parseTestCases(testCasesPath);

    console.log(`Found ${suite.totalCases} test cases across ${suite.modules.size} modules`);
    console.log(
      `  P0: ${suite.casesByPriority.p0.length}`,
      `P1: ${suite.casesByPriority.p1.length}`,
      `P2: ${suite.casesByPriority.p2.length}`
    );

    console.log('\nParsing open features...');
    const features = parseOpenFeatures(openFeaturesPath);
    console.log(`Found ${features.length} feature status entries`);

    // Export parsed data
    const summary = {
      testSuite: {
        totalCases: suite.totalCases,
        modules: Array.from(suite.modules.keys()),
        priorities: {
          p0: suite.casesByPriority.p0.length,
          p1: suite.casesByPriority.p1.length,
          p2: suite.casesByPriority.p2.length,
        },
      },
      openFeatures: {
        totalFeatures: features.length,
      },
      timestamp: new Date().toISOString(),
    };

    const summaryPath = path.join(__dirname, '..', 'test-suite-summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    console.log(`\nTest suite summary saved to ${summaryPath}`);
  } catch (error) {
    console.error('Error parsing test cases:', error);
    process.exit(1);
  }
}

export { TestCase, TestModule, ParsedTestSuite };

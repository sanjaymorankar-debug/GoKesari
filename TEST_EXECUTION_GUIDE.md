# GoKesari Test Execution Guide
## Automated & Manual Test Case Execution Framework

**Document Date**: October 4, 2026  
**Test Suite Version**: 2026-10-04 v3  
**Total Test Cases**: 791 across 28 modules  
**Status**: Ready for Execution

---

## Quick Start

### Prerequisites
```bash
# Install dependencies
npm install

# Ensure test environment is accessible
# Test URL: https://test.gokesari.com
```

### Run Preflight Tests (5 minutes)
```bash
npm run test:preflight
```

### Run All Tests
```bash
npm run test:full
# or for specific priority:
npm run test:p0
npm run test:p1
npm run test:p2
```

---

## Test Suite Structure

### Test Cases: `test-cases.xlsx`
- **Total**: 791 test cases
- **Modules**: 28
- **Priorities**: 
  - P0 (Critical): 306 cases
  - P1 (High): 325 cases
  - P2 (Medium): 160 cases

### Open Features: `open-features.xlsx`
- **Completed**: 132 features (84%)
- **In Progress**: 23 features
- **Decision Pending**: 8 items
- **Go-live Blockers**: 3 critical issues

---

## Execution Phases

### Phase 1: Preflight & Smoke (P0) - Duration: 1-2 hours
**Objective**: Verify test environment readiness

**Test Cases**:
- TC-PRE-001 through TC-PRE-012

**Success Criteria**:
- Site is reachable and renders
- No 500 errors on database pages
- Build matches code under test
- Test accounts can sign in
- Test data is available

**Command**:
```bash
npm run test:smoke
```

**What to Check**:
- ✅ Browser can reach test.gokesari.com
- ✅ No console errors on load
- ✅ Login page renders
- ✅ Can access admin dashboard
- ✅ Database queries execute without errors

---

### Phase 2: Critical Features (P0) - Duration: 20-30 hours
**Objective**: Test core platform functionality

**Modules**:
1. Login, Onboarding & Profile (TC-AUTH-*)
2. Roles & Access Control (TC-RBAC-*)
3. Product Discovery & Search (TC-SEARCH-*)
4. Cart & Checkout (TC-CART-*, TC-CHK-*)
5. Payment Processing (TC-PAY-*, TC-WALLET-*)
6. Orders & Fulfillment (TC-ORDER-*, TC-FULFILL-*)
7. Rider Management (TC-RIDER-*)

**Command**:
```bash
npm run test:p0
```

**Expected Results**:
- ✅ 100% pass rate required
- ✅ All critical flows work end-to-end
- ✅ Payment gateway integration working
- ✅ Order state machine transitions correct
- ✅ No data inconsistencies

**Sample Test Cases**:
```
TC-AUTH-001: New user signs up with mobile number
TC-AUTH-002: User completes profile and address
TC-CART-001: Add product to cart
TC-CART-002: Update cart quantities
TC-CHK-001: Proceed to checkout
TC-CHK-002: Select payment method
TC-PAY-001: Payment gateway integration
TC-ORDER-001: Order placed and confirmed
TC-FULFILL-001: Shop fulfills order
TC-RIDER-001: Rider assigned and dispatched
```

---

### Phase 3: High Priority Features (P1) - Duration: 30-40 hours
**Objective**: Test important business features

**Modules**:
- Subscriptions
- Returns & Refunds
- Support & Ratings
- Shop Management
- Notifications
- Marketing & Consent

**Command**:
```bash
npm run test:p1
```

**Success Criteria**:
- ✅ 95% pass rate acceptable
- ✅ No critical regressions
- ✅ Async operations working (emails, notifications)
- ✅ Data integrity maintained

---

### Phase 4: Standard Features (P2) - Duration: 20-30 hours
**Objective**: Test extended functionality

**Modules**:
- Admin & Operations Console
- Analytics & KPIs
- Navigation & Responsive Design
- Field-level Validation
- Security & Platform

**Command**:
```bash
npm run test:p2
```

**Success Criteria**:
- ✅ 90% pass rate acceptable
- ✅ UI is responsive on mobile/tablet
- ✅ Admin features functional

---

## Test Data Preparation

### Required Test Accounts

**Admin Account**:
```
Email: admin@test.gokesari.com
Password: [stored in test-env secrets]
Role: Super Admin
```

**Buyer Accounts** (5):
```
- buyer1@test.gokesari.com
- buyer2@test.gokesari.com
- buyer3@test.gokesari.com
- buyer4@test.gokesari.com
- buyer5@test.gokesari.com
```

**Shop Owner Accounts** (5):
```
- shop1@test.gokesari.com
- shop2@test.gokesari.com
- shop3@test.gokesari.com
- shop4@test.gokesari.com
- shop5@test.gokesari.com
```

**Rider Accounts** (3):
```
- rider1@test.gokesari.com
- rider2@test.gokesari.com
- rider3@test.gokesari.com
```

### Seed Data
- **Products**: Minimum 100 SKUs across categories
- **Shops**: Minimum 5 verified shops
- **Locations**: Delivery areas for 5+ cities
- **Payment Gateway**: Sandbox configured
- **Email Service**: SMTP configured for notifications

---

## Running Automated Tests

### Playwright E2E Tests
```bash
# Run Playwright tests
npx playwright test

# Run specific test file
npx playwright test tests/e2e-test-runner.ts

# Run with UI mode (interactive)
npx playwright test --ui

# Generate HTML report
npx playwright show-report
```

### Integration Tests
```bash
# Run Vitest integration tests
npm run test:integration

# Run specific module
npm run test:integration -- login-profile

# Watch mode for development
npm run test:integration -- --watch
```

### Manual Test Checklists
For features that require manual testing:

```bash
# Export checklist
npm run test:export-checklist -- --format markdown

# This generates TEST_CHECKLISTS.md with all manual test steps
```

---

## Reporting Test Results

### Generate Reports
```bash
# Parse test cases from Excel
npm run test:parse-cases

# Generate JSON report
npm run test:report:json

# Generate Markdown report
npm run test:report:markdown

# Generate HTML dashboard
npm run test:report:html
```

### Report Locations
- **Results**: `test-results/results.jsonl` (raw results)
- **Summary**: `test-results/summary.json`
- **Report**: `test-results/report.md`
- **Dashboard**: `test-results/dashboard.html`

### Sample Summary Report
```json
{
  "timestamp": "2026-10-04T10:30:00Z",
  "totalCases": 791,
  "executed": 450,
  "passed": 425,
  "failed": 25,
  "blocked": 0,
  "notRun": 341,
  "passRate": 94.4,
  "byPriority": {
    "p0": {
      "total": 306,
      "passed": 299,
      "failed": 7,
      "passRate": 97.7
    },
    "p1": {
      "total": 325,
      "passed": 310,
      "failed": 15,
      "passRate": 95.4
    },
    "p2": {
      "total": 160,
      "passed": 116,
      "failed": 3,
      "passRate": 97.5
    }
  }
}
```

---

## Critical Issues & Escalation

### Issues Found
When a test fails:

1. **Record the failure**:
   ```bash
   npm run test:log-failure -- --tc-id TC-XXX --error "Description" --screenshot
   ```

2. **Analyze root cause**:
   - Check application logs
   - Review database state
   - Examine network requests

3. **Create issue** (if not known):
   ```bash
   npm run test:create-issue -- --tc-id TC-XXX --priority critical
   ```

### Escalation Matrix
- **P0 Failure** → Immediate escalation (within 1 hour)
- **Multiple P1 Failures** → Report with root cause analysis
- **Regression** (feature worked before) → Immediate escalation
- **Environment Issue** → Escalate to DevOps

---

## Continuous Testing

### Automated Nightly Runs
```bash
# Set up cron job
# 0 2 * * * cd /home/user/GoKesari && npm run test:nightly

# Run nightly test suite
npm run test:nightly
```

### Monitor Test Health
```bash
# Dashboard
npm run test:dashboard

# Watch mode
npm run test:watch
```

---

## Troubleshooting

### Test Environment Issues

**Q: "Cannot reach test.gokesari.com"**
```bash
# Check connectivity
curl -I https://test.gokesari.com
# Check DNS
nslookup test.gokesari.com
```

**Q: "Test accounts cannot sign in"**
- Verify test accounts exist in database
- Check if LDAP/SSO is configured
- Review auth service logs

**Q: "Database connection refused"**
- Ensure test DB is running
- Check connection string in .env.test
- Verify firewall rules

**Q: "Payment gateway failing"**
- Verify sandbox credentials
- Check API keys in environment
- Review payment service logs

---

## Performance Benchmarks

### Expected Test Duration
- **Preflight**: 5-10 minutes
- **P0 Tests**: 20-30 hours (can parallelize)
- **P1 Tests**: 30-40 hours (can parallelize)
- **P2 Tests**: 20-30 hours (can parallelize)
- **Total Sequential**: 70-110 hours
- **Total Parallel** (8 threads): 10-15 hours

### System Requirements
- **CPU**: 4+ cores recommended
- **RAM**: 8GB minimum
- **Network**: Stable internet connection
- **Browser**: Chrome/Chromium latest

---

## Resources & References

### Excel Files
- Test Cases: `test-cases.xlsx` (791 cases)
- Open Features: `open-features.xlsx` (157 features)

### Documentation
- TEST_EXECUTION_PLAN.md - Overall strategy
- TEST_EXECUTION_GUIDE.md - This file
- tests/test-case-parser.ts - Excel parser
- tests/e2e-test-runner.ts - E2E test framework

### Change Log
**Oct 3, 2026**:
- Added 213 new test cases
- Added 3 new requirements (NEW-008 to NEW-010)
- Added field-level validation cases
- Added log out test cases
- Added sell/purchase/inventory cases

**Oct 4, 2026**:
- Added 106 new test cases
- Treated 24 open features as completed
- Created positive and negative cases for all open features
- Finalized test execution framework

---

## Next Steps

1. **Verify Test Environment**:
   ```bash
   npm run test:preflight
   ```

2. **Run Core Tests**:
   ```bash
   npm run test:p0
   ```

3. **Review Failures**:
   ```bash
   npm run test:report:markdown
   ```

4. **Log Results**:
   ```bash
   npm run test:publish-results
   ```

---

**For issues or questions, contact**: QA Team  
**Last Updated**: October 4, 2026  
**Next Review**: As testing progresses

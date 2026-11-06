import { Alert } from "@/components/ui";
import { LEGAL_ENTITY } from "@/lib/legal-docs";

export const metadata = { title: "Profit Allocation & Social Welfare Policy (Draft)" };

/**
 * Owner's draft policy (6 Nov 2026): after costs, investor obligations and
 * Board-approved reinvestment, 100% of the remaining surplus goes to social
 * welfare. Published as a DRAFT while the company's Chartered Accountant
 * reviews it; the [__] figures are set on the CA's advice. Only Sections 1-8 are
 * published (owner, 6 Nov 2026); the CA review points, review/amendment
 * section and Board signature block stay internal.
 */
const DRAFT_DATE = "6 November 2026";

const steps: { part: string; step: number; to: string; rule: string; strong?: boolean }[] = [
  { part: "A. Committed obligations", step: 1, to: "Operating expenses", rule: "Paid as incurred, within the board-approved annual budget." },
  { part: "A. Committed obligations", step: 2, to: "Investor returns (interest / agreed return)", rule: "Paid as per each investment agreement; a finance cost." },
  { part: "A. Committed obligations", step: 3, to: "Taxes and statutory dues", rule: "GST, income tax, TDS and all other statutory payments." },
  { part: "A. Committed obligations", step: 4, to: "Investor principal repayment", rule: "Instalments due in the year, as per each agreement." },
  { part: "A. Committed obligations", step: 5, to: "Operating reserve", rule: "Topped up until it equals [__] months of operating expenses." },
  { part: "B. Board priority", step: 6, to: "Approved reinvestment", rule: "Expansion or new projects approved by the Board, capped at [__]% of net profit (Section 6)." },
  { part: "C. Social welfare", step: 7, to: "Social Welfare Fund", rule: "The entire remaining surplus after Parts A and B.", strong: true },
];

const definitions: [string, string][] = [
  ["Operating expenses", "All costs of running the platform: salaries and remuneration of all employees, directors and officers, delivery partners, technology, hosting, marketing, rent, professional fees, compliance and depreciation."],
  ["Investor capital", "Money brought in by investors, structured as a loan or debt-like instrument (for example loans, debentures or similar), repayable with an agreed return."],
  ["Investor return", "The agreed interest or fixed return on investor capital, treated as a finance cost."],
  ["Net profit", "Profit after tax as per the audited financial statements, after operating expenses and investor returns."],
  ["Operating reserve", "A cash buffer kept for running costs, emergencies and lean months."],
  ["Approved reinvestment", "Money from net profit used for expansion or new projects, within the cap in Section 6 and approved by the Board."],
  ["Distributable surplus", "Net profit left after investor principal repayment due for the year, the operating reserve top-up and approved reinvestment. This is the amount for social welfare."],
  ["Social Welfare Fund", "The account or entity through which the distributable surplus is spent on welfare (Section 7)."],
];

export default function SocialWelfarePolicyPage() {
  return (
    <>
      <h1>Profit Allocation &amp; Social Welfare Policy</h1>
      <p>Draft dated: {DRAFT_DATE}</p>

      <div className="not-prose my-4" data-testid="policy-draft-notice">
        <Alert tone="warning" title="Draft policy — under review">
          This policy is a draft being reviewed by our Chartered Accountant.
          Figures shown as [__] will be fixed after that review, and the final
          version takes effect once approved by the Board of Directors.
        </Alert>
      </div>

      <p>
        <strong>{LEGAL_ENTITY.legalName}</strong>, operator of gokesari.com,
        commits that after all costs, investor obligations and approved
        reinvestment, <strong>100% of the remaining surplus is used for social welfare</strong>.
      </p>

      <h2>1. Purpose and scope</h2>
      <p>
        This policy fixes how every rupee earned by gokesari.com is applied,
        so that the remaining surplus reaches social welfare in a clear,
        auditable way.
      </p>
      <ul>
        <li><strong>Applies to:</strong> all revenue, income and profit from the gokesari.com marketplace (website and mobile apps), including registration fees, commissions, delivery charges, subscriptions, advertising and any other platform income.</li>
        <li><strong>Applies to new projects:</strong> any new business line funded from gokesari.com surplus follows this same policy.</li>
        <li><strong>Binding on:</strong> the Board of Directors, the CEO and all officers who approve spending, investment or distributions.</li>
      </ul>

      <h2>2. Guiding principles</h2>
      <ol>
        <li><strong>Local shops first.</strong> gokesari.com exists to bring more customers and more business to local shops and service providers.</li>
        <li><strong>Surplus belongs to society.</strong> After all obligations in Section 4, 100% of what remains is used for social welfare. No part of the remaining surplus is paid to promoters or shareholders as dividend.</li>
        <li><strong>Investors are repaid fairly.</strong> Investor capital is treated as a loan. It is repaid in full with the agreed return, as an obligation of the business.</li>
        <li><strong>Growth multiplies welfare.</strong> Limited, approved reinvestment is allowed so the platform grows and the welfare contribution grows with it.</li>
        <li><strong>Fair pay, not profit-taking.</strong> All employees, directors and officers receive reasonable, board-approved salaries as an operating expense.</li>
        <li><strong>Transparency.</strong> Allocations are recorded, audited and reported publicly every year.</li>
      </ol>

      <h2>3. Definitions</h2>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr><th>Term</th><th>Meaning in this policy</th></tr>
          </thead>
          <tbody>
            {definitions.map(([term, meaning]) => (
              <tr key={term}><td><strong>{term}</strong></td><td>{meaning}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>4. Order of application</h2>
      <p>
        Each financial year, income is applied strictly in this order, in
        three parts. Each part is met in full before the next one starts.
      </p>
      <div className="overflow-x-auto" data-testid="policy-waterfall">
        <table>
          <thead>
            <tr><th>Part</th><th>Step</th><th>Applied to</th><th>Rule</th></tr>
          </thead>
          <tbody>
            {steps.map((s) => (
              <tr key={s.step}>
                <td>{s.part}</td>
                <td>{s.step}</td>
                <td>{s.strong ? <strong>{s.to}</strong> : s.to}</td>
                <td>{s.strong ? <strong>{s.rule}</strong> : s.rule}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Part A covers every cost and obligation the company must meet. Only
        Steps 1 and 2 are expenses in the books; taxes, principal repayment
        and the reserve are met from profit and cash, and are grouped here as
        committed obligations.
      </p>
      <p>
        After the audited accounts are adopted, the Board approves the annual
        allocation statement, which certifies the amounts under Parts A and B.
        The entire remaining surplus so certified is transferred to the Social
        Welfare Fund. The Board certifies the amount; it does not decide
        whether to transfer it.
      </p>

      <h2>5. Investor capital and returns</h2>
      <p>Investor money is a loan to the business, repaid with a fair return, never a permanent claim on the surplus.</p>
      <ul>
        <li><strong>Structure:</strong> investor capital is raised as a loan, debenture or other debt-like instrument, with a fixed tenure and repayment schedule.</li>
        <li><strong>Return:</strong> an agreed interest rate or fixed return of [__]% per year, paid as a finance cost (Step 2).</li>
        <li><strong>Repayment:</strong> principal repaid as per schedule (Step 4). Early repayment allowed with Board approval when the operating reserve is full.</li>
        <li><strong>No share in surplus:</strong> once principal and agreed return are paid, the investor has no further claim on profit. The distributable surplus goes to welfare.</li>
        <li><strong>Disclosure:</strong> every investor receives this policy before investing and signs an acknowledgement.</li>
        <li><strong>Promoter shareholders:</strong> existing shareholders agree not to take dividends from the distributable surplus, recorded by board and shareholder resolution.</li>
      </ul>

      <h2>6. Reserves and reinvestment</h2>
      <p>Reinvestment is allowed only to grow the platform and, through it, future welfare; it is capped so welfare is never squeezed out.</p>
      <ul>
        <li><strong>Operating reserve:</strong> maintained at [__] months of operating expenses. Once full, no further top-up is taken.</li>
        <li><strong>Reinvestment cap:</strong> up to [__]% of net profit in a year. Any higher amount needs a special Board resolution recording the reason.</li>
        <li><strong>Purpose test:</strong> reinvestment must serve the mission, such as new cities, technology, the mobile apps, shop onboarding, or a new project that supports local businesses.</li>
        <li><strong>New projects:</strong> a new project funded from surplus has its own budget and expected outcome, and its profits flow back into this same order of application.</li>
        <li><strong>Minimum welfare share:</strong> whatever the reinvestment, at least [__]% of net profit goes to the Social Welfare Fund every profitable year.</li>
      </ul>

      <h2>7. Social Welfare Fund</h2>
      <p>The distributable surplus is transferred to the Social Welfare Fund within [__] days of the audited accounts being adopted.</p>
      <ul>
        <li>
          <strong>Delivery route:</strong> a dedicated Section 8 company or
          registered trust funded by the company each year, or donations to
          registered NGOs and trusts holding valid 12A and 80G registration.
        </li>
        <li><strong>Focus areas:</strong> education, health and nutrition, livelihood and skill building for small shopkeepers and delivery partners, women and community empowerment, environment, and local community development.</li>
        <li><strong>Selection:</strong> projects are approved by the Board (or a Welfare Committee it appoints) against clear outcomes and a budget.</li>
        <li><strong>No benefit to insiders:</strong> funds are not used for the personal benefit of directors, shareholders, investors or their relatives.</li>
        <li><strong>Unspent amounts:</strong> stay in the Fund and are carried to the next year; they never return to the company for other use.</li>
        <li><strong>CSR:</strong> once the company crosses the Section 135 thresholds, statutory CSR spending is met from this Fund and reported as required.</li>
      </ul>

      <h2>8. Governance and transparency</h2>
      <ul>
        <li><strong>Annual allocation statement:</strong> prepared after the audit, showing each step of Section 4 in rupees, and approved by the Board.</li>
        <li><strong>Separate account:</strong> the Social Welfare Fund is held in a separate bank account or entity, with its own books.</li>
        <li><strong>Audit:</strong> the allocation and the Fund are covered by the statutory audit, or a separate audit if run through a trust or Section 8 company.</li>
        <li><strong>Public Impact Report:</strong> published on gokesari.com every year, showing amount allocated, projects funded and outcomes.</li>
        <li><strong>Conflicts of interest:</strong> any director or officer linked to a beneficiary declares it and stays out of that decision.</li>
        <li><strong>Remuneration:</strong> remuneration of all directors and key officers is fixed by the Board at market-reasonable levels, and related-party payments are disclosed in the annual accounts.</li>
      </ul>

      <p>
        Questions about this policy? Write to{" "}
        <a href={`mailto:${LEGAL_ENTITY.supportEmail}`}>{LEGAL_ENTITY.supportEmail}</a>{" "}
        or visit <a href="/contact">Contact Us</a>.
      </p>
    </>
  );
}

import { CURRENT_POLICY_VERSION, LEGAL_ENTITY } from "@/lib/legal-docs";

export const metadata = { title: "Privacy Policy" };

export default function PrivacyPolicyPage() {
  return (
    <>
      <h1>Privacy Policy</h1>
      <p>Last updated: {CURRENT_POLICY_VERSION}</p>

      <p>
        This Privacy Policy explains what personal data {LEGAL_ENTITY.legalName} (&quot;the
        Platform&quot;, &quot;we&quot;, &quot;us&quot;) collects when you use this website, why we
        collect it, how it is used and stored, who it is shared with, and the
        rights you have over it. It is written to align with the Digital
        Personal Data Protection Act, 2023 (DPDPA) and the Information
        Technology Act, 2000 and its rules.
      </p>

      <h2>1. What we collect</h2>
      <ul>
        <li>
          <strong>Account data</strong> — name, email address, and profile
          photo, provided by Google when you sign in with Google OAuth. We do
          not receive or store your Google password.
        </li>
        <li>
          <strong>Contact and delivery data</strong> — phone number, delivery
          address, and (for shop owners) shop name, address, and business
          contact details.
        </li>
        <li>
          <strong>Transaction data</strong> — orders placed, subscription
          schedules, wallet top-ups and balances, vouchers applied, and refund
          history.
        </li>
        <li>
          <strong>Payment data</strong> — payments are processed by Cashfree,
          our payment gateway partner. We do not receive or store your card,
          UPI PIN, or net-banking credentials; we retain only the payment
          reference/transaction ID Cashfree returns to confirm a payment.
        </li>
        <li>
          <strong>Location data</strong> — this platform does not currently
          request or collect device GPS/location data. If a &quot;find shops
          near me&quot; feature using device location is introduced in future,
          it will only run after you explicitly grant permission through an
          on-screen consent prompt, and this policy will be updated first.
        </li>
        <li>
          <strong>Usage and device data</strong> — pages visited, actions
          taken (e.g. cart activity), IP address, and browser/device
          information, collected via server logs and essential session
          cookies. See our{" "}
          <a href="/legal/cookie-policy">Cookie Policy</a> for details.
        </li>
      </ul>

      <h2>2. Why we collect it</h2>
      <ul>
        <li>To create and secure your account and authenticate sign-in.</li>
        <li>To process orders, deliveries, subscriptions, and payments.</li>
        <li>To operate the wallet and voucher features you choose to use.</li>
        <li>To respond to support requests and grievances.</li>
        <li>To detect fraud, abuse, and rate-limit misuse of the platform.</li>
        <li>To comply with tax, accounting, and legal record-keeping obligations.</li>
      </ul>

      <h2>3. How data is stored and secured</h2>
      <p>
        Data is stored in an access-controlled PostgreSQL database. Money
        values and financial mutations are processed with row-level locking
        and audit logging so that every payment, wallet, and refund change is
        traceable to an actor and timestamp. Access to administrative and
        financial data is restricted by role (see our role-based access
        control) — only authorised operators/admins can view records beyond
        your own.
      </p>

      <h2>4. Who your data is shared with</h2>
      <ul>
        <li>
          <strong>Cashfree</strong> (payment gateway) — to process payments
          and refunds. Cashfree acts as an independent data controller for
          the payment details you provide directly to it.
        </li>
        <li>
          <strong>Google</strong> — for authentication, if you sign in with
          Google.
        </li>
        <li>
          <strong>The shop you order from</strong> — receives only what is
          necessary to fulfil your order: your name, delivery address, phone
          number, and order contents. Shop owners never receive your precise
          device location or payment credentials.
        </li>
        <li>
          We do not sell personal data to third parties, and we do not share
          it for third-party advertising.
        </li>
      </ul>

      <h2>5. Seller verification (shop owners only)</h2>
      <p>
        If you register a shop, we verify its business documents — PAN,
        GSTIN (or your declaration that you are not GST-registered), Udyam
        registration (optional), FSSAI licence or registration (for food
        shops) and Shops &amp; Establishments certificate or intimation
        receipt — before it can sell. We ask for your consent each time,
        and use these documents only to verify your shop, to re-check them
        while it is listed, and to show buyers the seller details the
        Consumer Protection (E-Commerce) Rules 2020 require.
      </p>
      <ul>
        <li>
          Document numbers are sent to our verification partner, which
          checks them against the government record (Income Tax, GSTN,
          Udyam, FSSAI or the Labour Department) and is bound by contract
          to use them only for that check.
        </li>
        <li>
          We store numbers and uploaded certificates encrypted, show only a
          masked form, and record who viewed an uploaded certificate.
        </li>
        <li>
          We never ask for, collect or store your Aadhaar number. If a
          certificate you upload shows one, please mask it first.
        </li>
        <li>
          After your shop stops selling, verification data is kept for a
          limited period for legal and dispute purposes and then erased
          automatically; you can ask for earlier erasure where the law
          allows.
        </li>
      </ul>

      <h2>6. Data retention</h2>
      <p>
        Account and order data is retained for as long as your account is
        active and thereafter as required for tax, accounting, dispute, and
        legal record-keeping purposes. Grievance records are retained to
        demonstrate compliance with grievance-redressal timelines. You may
        request erasure of data that is not otherwise required to be retained
        by law (see &quot;Your rights&quot; below).
      </p>

      <h2>7. Your rights</h2>
      <p>Under the DPDPA and applicable law, you have the right to:</p>
      <ul>
        <li>Access the personal data we hold about you.</li>
        <li>Request correction or updating of inaccurate data.</li>
        <li>
          Request erasure of your data, subject to our legal obligation to
          retain certain records (e.g. transaction and tax records).
        </li>
        <li>Withdraw consent for optional processing at any time.</li>
        <li>Raise a grievance about how your data is handled (see below).</li>
      </ul>

      <h2>8. Consent</h2>
      <p>
        By creating an account you agree to this Privacy Policy and our{" "}
        <a href="/legal/terms">Terms &amp; Conditions</a>. We record when and
        against which version of this policy your consent was given, so it
        can be demonstrated if required. You may withdraw consent for
        non-essential communications at any time from your profile settings.
      </p>

      <h2>9. Grievance / privacy contact</h2>
      <p>
        For any question or complaint about how your personal data is
        handled, contact our Grievance Officer — see the{" "}
        <a href="/legal/grievance-redressal">Grievance Redressal</a> page —
        or write to {LEGAL_ENTITY.supportEmail}.
      </p>
    </>
  );
}

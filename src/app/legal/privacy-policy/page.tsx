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
          <strong>Location data</strong> — your device&apos;s location, only if
          you allow it, to show shops near you; the map pin of addresses you
          save; and, for delivery partners, their location while they are
          online. See section 2.
        </li>
        <li>
          <strong>Search history</strong> — what you search for in the search
          box, saved with the time of the search and, when you are signed in,
          your account. Searches made while you are not signed in are saved
          without any link to you. We use your own searches to show you your
          recent searches, and everyone&apos;s searches to show what is
          popular: any search made at least twice in the last 7 days, by you
          or by others, can appear under &quot;Trending&quot; for every
          visitor, without any name or account. You can delete the searches
          saved with your account at any time with &quot;Clear&quot; above
          your recent searches in the search box.
        </li>
        <li>
          <strong>App notification data</strong> — if you use the GoKesari
          app and allow notifications, the app gives us a notification token
          for your phone, with its platform (Android or iOS) and, when the app
          provides them, a device identifier and the phone&apos;s name. We
          store these with your account to send notifications to your phone.
          You can turn notifications off at any time in your phone&apos;s
          settings. A token stops being used for your account when Apple or
          Google report that
          it no longer works (for example after the app is removed), when the
          same phone gets a new token, when someone else signs in to the app
          on that phone, or when more phones are registered to your account
          than we allow.
        </li>
        <li>
          <strong>Usage and device data</strong> — pages visited, actions
          taken (e.g. cart activity), IP address, and browser/device
          information, collected via server logs and essential session
          cookies. See our{" "}
          <a href="/legal/cookie-policy">Cookie Policy</a> for details.
        </li>
      </ul>

      <h2>2. Location data</h2>
      <p>
        We use location only to show the shops near you and whether they
        deliver to you, and to deliver your orders. Your device shares its
        location only after you allow it in your browser&apos;s or phone&apos;s
        permission prompt. You can turn it off there at any time; the site
        then works from a PIN code you type instead.
      </p>
      <ul>
        <li>
          <strong>Your delivery area (&quot;Deliver to&quot;).</strong> When you
          allow location, or tap &quot;Find your location&quot; or &quot;Use my
          current location&quot;, your device&apos;s position is rounded to about
          11 metres and saved, with a short address for it, in a cookie on
          your device (<code>gk_location</code>) for 30 days. It is not stored
          in our database. When the site finds your location by itself, a
          location you already chose, or your saved address, is kept instead.
          You can remove it at any time with &quot;Clear location&quot; under
          &quot;Deliver to&quot;, or by clearing your cookies.
        </li>
        <li>
          <strong>Nearby shops.</strong> The Nearby screen sends your position
          to our server to work out how far each shop is. It is not stored,
          except as your delivery area as described above when you have not
          chosen one.
        </li>
        <li>
          <strong>The address shown for your position.</strong> To show a
          readable address instead of coordinates, our server sends the
          rounded position, with no name, account or contact details, to
          OpenStreetMap&apos;s address service (Nominatim, run by the
          OpenStreetMap Foundation). The request comes from our server, so
          OpenStreetMap does not receive your IP address. The answer is kept
          in our server&apos;s memory for up to a day, so the same spot is not
          looked up twice.
        </li>
        <li>
          <strong>Saved addresses.</strong> When you save a delivery address
          and place its pin on the map, we store the pin&apos;s coordinates with
          the address, so the shop and the delivery partner can find you.
          Searching for an address on the map uses Google Maps (section 5).
        </li>
        <li>
          <strong>Delivery partners.</strong> If you deliver for GoKesari, your
          phone shares its location while you are online. We keep only your
          latest position, replaced with each update, to offer you nearby
          orders; while you are carrying an order, the customer of that order
          sees it so they can follow the delivery. Sharing stops when you go
          offline.
        </li>
        <li>
          We do not sell location data, use it for advertising, or keep a
          history of where customers have been. Shop owners never receive
          your device&apos;s location.
        </li>
      </ul>

      <h2>3. Why we collect it</h2>
      <ul>
        <li>To create and secure your account and authenticate sign-in.</li>
        <li>To process orders, deliveries, subscriptions, and payments.</li>
        <li>To operate the wallet and voucher features you choose to use.</li>
        <li>
          To show your recent searches and the searches that are trending.
        </li>
        <li>To send notifications to the GoKesari app on your phone.</li>
        <li>To respond to support requests and grievances.</li>
        <li>To detect fraud, abuse, and rate-limit misuse of the platform.</li>
        <li>To comply with tax, accounting, and legal record-keeping obligations.</li>
      </ul>

      <h2>4. How data is stored and secured</h2>
      <p>
        Data is stored in an access-controlled PostgreSQL database. Money
        values and financial mutations are processed with row-level locking
        and audit logging so that every payment, wallet, and refund change is
        traceable to an actor and timestamp. Access to administrative and
        financial data is restricted by role (see our role-based access
        control) — only authorised operators/admins can view records beyond
        your own.
      </p>

      <h2>5. Who your data is shared with</h2>
      <ul>
        <li>
          <strong>Cashfree</strong> (payment gateway) — to process payments
          and refunds. Cashfree acts as an independent data controller for
          the payment details you provide directly to it.
        </li>
        <li>
          <strong>Google</strong> — for authentication, if you sign in with
          Google; and Google Maps, when you search for an address or place a
          pin on the map, or type a PIN code we have no shops for, to find
          that address or PIN code on the map.
        </li>
        <li>
          <strong>OpenStreetMap Foundation</strong> (Nominatim) — a rounded
          position, with no name, account or contact details, to turn it
          into a readable address (section 2).
        </li>
        <li>
          <strong>Expo</strong> (push notification service) — when we send a
          notification to the GoKesari app: your phone&apos;s notification
          token and the notification&apos;s title, text and the link it opens,
          so it can be delivered. Expo passes the notification to Apple (for
          iPhones) or Google (for Android phones), which deliver it to your
          phone.
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

      <h2>6. Seller verification (shop owners only)</h2>
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

      <h2>7. Data retention</h2>
      <p>
        Account and order data is retained for as long as your account is
        active and thereafter as required for tax, accounting, dispute, and
        legal record-keeping purposes. Grievance records are retained to
        demonstrate compliance with grievance-redressal timelines. Searches
        saved with your account are kept until you clear them; searches made
        while you were not signed in are kept without any link to you. App
        notification tokens are kept with your account, also after they stop
        being used. You may
        request erasure of data that is not otherwise required to be retained
        by law (see &quot;Your rights&quot; below).
      </p>

      <h2>8. Your rights</h2>
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

      <h2>9. Consent</h2>
      <p>
        By creating an account you agree to this Privacy Policy and our{" "}
        <a href="/legal/terms">Terms &amp; Conditions</a>. We record when and
        against which version of this policy your consent was given, so it
        can be demonstrated if required. You may withdraw consent for
        non-essential communications at any time from your profile settings.
      </p>

      <h2>10. Grievance / privacy contact</h2>
      <p>
        For any question or complaint about how your personal data is
        handled, contact our Grievance Officer — see the{" "}
        <a href="/legal/grievance-redressal">Grievance Redressal</a> page —
        or write to {LEGAL_ENTITY.supportEmail}.
      </p>
    </>
  );
}

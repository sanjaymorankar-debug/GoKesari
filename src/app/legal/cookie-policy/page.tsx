import { CURRENT_POLICY_VERSION } from "@/lib/legal-docs";

export const metadata = { title: "Cookie Policy" };

export default function CookiePolicyPage() {
  return (
    <>
      <h1>Cookie Policy</h1>
      <p>Last updated: {CURRENT_POLICY_VERSION}</p>

      <p>
        We use a small number of first-party cookies to run the site: to
        keep you signed in, to protect forms, and to remember choices such as
        your delivery location. We do not currently use third-party
        advertising or cross-site tracking cookies.
      </p>

      <h2>Cookies we use</h2>
      <ul>
        <li>
          <strong>Session/authentication cookie</strong> — keeps you signed
          in between requests. Set by Auth.js when you sign in; removed when
          you sign out or the session expires.
        </li>
        <li>
          <strong>CSRF protection cookie</strong> — protects forms and
          payment actions from cross-site request forgery.
        </li>
        <li>
          <strong>Delivery location cookie</strong> (<code>gk_location</code>)
          — remembers the delivery area you chose or your device found, so
          the shops near you are shown. Set only after you choose a location
          or allow your device to share it; kept for 30 days or until you
          clear it (&quot;Clear location&quot; under &quot;Deliver to&quot;). It holds
          a place name and a position rounded to about 11 metres, never your
          name or account. See the{" "}
          <a href="/legal/privacy-policy">Privacy Policy</a>, section 2.
        </li>
      </ul>

      <h2>Analytics</h2>
      <p>
        This site does not currently run third-party analytics or
        advertising trackers. If that changes, this policy will be updated
        first and, where required, we will ask for your consent before any
        non-essential cookie is set.
      </p>

      <h2>Managing cookies</h2>
      <p>
        Because the cookies we use today are essential to signing in and
        checking out, disabling them will prevent you from using
        account-based features of the site. You can clear or block cookies
        at any time from your browser settings.
      </p>
    </>
  );
}

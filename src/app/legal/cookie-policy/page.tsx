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
        <li>
          <strong>Language cookie</strong> (<code>gk_lang</code>) — remembers
          the language you picked for the site (English, Hindi or Marathi), so
          pages open in that language. Set only when you choose a language with
          the language switch (EN / हिं / मरा); kept for 1 year or until you
          choose another language or clear your cookies. It holds only the
          language you chose, never your name or account.
        </li>
        <li>
          <strong>Referral cookie</strong> (<code>gk_ref</code>) — remembers
          the referral code from a friend&apos;s referral link, so it can be
          filled in for you when you sign up or offered to you once you are
          signed in. Set only when you open a referral link
          (gokesari.com/r/&hellip;); kept for 30 days or until you clear your
          cookies. It holds only the referral code from the link, never your
          name or account.
        </li>
        <li>
          <strong>App sign-in cookie</strong> (<code>gk_mobile_auth</code>) —
          used only when you sign in to the GoKesari app with Google: it
          connects the browser page that opens for Google sign-in to the app
          that opened it, so your sign-in is handed back only to that app. Set
          when you tap &quot;Continue with Google&quot; in the app; kept for at
          most 10 minutes and removed as soon as sign-in finishes. It holds a
          one-time security value and the app&apos;s identifier, never your
          name or password.
        </li>
        <li>
          <strong>Seller shop cookie</strong> (<code>gk_shop</code>) — for
          sellers only: remembers which of your shops Seller Central shows when
          you have more than one. Set only when you pick a shop in Seller
          Central&apos;s shop switcher; kept for 1 year or until you pick
          another shop or clear your cookies. It holds only an internal
          reference to the shop.
        </li>
        <li>
          <strong>Zoho Books connection cookie</strong>{" "}
          (<code>gk_zoho_oauth</code>) — for sellers only: protects the step
          that connects your shop to Zoho Books by checking that the Zoho
          sign-in finishes in the same browser it started in. Set when you
          press &quot;Connect Zoho Books&quot; on your shop&apos;s Integrations
          page; kept for at most 10 minutes and removed when Zoho sends you
          back to GoKesari. It holds a one-time random security value only.
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

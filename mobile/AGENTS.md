This is the GoKesari Android/iOS app: an Expo/React Native shell that shows the
GoKesari website in a WebView and adds native pieces (Google sign-in hand-off,
location, share, print, downloads, deep links). Read README.md first. The
repository root's CLAUDE.md scope rule (GoKesari only) applies here too.

## Where things go

- Website features belong in the website (repository root), not here. The app
  picks them up automatically.
- Native behaviour: `src/App.tsx` (screen, link handling), `src/bridge-script.ts`
  (script injected into pages) + `src/bridge.ts` (its native side),
  `src/navigation-policy.ts` (where a link may go).
- Contract with the website: `src/config.ts` (UA token) and `app.config.ts`
  (schemes, deep-link paths) must match `src/lib/mobile-app.ts` at the root;
  `tests/unit/mobile-app.test.ts` at the root checks it.
- There is a single screen, so there is no Expo Router.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. Before writing code against an
Expo, EAS or React Native API, read the installed package's own types and
source in `node_modules` (the `expo` major version is in package.json), or the
versioned docs at `https://docs.expo.dev/versions/v<major>.0.0/`.

## Commands

```bash
npx expo install <package>  # ALWAYS use instead of npm add — resolves SDK-compatible versions
npm run typecheck
npm run lint
npm test                    # plain-TypeScript modules only (no React Native imports)
npx expo-doctor
npx expo export --platform android --platform ios --output-dir /tmp/expo-export   # bundles like a release build
```

Run lint, typecheck and tests before declaring any task done.

## Rules

- `ios/` and `android/` are generated (Continuous Native Generation). Never
  create or edit them by hand — configure native behaviour in `app.config.ts`
  and config plugins.
- `bridge-script.ts` is a string, not a function: Hermes drops function
  source in release builds. Keep it plain ES2017 and cover changes in
  `src/__tests__/bridge-script.test.ts`, which runs it against a fake page.
- Builds, signing and store submission run on EAS (`npx eas-cli@latest …`).

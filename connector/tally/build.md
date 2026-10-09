# Building the connector

The GitHub Actions workflow `.github/workflows/connector-tally.yml` builds it
on `windows-latest` and uploads `gokesari-connector-windows-x64` (a folder
with `gokesari-connector.exe`, the WinSW service wrapper
`GoKesariConnector.exe` + `GoKesariConnector.xml`, `install.cmd`,
`uninstall.cmd`, `README.md`).

Steps it runs (Node 22 single executable application):

```
node --experimental-sea-config sea-config.json
copy node.exe dist\gokesari-connector.exe
npx postject dist\gokesari-connector.exe NODE_SEA_BLOB dist\sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
```

Before giving the exe to shops it should be code-signed (pending action in
docs/three-modules-2026-10/PLAN.md); unsigned, Windows SmartScreen warns on
first run.

`connector.cjs` has no dependencies, so the same file runs with `node` on any
OS for testing against a Tally on the same machine.

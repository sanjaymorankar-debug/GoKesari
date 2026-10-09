# GoKesari Connector for TallyPrime

Connects TallyPrime on your shop computer to GoKesari:

- **GoKesari → Tally**: a sales invoice for every GoKesari order delivered to
  a customer, and a credit note for every refund or return. Tally's stock goes
  down with the invoice.
- **Tally → GoKesari**: your items' stock, selling price, MRP, HSN and GST
  rate. The connector checks Tally every 2 minutes and sends the list only
  when something changed.

It only makes outgoing connections (to GoKesari over HTTPS, and to Tally on
this computer). Nothing on your computer is opened to the internet.

## Install

1. In TallyPrime: **F1 Help → Settings → Connectivity → Client/Server
   configuration** — set *TallyPrime acts as* **Both** (or Server) and port
   **9000**. Keep Tally open with your company loaded.
2. In GoKesari: **Shop settings → Integrations → TallyPrime**. Enter the
   company name exactly as in Tally and the ledger names, then press
   **New connector token**. Copy the token (it is shown once).
3. Unzip this folder to `C:\GoKesari\Connector`.
4. Right-click **Command Prompt → Run as administrator**, then:
   ```
   cd C:\GoKesari\Connector
   install.cmd https://gokesari.com gkc_your_token
   ```
   (test shop: `https://test.gokesari.com`)
5. GoKesari shows **Connector online** within a minute.

The connector runs as the Windows service *GoKesari Connector (Tally)* and
starts with Windows. Logs are in the same folder (`GoKesariConnector.out.log`).

## Remove

`uninstall.cmd` (as administrator), then revoke the token in GoKesari.

## Run without installing (for testing)

```
node connector.cjs setup --server https://test.gokesari.com --token gkc_…
node connector.cjs run
```

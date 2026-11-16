# G1: buying the database server (owner's checklist)

16-Nov-2026. About 20 minutes, phone or Mac. You do these steps yourself; no session buys anything or sees a password.

**Status, 16-Nov-2026 21.30 IST:**
- **A:** done. Admin key made at 19.55 IST.
- **B:** VPS bought at 21.16 IST: **KVM 4**, Ubuntu 24.04, with the admin key.
  - It was set up in **Kuala Lumpur** (Hostinger data centre 21, `kul`), not Mumbai.
  - It must be moved to Mumbai before the build (step 3a).
- **C:** not done yet.

**Never paste a password or key into a chat.** Two things are fine to send:
- the VPS's IP address;
- the Cloudflare account ID.

## A. Before buying (1 minute)

- [ ] Ask the session: **"OK, make the admin SSH key."** It runs `scripts/vps-db/mac/make-admin-key.sh` on your Mac and sends you one line starting `ssh-ed25519 …`.
  - This is a **public** key, safe to copy.
  - You paste it in step B6.

## B. Hostinger: buy the VPS (hPanel)

- [ ] **1.** hPanel → **VPS** → buy a new VPS → **KVM 4** (4 vCPU, 16 GB RAM, 200 GB NVMe).
  - The owner chose KVM 4 over KVM 2 on 16-Nov-2026, so the app can move onto it later.
  - The kit works on KVM 2 or larger.
- [ ] **2.** Term: **24 months**.
  - Expected: ₹26,376 + 18 % GST ≈ **₹31,123** in total. That is ₹1,099 a month; it renews at ₹2,399 a month.
  - If the cart shows much more, stop and tell the session.
- [ ] **3.** Location: **India (Mumbai)**.
  - Check it after purchase: hPanel → **VPS** → the server → **Overview** must show **Mumbai**.
  - The session also checks it through the Hostinger API (data centre 23, `mum2`).
- [ ] **3a.** If it shows another city:
  1. **VPS** → select the server.
  2. In **VPS Plan details**, click **Change** next to the location.
  3. Choose **India (Mumbai)**, then **Next**.
  4. If asked: **Ubuntu 24.04**, the root password from step 5, and the `gokesari-db-admin` SSH key from step 6.

  This reinstalls the server and wipes it. Do it only while the server is empty, before the build. The IP address may change; send the new one (step 9).
- [ ] **4.** Operating system: **Plain OS → Ubuntu 24.04**.
  - No control panel, no app template.
  - Skip any extra add-ons.
- [ ] **5.** Root password:
  - let your password manager make one (20+ characters);
  - save it as **"GoKesari DB VPS root"**;
  - paste it into hPanel.
- [ ] **6.** SSH key: add the `ssh-ed25519 …` line from step A, named `gokesari-db-admin`.
- [ ] **7.** Backups: keep Hostinger's **free weekly backup** on.
  - Don't buy the paid daily backups; our own backups do that job.
- [ ] **8.** Don't switch on Hostinger's VPS firewall yet. It is set at the end of the build (runbook step 21).
- [ ] **9.** After it is ready, send the session the VPS's **IPv4 address** (hPanel → VPS → Overview).

## C. Cloudflare R2: off-site backups (free up to 10 GB)

- [ ] **10.** Create a Cloudflare account (dash.cloudflare.com) with the business e-mail. Turn on **two-factor login**.
- [ ] **11.** Left menu → **R2** → turn it on. Cloudflare may ask for a card. Our backups stay inside the free 10 GB, so no charge is expected.
- [ ] **12.** **Create bucket:**
  - name **`gokesari-db-backups`**;
  - location hint **Asia-Pacific**.

  Backups are encrypted on our server before they are uploaded.
- [ ] **13.** Send the session the **Account ID** (R2 overview page, right-hand side). It is not secret.
- [ ] **14.** R2 → **Manage API tokens** → **Create API token**, the **write key**:
  - name `gokesari-db-backup-write`;
  - permission **Object Read & Write**;
  - **only bucket `gokesari-db-backups`**.

  Save the **Access Key ID** and **Secret Access Key** in the password manager as **"GoKesari R2 write key"**. Cloudflare shows them only once.
- [ ] **15.** Create a second token, the **restore key**:
  - name `gokesari-db-restore-read`;
  - permission **Object Read only**;
  - same bucket.

  Save it as **"GoKesari R2 restore key"**. It never goes on the server; it is for restores somewhere else.
- [ ] **16.** Don't send either key to anyone. During the build you type the write key into the server yourself, from your own Terminal (runbook step 13).

## D. Then

- [ ] Reply **"G1 done"** with the VPS IP and the R2 Account ID.
- [ ] Give the **G2 OK** to build the server. The runbook lists exactly what the OK covers.
  - Nothing on gokesari.com, test.gokesari.com or Neon changes in this phase.
- **Still open, needed before the staging move (not before the build):**
  - **decision 5:** where alerts go (e-mail and/or Telegram).
- **Still open, needed before the production move:**
  - **decision 8:** a date and IST time for the production cut-over.

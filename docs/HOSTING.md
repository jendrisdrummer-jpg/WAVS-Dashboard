# Putting WAVS Dashboard on the web

This runs the dashboard as a website (for example `https://wavs-dashboard.onrender.com`, or your own
domain). Anyone you invite can create an account, and each account gets its own organization.
Teams can't see each other's data. You're the **site owner**: you choose who can sign up.

**What it costs:** $0 to start. Render's free plan plus the free MongoDB Atlas database. Render's
free plan goes to sleep after 15 minutes without visitors, and the first visit after that takes
about a minute. When people rely on it for live services, switch to Render's **Starter** plan
($7/month), which never sleeps.

**What works on the website:** people and photos, schedules, the order of service (typed or
Planning Center), dashboards and TV links, notes and checklists, comms on phones, YouTube/Facebook
viewers and comments, and demo gear.

**Not yet:** the website can't reach gear on a venue's network (Shure receivers, ATEM,
ProPresenter). A small program on a computer at each venue will connect it (next step). Until then
your laptop keeps running your own gear as before.

## 1. The database (MongoDB Atlas)

If you set up Atlas for your laptop already, use the same cluster.
1. **Database Access**: make sure you have a database user and know its password.
2. **Network Access**: add `0.0.0.0/0` (Allow access from anywhere). Render's addresses change, so
   this is needed. The password still protects the database.
3. **Connect → Drivers**: copy the connection string and put the password in it. It looks like
   `mongodb+srv://jon:PASSWORD@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority`.

The website keeps its data in a database called `wavs-web`, separate from your laptop's (`wavs`),
so nothing on the laptop changes.

## 2. The website (Render)

1. Sign up at [render.com](https://render.com) with your GitHub account.
2. **New → Blueprint**, pick the `WAVS-Dashboard` repository, then **Connect**.
3. Render reads `render.yaml` and asks for two values:
   - `MONGODB_URI`: the connection string from step 1.
   - `WAVS_OWNER_EMAIL`: your email address.
4. Click **Apply**. The first build takes a few minutes. Your address is shown at the top, for
   example `https://wavs-dashboard.onrender.com`.

## 3. Your account (the site owner)

1. Open `https://<your address>/signup`.
2. Sign up with **the email you put in `WAVS_OWNER_EMAIL`**. You don't need a beta code.
3. Name your first organization (e.g. *WAVS Events*), then go through the short setup.

You're now the site owner. **Settings → Website sign-ups** shows:
- **Who can create an account**:
  - *People with the beta code* (the default)
  - *Anyone*
  - *Nobody*: invite links to a team still work
- The **sign-up page** and the **beta code**. **Copy invitation** gives you a message to send to
  testers. **New code** stops the old code from working; accounts already made keep working.
- How many accounts and organizations there are.

## 4. Beta testers

Send them the invitation. Each tester:
1. Opens `/signup`, enters their name, email, a password, their church's name and the beta code.
2. Goes through the setup and lands on their own Home page.
3. Invites their own team from **Settings → Accounts & sign-in**. Each invite link sets a role
   (crew, producer or admin).

Things for testers to know:
- **TVs**: Dashboards → **Copy TV link** gives a link with a key. A TV or Fire Stick opens it
  without signing in, and can only view.
- **Comms**: Comms → the QR code gives a link for their organization. Phones join from any network.
  The comms engine runs in a Chrome tab on any computer (Comms → engine).
- **Forgotten passwords**: an admin can reset passwords for people who are only on their own team.
  You (the site owner) can reset anyone's.
- **Up to 5 organizations per person** during the beta.

## Bringing your own organization over from the laptop

On the laptop, open **Settings → Move to another computer → Download backup**. On the website,
open **Settings → Move to another computer**, choose the file and import it. It arrives as a new
organization that you're the admin of. Accounts aren't brought over on the website; invite your
team again from Settings.

## Your own domain (optional)

In Render: your service → **Settings → Custom Domains → Add**, e.g. `app.wavsevents.com`. Then
add the record Render shows to your domain's DNS. HTTPS is set up automatically.

## Other hosts

The `Dockerfile` runs it on Railway, Fly.io or any Docker host. Set these environment variables:
- `MONGODB_URI`
- `WAVS_OWNER_EMAIL`
- `WAVS_HOSTED=1` (already set in the Dockerfile)

The host provides `PORT`.

## Good to know

- An organization runs while people use it. After 2 hours with nobody connected it pauses, and it
  starts again when someone opens it. A scheduled service switches over when someone opens the
  dashboard.
- Accounts and sessions are kept together in one record, which is fine for a beta (thousands of
  accounts).
- Logs: Render → your service → **Logs**.

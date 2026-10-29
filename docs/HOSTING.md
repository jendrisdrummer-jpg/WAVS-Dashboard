# Putting WAVS Dashboard on the web

This runs the dashboard as a website (for example `https://wavs-dashboard.onrender.com`, or your own
domain). Anyone you invite can create an account, and each account gets its own organization.
Teams can't see each other's data. You're the **site owner**: you choose who can sign up.

**What it costs:** Render's **Starter** plan ($7/month per service, always on) plus the free MongoDB
Atlas database. `render.yaml` asks for Starter. To try it for $0 first, pick **Free** instead when
Render shows the plan: it works the same but sleeps after 15 minutes without visitors, and the
first visit after that takes about a minute (not good during a live service).

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
- **Forgotten passwords**: once email is set up (below), **Forgot password?** on the sign-in page
  emails a link. Without it, an admin can reset passwords for people who are only on their own team.
  You (the site owner) can reset anyone's.
- **Up to 5 organizations per person** during the beta.

## Password reset emails (Gmail)

With email set up, the sign-in page has **Forgot password?**. Someone enters their email and
gets a link to choose a new password. The link works once, for an hour. The site sends from a
Gmail account. A separate one, such as `wavs.dashboard@gmail.com`, keeps it tidy, but yours works.

1. In that Google account, turn on **2-Step Verification** (myaccount.google.com → Security).
2. Go to **myaccount.google.com/apppasswords**, type a name (e.g. `WAVS Dashboard`) and click
   **Create**. Copy the 16-letter password it shows. It's only shown once.
3. In Render, open your service → **Environment → Edit** and add:
   - `GMAIL_USER`: the Gmail address
   - `GMAIL_APP_PASSWORD`: the 16-letter app password (the spaces don't matter)
4. **Save, rebuild, and deploy**. The log then shows `[mail] sending email as …`.

Gmail allows about 500 emails a day, plenty for a beta. Reset emails go only to accounts whose
sign-in is an email address. Asking for a reset says the same thing whether or not the email
has an account, and it's limited to 5 an hour.

**Locked out of the owner account** (or email isn't set up)? In Render → Environment, add
`WAVS_RESET_OWNER_PASSWORD` with a new password and save; the site restarts with it. Sign in,
then **delete that variable** and save again.

## Your laptop as a base station (events)

For events, a laptop at the venue runs the gear (mics, ATEM, ProPresenter) and the screens in the
room, and keeps going without internet. Link it to the website and it's **the same system**: one
account, the same organizations, people, schedules and dashboards, with changes going both ways.

1. On the laptop, open the dashboard (`http://localhost:8080`) → **Settings → This computer →
   Website → Link to your website**.
2. Enter the website's address (e.g. `https://wavs-dashboard.onrender.com`), your website email and
   password, and a name for the laptop.
3. **Bring this computer's setup to the website**: tick an organization that's only on the laptop
   so far (people, photos, dashboards, schedules and gear go up as a new organization you're the
   admin of). Already on the website? Leave it unticked.
4. Click **Link this computer**. It restarts. If you started it from Terminal, start it again.

From then on:
- **One account.** People sign in at the laptop with their website accounts. Offline, anyone who
  has signed in on that laptop before still can. Invites, roles and passwords are managed on the
  website.
- **The same data.** The laptop shows the organizations your account is an admin of. Edits on
  either side show up on the other within a second or two.
- **No internet at the venue?** The header shows *☁ Offline: working from this computer*.
  Everything keeps working from the laptop's copy, and changes are sent when it's back. It even
  starts up offline, once it has synced at least once.
- **In the room**, TVs, the green room and crew phones use the laptop's address, as before
  (`http://wavs.local`, or its IP).
- The website's **Settings → Base stations** lists your linked laptops. **Remove** stops one
  syncing.
- **Unlink** (laptop: Settings → This computer → Website) puts the laptop back to its own setup
  from before it was linked. The website keeps everything.

Coming next: while the laptop runs an event, the website shows its live mics, tally and slides too.

## Bringing an organization over without linking

On the laptop, open **Settings → Move to another computer → Download backup**. On the website, open
**Settings → Move to another computer**, choose the file and import it. It arrives as a new
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

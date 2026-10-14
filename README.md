# Thesis Garden

A shared accountability garden for thesis readings. Each person's thesis is a plant, each book or article is a seed, and writing a post about it makes it sprout. Plants wilt when the open readings go quiet, so Loftees can check in on one another.

Check it out here: [Thesis Garden](https://bean-sprout-production.up.railway.app/)

## Run locally

```bash
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/garden npm start
```

Then open http://localhost:3000.

## How it works

- `public/index.html` is the whole front end: garden, constellation and blog post views.
- `thesis-garden.html` (top level) is the earlier version that runs only as a Claude artifact. The server doesn't use it.
- `server.js` serves the page, stores everything in Postgres and pushes live updates to open pages with Server-Sent Events (`/api/stream`).
- **Sign-in:** a name plus a 4–8 digit PIN. The first person to use a name claims it; the same name and PIN on another device signs in as the same person. PINs are stored hashed. There is no PIN reset, so a forgotten PIN means deleting that row from the `users` table.
- **Permissions** (checked on the server): signed-in people can read every garden, but can only change their own plant and readings, and can only post or delete their own check-ins.

### Data

Everything lives in one `docs` table keyed by path:

- `gardens/<userId>`: a person's plant (name, score inputs, seed/sprout/done counts)
- `gardens/<userId>/nodes/<id>`: one reading (title, status `seed | sprout | done`, post type, post text, timestamps)
- `checkins/<id>`: a check-in left on someone's plant

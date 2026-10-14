# Thesis Garden

A shared accountability garden for thesis readings. Each person's thesis is a plant, each book or article is a seed, and writing a post about it makes it sprout. Plants wilt when the open readings go quiet, so classmates can check in.

## Run on Railway

1. Create a service from this GitHub repo. Railway detects Node and runs `npm start`.
2. Add a **PostgreSQL** database to the same project.
3. In the service's **Variables**, add `DATABASE_URL` and set it to the Postgres service's `DATABASE_URL` (reference variable `${{Postgres.DATABASE_URL}}`).
4. Optional: set `CLASS_CODE` to a word only your class knows. Anyone entering the garden will need it.
5. **Settings → Networking → Generate Domain** to get a public URL.

The server creates its tables on first start.

| Variable | Required | What it does |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `CLASS_CODE` | no | Code required to enter the garden |
| `PGSSL` | no | Set to `true` if your Postgres requires SSL (Railway's internal network does not) |
| `PORT` | no | Railway sets this automatically |

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

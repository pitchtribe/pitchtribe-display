# The club's photographs

Drop the club's own pictures in this folder. `.jpg`, `.jpeg`, `.png`, `.webp`, `.avif` and
`.gif` are shown; anything else is ignored, so a stray `notes.txt` or a `Thumbs.db` costs
nothing.

- **No upload form, no accounts, no moderation queue.** It is a folder. The person who
  keeps the club's pictures already understands a folder.
- **Twelve photographs and four hundred run the same code.** Each day the wall takes a
  dozen at random and keeps that selection for the day, so Wednesday's screen is visibly
  different from Sunday's. The deeper the pool, the longer that holds — twelve photographs
  is wallpaper by Thursday, four hundred is a different screen every day for a season.
- **Names don't matter** and nothing is renamed, resized or written back: the card only
  ever reads this folder.
- Set `clubhouse.photosPerLoop` to show more or fewer than twelve at a time.

Everything you put here is served to any screen that can reach this server on the club's
network, so keep it to pictures the club is happy to have on the wall.

## Where the club's pool is coming from

For Caldecote the plan is to fill this folder once from the club's own Facebook Page — a Page
admin's export, or one short-lived Page token — and then leave it alone. The route, and why
the Page is not scraped, is in [FACEBOOK_PHOTOS.md](../../FACEBOOK_PHOTOS.md).

Two things about that are worth knowing while standing in this folder:

- **Size decides more than you would think.** The wall crops to 16:9 for a 1080p television,
  and a 1080×1080 square crops to 1080×607 — so the square fixture card that looks fine on a
  phone is a soft, undersized slide here. `npm run photos:count -- --dir=<folder>` bands any
  folder of images by what the screen can actually do with it.
- **Consent is not the same as public.** A photograph being visible on the Page is not the
  same as the club having said yes to it being on the bar wall. That yes is outstanding.

Git ignores the contents of this folder — the photographs belong to the club, not to this
repository.

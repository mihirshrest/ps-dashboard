# media

Finished post media (carousel images, reel MP4s) lives here.

Zernio downloads media by public URL rather than accepting a file upload, so
anything a post references has to be reachable on the open internet. While this
repo is public, the raw URL for a file here works directly:

    https://raw.githubusercontent.com/mihirshrest/ps-dashboard/main/media/<path>

That is what goes into `post_queue.media_urls`.

Layout is `media/<post-slug>/<nn>_<name>.<ext>`, e.g. `media/post57-naomivale/01_cover.jpg`.
Older folders use a date instead of a slug; both work, the slug just survives
building two posts on the same day.

**Pushing here starts the publisher.** `publisher-worker.yml` watches `media/**`,
because pushing the slides is the last step of building a post and GitHub's cron
is throttled far below the 15 minutes it asks for. Push media last, and the
draft is in TikTok within a minute instead of whenever the cron feels like it.

If this repo is ever made private these URLs stop resolving, and media moves to
the Supabase `post-media` bucket instead (the `upload-media` edge function is
already deployed and ready for that).

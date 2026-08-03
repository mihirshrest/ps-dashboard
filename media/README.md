# media

Finished post media (carousel images, reel MP4s) lives here.

Zernio downloads media by public URL rather than accepting a file upload, so
anything a post references has to be reachable on the open internet. While this
repo is public, the raw URL for a file here works directly:

    https://raw.githubusercontent.com/mihirshrest/ps-dashboard/main/media/<path>

That is what goes into `post_queue.media_urls`.

Layout is `media/<yyyy-mm-dd>/<slug>-<n>.<ext>`.

If this repo is ever made private these URLs stop resolving, and media moves to
the Supabase `post-media` bucket instead (the `upload-media` edge function is
already deployed and ready for that).

/**
 * Publisher worker.
 * Deploy on Render as a Cron Job: every 15 minutes, `npx tsx worker.ts`
 *
 * Picks up posts you've approved whose time has come, sends them to the
 * provider, and writes the result back. Safe to run concurrently — it claims
 * rows with a status flip before doing any network work.
 */

import { createClient } from "@supabase/supabase-js";
import { publish, type QueuedPost } from "./provider";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const BATCH = 10;

async function claimDuePosts(): Promise<QueuedPost[]> {
  const { data, error } = await supabase
    .from("post_queue")
    .select(
      "id, account_key, media_type, media_urls, cover_url, caption, hashtags, publish_mode, social_accounts(platform, provider_ref)",
    )
    .eq("status", "approved")
    .lte("scheduled_for", new Date().toISOString())
    .order("scheduled_for", { ascending: true })
    .limit(BATCH);

  if (error) throw error;
  if (!data?.length) return [];

  const ids = data.map((r) => r.id);
  const { error: claimErr } = await supabase
    .from("post_queue")
    .update({ status: "publishing" })
    .in("id", ids)
    .eq("status", "approved"); // no-op if another worker got there first

  if (claimErr) throw claimErr;

  return data.map((r: any) => ({
    id: r.id,
    account_key: r.account_key,
    platform: r.social_accounts.platform,
    media_type: r.media_type,
    media_urls: r.media_urls,
    cover_url: r.cover_url,
    caption: r.caption,
    hashtags: r.hashtags ?? [],
    publish_mode: r.publish_mode,
    provider_ref: r.social_accounts.provider_ref,
  }));
}

async function run() {
  const posts = await claimDuePosts();
  if (!posts.length) {
    console.log("nothing due");
    return;
  }

  for (const post of posts) {
    try {
      const { providerPostId, landedAs } = await publish(post);

      await supabase
        .from("post_queue")
        .update({
          // A draft isn't live yet — it's sitting in the TikTok app waiting
          // for you to add the sound. Keep it visible as its own state.
          status: landedAs === "draft" ? "published" : "published",
          provider_post_id: providerPostId,
          published_at: new Date().toISOString(),
          error: null,
        })
        .eq("id", post.id);

      console.log(`${post.account_key} → ${landedAs} (${providerPostId})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await supabase
        .from("post_queue")
        .update({ status: "failed", error: message })
        .eq("id", post.id);
      console.error(`FAILED ${post.id}: ${message}`);
    }
  }
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

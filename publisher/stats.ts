/**
 * Stats writeback.
 * Deploy on Render as a Cron Job: nightly, `npx tsx stats.ts`
 *
 * Captures a fresh stat row for every post published in the last 14 days, so
 * you see the growth curve (24h / 72h / 7d) rather than one final number.
 * The `post_performance` view joins the newest row back to the creation tags —
 * that join is the entire learning loop.
 */

import { createClient } from "@supabase/supabase-js";
import { fetchStats } from "./provider";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const LOOKBACK_DAYS = 14;

async function run() {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 864e5).toISOString();

  const { data: posts, error } = await supabase
    .from("post_queue")
    .select("id, provider_post_id, published_at")
    .eq("status", "published")
    .not("provider_post_id", "is", null)
    .gte("published_at", since);

  if (error) throw error;
  if (!posts?.length) return console.log("no recent posts");

  for (const post of posts) {
    try {
      const stats = await fetchStats(post.provider_post_id!);
      const hours =
        (Date.now() - new Date(post.published_at!).getTime()) / 3.6e6;

      await supabase.from("post_stats").insert({
        post_id: post.id,
        hours_since_post: Math.round(hours * 10) / 10,
        ...stats,
      });
    } catch (err) {
      // A draft that hasn't been posted from the app yet has no stats. Expected.
      console.warn(`skip ${post.id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`captured stats for ${posts.length} posts`);
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

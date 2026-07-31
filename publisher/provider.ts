/**
 * Provider adapter.
 *
 * This is deliberately the ONLY file that knows which posting API you pay for.
 * The queue, the approval page and the worker are all provider-agnostic, so
 * switching vendors later means rewriting this file and nothing else.
 *
 * Fill in BASE_URL + the two request bodies from your provider's docs once
 * you've picked one. The shape below is the common denominator across the
 * unified posting APIs (Blotato, Ayrshare, Zernio, Postiz, Upload-Post) —
 * they all take account + media + caption + a schedule/draft flag.
 */

export type QueuedPost = {
  id: string;
  account_key: string;
  platform: "tiktok" | "instagram" | "youtube" | "threads";
  media_type: "video" | "image" | "carousel";
  media_urls: string[];
  cover_url: string | null;
  caption: string;
  hashtags: string[];
  publish_mode: "draft" | "direct";
  provider_ref: string | null; // provider's account id, from social_accounts
};

export type PublishResult = {
  providerPostId: string;
  landedAs: "draft" | "published";
};

const BASE_URL = process.env.POSTING_API_URL!;
const API_KEY = process.env.POSTING_API_KEY!;

/** Caption + hashtags as one string, which is what every platform actually wants. */
export function renderCaption(post: QueuedPost): string {
  const tags = post.hashtags.map((t) => (t.startsWith("#") ? t : `#${t}`)).join(" ");
  return tags ? `${post.caption}\n\n${tags}` : post.caption;
}

export async function publish(post: QueuedPost): Promise<PublishResult> {
  if (!BASE_URL || !API_KEY) {
    throw new Error("POSTING_API_URL / POSTING_API_KEY not set");
  }

  // TikTok draft mode: the video lands in the account's TikTok drafts fully
  // edited. You open the app, pick the trending sound, and post. This is the
  // only way to use a native trending sound — no API can attach one.
  const isDraft = post.publish_mode === "draft";

  if (isDraft && post.platform !== "tiktok") {
    throw new Error(`draft mode is TikTok-only; ${post.platform} must use direct`);
  }

  const body = {
    account: post.provider_ref ?? post.account_key,
    platform: post.platform,
    // most providers call this `postMode`, `uploadType` or `draft: true` —
    // check your provider's docs and rename this one key.
    postMode: isDraft ? "DRAFT" : "DIRECT_POST",
    mediaType: post.media_type,
    mediaUrls: post.media_urls,
    coverUrl: post.cover_url ?? undefined,
    caption: renderCaption(post),
  };

  const res = await fetch(`${BASE_URL}/posts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`provider ${res.status}: ${text.slice(0, 400)}`);
  }

  const json = (await res.json()) as { id?: string; postId?: string };
  const providerPostId = json.id ?? json.postId;
  if (!providerPostId) throw new Error("provider returned no post id");

  return { providerPostId, landedAs: isDraft ? "draft" : "published" };
}

/** Pull stats for one published post. Used by the nightly stats job. */
export async function fetchStats(providerPostId: string) {
  const res = await fetch(`${BASE_URL}/posts/${providerPostId}/analytics`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!res.ok) throw new Error(`stats ${res.status}`);

  const d = (await res.json()) as Record<string, number>;
  return {
    views: d.views ?? d.impressions ?? null,
    likes: d.likes ?? null,
    comments: d.comments ?? null,
    shares: d.shares ?? null,
    saves: d.saves ?? d.bookmarks ?? null,
    profile_visits: d.profileVisits ?? null,
    follows: d.follows ?? d.newFollowers ?? null,
    completion_rate: d.completionRate ?? null,
    avg_watch_secs: d.averageWatchTime ?? null,
  };
}

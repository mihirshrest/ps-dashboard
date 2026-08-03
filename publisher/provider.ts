/**
 * Provider adapter — Zernio.
 *
 * This is deliberately the ONLY file that knows which posting API we use.
 * The queue, the approval page and the worker are all provider-agnostic, so
 * switching vendors later means rewriting this file and nothing else.
 *
 * Zernio docs: https://docs.zernio.com
 *   POST /posts          create + publish
 *   GET  /accounts       connected accounts (we resolve accountId from here)
 *   GET  /analytics      post metrics (list, not per-post — see fetchStats)
 *
 * Env:
 *   POSTING_API_URL   https://zernio.com/api/v1
 *   POSTING_API_KEY   sk_...
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
  provider_ref: string | null; // Zernio account _id, or a handle, or null
};

export type PublishResult = {
  providerPostId: string;
  landedAs: "draft" | "published";
};

const BASE_URL = (process.env.POSTING_API_URL ?? "").replace(/\/+$/, "");
const API_KEY = process.env.POSTING_API_KEY!;

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${API_KEY}` };
}

function requireEnv() {
  if (!BASE_URL || !API_KEY) {
    throw new Error("POSTING_API_URL / POSTING_API_KEY not set");
  }
}

/** Caption + hashtags as one string, which is what every platform actually wants. */
export function renderCaption(post: QueuedPost): string {
  const tags = post.hashtags.map((t) => (t.startsWith("#") ? t : `#${t}`)).join(" ");
  return tags ? `${post.caption}\n\n${tags}` : post.caption;
}

// ---------------------------------------------------------------------------
// Account resolution
//
// Zernio addresses accounts by its own 24-char _id, which you only learn by
// asking. social_accounts.provider_ref can hold either that _id (fast path) or
// a handle like "naomi.vale07" (we look it up). If it's null we fall back to
// "the one connected account on this platform", which is correct while only one
// account per platform is linked and throws a clear error the moment it isn't.
// ---------------------------------------------------------------------------

type ZernioAccount = {
  _id: string;
  platform: string;
  username?: string;
  displayName?: string;
  isActive?: boolean;
};

let accountCache: ZernioAccount[] | null = null;

async function listAccounts(): Promise<ZernioAccount[]> {
  if (accountCache) return accountCache;

  const res = await fetch(`${BASE_URL}/accounts`, { headers: authHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GET /accounts ${res.status}: ${text.slice(0, 300)}`);
  }

  const json: any = await res.json();
  // Tolerate {accounts:[...]} / {data:[...]} / [...] — docs show the SDK
  // returning "a list of accounts" without pinning the envelope.
  const list: ZernioAccount[] = json?.accounts ?? json?.data ?? json;
  if (!Array.isArray(list)) {
    throw new Error(`GET /accounts returned unexpected shape: ${JSON.stringify(json).slice(0, 300)}`);
  }

  accountCache = list;
  return list;
}

const looksLikeObjectId = (s: string) => /^[a-f0-9]{24}$/i.test(s);

const normalize = (s: string) => s.trim().toLowerCase().replace(/^@/, "");

async function resolveAccountId(post: QueuedPost): Promise<string> {
  const ref = post.provider_ref?.trim();
  if (ref && looksLikeObjectId(ref)) return ref;

  const accounts = (await listAccounts()).filter(
    (a) => a.platform === post.platform && a.isActive !== false,
  );

  if (!accounts.length) {
    throw new Error(
      `no ${post.platform} account connected in Zernio — connect it, then retry ${post.account_key}`,
    );
  }

  if (ref) {
    const want = normalize(ref);
    const hit = accounts.find(
      (a) => normalize(a.username ?? "") === want || normalize(a.displayName ?? "") === want,
    );
    if (hit) return hit._id;
    throw new Error(
      `provider_ref "${ref}" matches no connected ${post.platform} account ` +
        `(saw: ${accounts.map((a) => a.username ?? a.displayName ?? a._id).join(", ")})`,
    );
  }

  if (accounts.length > 1) {
    throw new Error(
      `${accounts.length} ${post.platform} accounts connected and social_accounts.provider_ref ` +
        `is null for "${post.account_key}" — set provider_ref to the right Zernio _id or handle ` +
        `(saw: ${accounts.map((a) => `${a.username ?? a.displayName ?? "?"}=${a._id}`).join(", ")})`,
    );
  }

  return accounts[0]._id;
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/**
 * TikTok treats a photo post's text as the slideshow TITLE and caps it at 90
 * characters, so sending a full caption fails with TIKTOK_PHOTO_TITLE_TOO_LONG.
 * For photo carousels we send the hook line only; the real caption is pasted by
 * hand from queue.html anyway, because TikTok accepts no caption on drafts.
 * Videos and every other platform keep the full caption.
 */
const TIKTOK_PHOTO_TITLE_MAX = 90;

export function outboundText(post: QueuedPost): string {
  const full = renderCaption(post);
  const isTikTokPhoto = post.platform === "tiktok" && post.media_type !== "video";
  if (!isTikTokPhoto) return full;

  const firstLine = (post.caption.split("\n")[0] ?? "").trim();
  const title = firstLine || full;
  return title.length <= TIKTOK_PHOTO_TITLE_MAX
    ? title
    : title.slice(0, TIKTOK_PHOTO_TITLE_MAX - 1).trimEnd() + "…";
}

export async function publish(post: QueuedPost): Promise<PublishResult> {
  requireEnv();

  // TikTok draft mode: the video lands in the account's TikTok drafts fully
  // edited. You open the app, pick the trending sound, and post. This is the
  // only way to use a native trending sound — no API can attach one.
  // Note: in draft mode TikTok accepts no caption/title/privacy over the API,
  // so the caption gets pasted by hand from queue.html's Copy button.
  const isDraft = post.publish_mode === "draft";

  if (isDraft && post.platform !== "tiktok") {
    throw new Error(`draft mode is TikTok-only; ${post.platform} must use direct`);
  }

  const accountId = await resolveAccountId(post);

  const mediaItems = post.media_urls.map((url) => ({
    type: post.media_type === "video" ? "video" : "image",
    url,
  }));

  const tiktokSettings = post.platform === "tiktok" ? { draft: isDraft } : undefined;

  const body: Record<string, unknown> = {
    content: outboundText(post),
    mediaItems,
    platforms: [
      {
        platform: post.platform,
        accountId,
        // The endpoint reference puts tiktokSettings at the top level, the
        // quickstart nests it here. Sending both is harmless and survives
        // whichever one Zernio actually reads.
        ...(tiktokSettings ? { platformSpecificData: { tiktokSettings } } : {}),
      },
    ],
    publishNow: true,
    ...(tiktokSettings ? { tiktokSettings } : {}),
  };

  const res = await fetch(`${BASE_URL}/posts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`provider ${res.status}: ${text.slice(0, 400)}`);
  }

  const json: any = await res.json();
  const providerPostId: string | undefined =
    json?.post?._id ?? json?.post?.id ?? json?._id ?? json?.id ?? json?.data?.post?._id;

  if (!providerPostId) {
    throw new Error(`provider returned no post id: ${JSON.stringify(json).slice(0, 300)}`);
  }

  return { providerPostId, landedAs: isDraft ? "draft" : "published" };
}

// ---------------------------------------------------------------------------
// Stats
//
// Zernio has no per-post analytics endpoint — GET /analytics returns a list.
// We pull that list once per process and index it, so stats.ts can keep asking
// post by post without hammering the API.
// ---------------------------------------------------------------------------

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const pick = (o: Record<string, any>, ...keys: string[]): number | null => {
  for (const k of keys) {
    const v = num(o?.[k]);
    if (v !== null) return v;
  }
  return null;
};

let analyticsCache: Map<string, Record<string, any>> | null = null;

async function analyticsIndex(): Promise<Map<string, Record<string, any>>> {
  if (analyticsCache) return analyticsCache;

  const res = await fetch(`${BASE_URL}/analytics?limit=200`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`stats ${res.status}`);

  const json: any = await res.json();
  const posts: any[] = json?.analytics?.posts ?? json?.posts ?? json?.data ?? json;

  const map = new Map<string, Record<string, any>>();
  if (Array.isArray(posts)) {
    for (const p of posts) {
      const id = p?.postId ?? p?.post?._id ?? p?._id ?? p?.id;
      if (typeof id === "string") map.set(id, p?.metrics ?? p?.analytics ?? p);
    }
  }

  analyticsCache = map;
  return map;
}

/** Pull stats for one published post. Used by the nightly stats job. */
export async function fetchStats(providerPostId: string) {
  requireEnv();

  const d = (await analyticsIndex()).get(providerPostId);
  // A draft still sitting in the TikTok app has no analytics row yet. stats.ts
  // treats a throw here as "skip", which is exactly right.
  if (!d) throw new Error(`no analytics row for ${providerPostId}`);

  return {
    views: pick(d, "views", "videoViews", "impressions", "playCount"),
    likes: pick(d, "likes", "likeCount"),
    comments: pick(d, "comments", "commentCount"),
    shares: pick(d, "shares", "shareCount", "reposts"),
    saves: pick(d, "saves", "bookmarks", "saveCount"),
    profile_visits: pick(d, "profileVisits", "profileViews"),
    follows: pick(d, "follows", "newFollowers", "followersGained"),
    completion_rate: pick(d, "completionRate", "completion_rate"),
    avg_watch_secs: pick(d, "averageWatchTime", "avgWatchTime", "avgWatchSecs"),
  };
}

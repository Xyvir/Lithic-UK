/**
 * The shim's update notice: is there a newer release than the build serving this page?
 *
 * A shim is a single file somebody downloaded, so nothing on the machine can update it:
 * whoever holds the old AppImage has to fetch the new one. The most this page can do is
 * say a newer release exists and put the releases page in front of them, which is the
 * whole feature. No download, no install, no second step, and nothing to press
 * afterwards. The button is a notice and a redirect, and it can be dismissed.
 *
 * What makes that cheap is where the answer comes from. GitHub answers `releases/latest`
 * with `Access-Control-Allow-Origin: *`, so a page may ask it directly, and the shim
 * needs no backend, no proxy and no session of its own for any of it. The one thing the
 * shim contributes is which build it is, served as `lithic-build-tag` in the document it
 * hands over (`inject_server_meta` in `shim/src/lib.rs`). That tag is also the
 * declaration that this page came from a shim: a published deployment, an instance and
 * the desktop app all serve no tag, so none of them can reach the notice.
 *
 * The comparison is equality rather than ordering. A release tag is the build's own
 * stamp (`v2026.09.30-2116`), so "is something newer published" is "is the newest tag a
 * different string", with no version parsing and no clock reading. That is the same rule
 * `install_update_check` follows for the desktop app, and the same reason: a tag is the
 * only thing the release workflow and the running binary can both state.
 *
 * One unauthenticated request per launch, and every failure is "no notice": offline,
 * rate limited, an answer whose shape we do not know. A launch that could not ask must
 * not grow a button promising what it cannot deliver, which is the desktop app's rule
 * too.
 */

/**
 * The meta tag the shim serves with the release tag it was built from.
 *
 * The name is `BUILD_TAG_META_NAME` in `shim/src/lib.rs`, and the two have to agree, so
 * a change there is a change here.
 */
export const BUILD_TAG_META = 'lithic-build-tag';

/**
 * The newest release, as GitHub answers it. Unauthenticated, read only, and the single
 * address this module ever reaches.
 */
export const RELEASES_LATEST_API = 'https://api.github.com/repos/Xyvir/Lithic-UK/releases/latest';

/**
 * Where the notice sends the reader: the releases page rather than an asset.
 *
 * The page is the honest destination, because the release carries more than one Linux
 * download and the user is the one who decides which file they want. A direct asset URL
 * would pick for them, and the two AppImages differ by a factor of forty in size.
 */
export const RELEASES_LATEST_PAGE = 'https://github.com/Xyvir/Lithic-UK/releases/latest';

/**
 * The release tag this document's server was built from, or null.
 *
 * Read once at boot and never again: what served the page cannot change while the page
 * lives. Null is the ordinary answer everywhere except a released shim, and it is what
 * keeps this module out of the other three distributions.
 */
export function readBuildTag(doc: Pick<Document, 'querySelector'> | null): string | null {
  const content = doc?.querySelector(`meta[name="${BUILD_TAG_META}"]`)?.getAttribute('content')?.trim();
  return content ? content : null;
}

/**
 * The newest release's tag, or null for anything that did not answer.
 *
 * `null` rather than a thrown error, for the reason `server-git-sync` gives about its own
 * reads: "nothing answered" is a state the caller renders as no notice, not an exception
 * to catch. Every branch below therefore says null, including a body that is not JSON,
 * which a redirect or a captive portal can produce.
 */
export async function latestReleaseTag(
  fetcher: typeof fetch = fetch,
  api = RELEASES_LATEST_API
): Promise<string | null> {
  try {
    const response = await fetcher(api, { headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) return null;
    const payload = (await response.json().catch(() => null)) as { tag_name?: unknown } | null;
    const tag = payload?.tag_name;
    return typeof tag === 'string' && tag.trim() ? tag.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Whether this build is behind the newest release.
 *
 * Equality, and only equality. A tag that differs in either direction reads as a newer
 * release, which is the trade the desktop app makes as well: a build ahead of the newest
 * release is a build nobody has, so its notice is harmless, while a comparison that tried
 * to order stamps would be a second date parser to keep right.
 *
 * A build with no tag is never an offer, and neither is a question that went unanswered.
 */
export function updateOffered(built: string | null, latest: string | null): boolean {
  return Boolean(built && latest && built !== latest);
}

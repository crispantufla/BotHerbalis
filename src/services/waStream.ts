/**
 * WhatsApp Web viewer authorization helpers.
 *
 * Since the CDP-screencast path was replaced by noVNC (commit 15c1dd7), the
 * stream manager itself is gone — only these two auth helpers survive. Kept
 * in this file path so existing imports don't break.
 */

const ALLOWED_USERS = (process.env.WA_VIEWER_USERS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

export function isAuthorizedUser(account: { name?: string | null; role?: string; sellerId?: string | null } | null | undefined): boolean {
    if (!account || !account.name) return false;
    if (ALLOWED_USERS.length === 0) return true;  // no whitelist → allow everyone
    return ALLOWED_USERS.includes(account.name.toLowerCase());
}

export function canViewSeller(
    account: { name?: string | null; sellerId?: string | null } | null | undefined,
    targetSellerId: string
): boolean {
    if (!isAuthorizedUser(account)) return false;
    if (!targetSellerId) return false;
    // Tenant user: locked to their own seller. Global (sellerId=null) can view any.
    if (account?.sellerId && account.sellerId !== targetSellerId) return false;
    return true;
}

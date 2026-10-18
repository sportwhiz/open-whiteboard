import { isLegacyDefaultColor, leastUsedColor } from "../identity-color";

/** Picks a marker color for a new account: the least used in this Studio. */
export async function chooseAccountColor(database: D1Database, id: string) {
  const rows = await database
    .prepare(
      "SELECT lower(color) AS color, COUNT(*) AS n FROM users GROUP BY lower(color)",
    )
    .all<{ color: string; n: number }>();
  return leastUsedColor(
    id,
    new Map(rows.results.map((row) => [row.color, Number(row.n)])),
  );
}

/**
 * Accounts created before colors were assigned all share one default. Give
 * such an account its own color the next time it is used, unless the person
 * saved a profile (then the stored color is their choice and stays). The
 * update is conditional, so concurrent requests and a rollback are harmless.
 */
export async function assignColorIfDefault(
  database: D1Database,
  id: string,
  color: string,
) {
  if (!isLegacyDefaultColor(color)) return color;
  const chosen = await chooseAccountColor(database, id);
  const updated = await database
    .prepare(
      "UPDATE users SET color = ? WHERE id = ? AND lower(color) = ? AND NOT EXISTS(SELECT 1 FROM user_profiles WHERE user_id = ?)",
    )
    .bind(chosen, id, color.toLowerCase(), id)
    .run();
  return updated.meta.changes ? chosen : color;
}

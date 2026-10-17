import type { NativeEnv } from "../auth/types";
import { HttpError } from "../security/errors";
import { boundedBody, json, randomToken } from "../security/primitives";
import { seal, open } from "../security/secret-store";
import { auditStatement } from "../security/audit";
import { limit } from "../security/limits";
import { currentRelease } from "./build";
import {
  ACTIVE,
  checkReleases,
  publishedRelease,
  settings,
  updateStatus,
} from "./service";
import {
  compatibleRelease,
  compareVersions,
  parseRelease,
  RELEASE_REPOSITORY_ID,
  type Release,
} from "./release";
const API = "https://api.godaddy.com/v1/hosting";
const PURPOSE = "godaddy-update-connection";
const MAX_PACKAGE = 32 * 1024 * 1024;
type Connection = { appId: string; token: string; origin: string };
type Package = { assetId: number; digest: string; size: number };
type Checkpoint = {
  provider: "godaddy";
  appId: string;
  uploadKey: string;
  publishKey: string;
  package?: Package;
  importId?: string;
  deploymentId?: string;
  nextAttemptAt?: number;
};
type Job = {
  id: string;
  release: string;
  status: string;
  checkpoint: string;
  created_at: number;
  updated_at: number;
};
class PackageError extends Error {}
class ProviderError extends Error {
  constructor(readonly status: number) {
    super("GoDaddy could not complete the update request.");
  }
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(value))
    throw new Error("Invalid hosting identifier");
  return value;
}
async function provider(
  connection: Connection,
  path: string,
  init: RequestInit = {},
) {
  const response = await fetch(API + path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...init.headers,
      Authorization: `Bearer ${connection.token}`,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new ProviderError(response.status);
  return JSON.parse(
    new TextDecoder().decode(await boundedBody(response, 65536)),
  );
}
async function connection(env: NativeEnv): Promise<Connection | null> {
  const config = await settings(env);
  if (!config.hook_ciphertext) return null;
  const value = JSON.parse(
    await open(env, config.hook_ciphertext, PURPOSE),
  ) as Connection;
  identifier(value.appId);
  if (
    value.origin !== env.AUTH_ORIGIN ||
    typeof value.token !== "string" ||
    !value.token
  )
    throw new Error("Update connection belongs to another installation");
  return value;
}
function incompatibility(release: Release) {
  return (
    compatibleRelease(release, currentRelease) ||
    (release.schema !== currentRelease.schema
      ? "This release changes the database. Follow the guided upgrade instructions after taking a backup."
      : null)
  );
}
async function packageMetadata(release: Release): Promise<Package> {
  const response = await fetch(
    `https://api.github.com/repositories/${RELEASE_REPOSITORY_ID}/releases/tags/v${release.version}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Open-Whiteboard-Updater",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) throw new Error("Release unavailable");
  const metadata = JSON.parse(
    new TextDecoder().decode(await boundedBody(response, 65536)),
  );
  const asset = metadata.assets?.find(
    (a: { name: string }) => a.name === "open-whiteboard-node.zip",
  );
  if (
    metadata.draft ||
    metadata.prerelease ||
    metadata.tag_name !== `v${release.version}` ||
    !asset ||
    !Number.isSafeInteger(asset.id) ||
    asset.id < 1 ||
    !Number.isSafeInteger(asset.size) ||
    asset.size < 1 ||
    asset.size > MAX_PACKAGE ||
    !/^sha256:[a-f0-9]{64}$/.test(asset.digest)
  )
    throw new PackageError("Release package is not qualified");
  return { assetId: asset.id, digest: asset.digest.slice(7), size: asset.size };
}
async function downloadPackage(pkg: Package) {
  const response = await fetch(
    `https://api.github.com/repositories/${RELEASE_REPOSITORY_ID}/releases/assets/${pkg.assetId}`,
    {
      headers: {
        Accept: "application/octet-stream",
        "User-Agent": "Open-Whiteboard-Updater",
      },
      signal: AbortSignal.timeout(90_000),
    },
  );
  if (!response.ok) throw new Error("Package download failed");
  const bytes = await boundedBody(response, MAX_PACKAGE);
  const digest = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (digest !== pkg.digest || bytes.byteLength !== pkg.size)
    throw new PackageError("Package checksum mismatch");
  return bytes;
}
async function saveJob(
  env: NativeEnv,
  job: Job,
  status: string,
  checkpoint: Checkpoint,
  message: string | null = null,
) {
  await env.CATALOG.prepare(
    "UPDATE software_updates SET status=?,checkpoint=?,message=?,updated_at=? WHERE id=? AND status NOT IN ('succeeded','failed')",
  )
    .bind(status, JSON.stringify(checkpoint), message, Date.now(), job.id)
    .run();
}
async function queue(env: NativeEnv, release: Release, actor: string | null) {
  const connected = await connection(env);
  if (!connected)
    throw new HttpError(
      409,
      "Connect GoDaddy updates first.",
      "UPDATER_NOT_CONNECTED",
    );
  const reason = incompatibility(release);
  if (reason) throw new HttpError(409, reason, "UPDATE_INCOMPATIBLE");
  if (compareVersions(release.version, currentRelease.version) <= 0)
    throw new HttpError(
      409,
      "This version is already installed or older.",
      "UPDATE_NOT_NEWER",
    );
  const id = randomToken(18),
    now = Date.now();
  const checkpoint: Checkpoint = {
    provider: "godaddy",
    appId: connected.appId,
    uploadKey: crypto.randomUUID(),
    publishKey: crypto.randomUUID(),
  };
  const result = await env.CATALOG.prepare(
    `INSERT INTO software_updates(id,release,previous_release,version,status,actor_id,created_at,updated_at,checkpoint) SELECT ?,?,?,?,'queued',?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM software_updates WHERE status IN ${ACTIVE})`,
  )
    .bind(
      id,
      JSON.stringify(release),
      JSON.stringify(currentRelease),
      release.version,
      actor,
      now,
      now,
      JSON.stringify(checkpoint),
    )
    .run();
  if (!result.meta.changes)
    throw new HttpError(
      409,
      "An update is already in progress.",
      "UPDATE_IN_PROGRESS",
    );
  await auditStatement(env.CATALOG, actor, "updates.requested", id, "success", {
    version: release.version,
    provider: "godaddy",
  }).run();
  return { id };
}
export async function godaddyUpdateStatus(env: NativeEnv) {
  const base = await updateStatus(env);
  let connected: Connection | null = null;
  try {
    connected = await connection(env);
  } catch {
    /* Reconnection is required. */
  }
  return {
    ...base,
    deploymentMode: "godaddy",
    connected: !!connected,
    managedConnection: false,
    runnerReady: true,
    appId: connected?.appId ?? env.GODADDY_APP_ID ?? "",
    incompatibility: base.available ? incompatibility(base.available) : null,
    history: base.history.map((row) => ({
      ...row,
      checkpoint: null,
      rollbackVersion: null,
    })),
  };
}
export async function godaddyUpdateRoutes(
  request: Request,
  env: NativeEnv,
  actor: string,
) {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/api/v1/admin/updates")
    return Response.json(await godaddyUpdateStatus(env));
  if (request.method !== "POST")
    throw new HttpError(405, "Method not allowed.", "METHOD_NOT_ALLOWED");
  await limit(env, "software-updates", actor, 12, 600);
  const input = await json(request);
  if (path.endsWith("/check")) await checkReleases(env);
  else if (path.endsWith("/connection")) {
    const active = await env.CATALOG.prepare(
      `SELECT id FROM software_updates WHERE status IN ${ACTIVE}`,
    ).first();
    if (input.disconnect === true) {
      if (active)
        throw new HttpError(
          409,
          "Finish the current update before disconnecting.",
          "UPDATE_IN_PROGRESS",
        );
      await env.CATALOG.batch([
        env.CATALOG.prepare(
          "UPDATE software_update_settings SET hook_ciphertext=NULL,automatic_security=0 WHERE id='instance'",
        ),
        auditStatement(env.CATALOG, actor, "updates.disconnected"),
      ]);
    } else {
      const appId = input.appId || env.GODADDY_APP_ID;
      if (
        typeof appId !== "string" ||
        !/^NODEJS-[A-Za-z0-9_-]+$/.test(appId) ||
        typeof input.token !== "string" ||
        input.token.length < 8 ||
        input.token.length > 4096 ||
        /\s/.test(input.token)
      )
        throw new HttpError(
          400,
          "Enter your GoDaddy app identifier and update token.",
          "INVALID_INPUT",
        );
      const candidate: Connection = {
        appId,
        token: input.token,
        origin: env.AUTH_ORIGIN!,
      };
      let app;
      try {
        app = await provider(candidate, `/apps/${identifier(appId)}`);
      } catch {
        throw new HttpError(
          400,
          "GoDaddy could not verify this token. Check its hosting permissions and expiry.",
          "INVALID_CONNECTION",
        );
      }
      if (
        app.appType !== "NODEJS" ||
        app.urls?.publish?.replace(/\/$/, "") !== env.AUTH_ORIGIN ||
        env.GODADDY_VARIANT === "PREVIEW"
      )
        throw new HttpError(
          400,
          "This token and app must match this published whiteboard. Preview cannot update production.",
          "WRONG_INSTALLATION",
        );
      const pending = active
        ? await env.CATALOG.prepare(
            `SELECT checkpoint FROM software_updates WHERE status IN ${ACTIVE}`,
          ).first<{ checkpoint: string }>()
        : null;
      if (pending && JSON.parse(pending.checkpoint).appId !== appId)
        throw new HttpError(
          409,
          "Keep the same app while an update is in progress.",
          "UPDATE_IN_PROGRESS",
        );
      const encrypted = await seal(env, JSON.stringify(candidate), PURPOSE);
      await env.CATALOG.batch([
        env.CATALOG.prepare(
          "UPDATE software_update_settings SET hook_ciphertext=? WHERE id='instance'",
        ).bind(encrypted),
        auditStatement(
          env.CATALOG,
          actor,
          "updates.connection_saved",
          null,
          "success",
          { provider: "godaddy" },
        ),
      ]);
    }
  } else if (path.endsWith("/policy")) {
    if (typeof input.automaticSecurity !== "boolean")
      throw new HttpError(400, "Choose an update preference.", "INVALID_INPUT");
    if (input.automaticSecurity && !(await connection(env)))
      throw new HttpError(
        409,
        "Connect updates first.",
        "UPDATER_NOT_CONNECTED",
      );
    await env.CATALOG.batch([
      env.CATALOG.prepare(
        "UPDATE software_update_settings SET automatic_security=? WHERE id='instance'",
      ).bind(Number(input.automaticSecurity)),
      auditStatement(
        env.CATALOG,
        actor,
        "updates.policy_changed",
        null,
        "success",
        { policy: input.automaticSecurity ? "security" : "manual" },
      ),
    ]);
  } else if (path.endsWith("/install")) {
    if (typeof input.version !== "string" || input.rollback)
      throw new HttpError(
        400,
        "Choose a newer release. Database recovery needs the hosting guide.",
        "INVALID_INPUT",
      );
    let release: Release;
    try {
      release = await publishedRelease(input.version);
    } catch {
      throw new HttpError(
        503,
        "The release could not be verified. Try again later.",
        "RELEASE_UNAVAILABLE",
      );
    }
    return Response.json(await queue(env, release, actor), { status: 202 });
  } else if (path.endsWith("/continue")) {
    const job = await env.CATALOG.prepare(
      "SELECT * FROM software_updates WHERE id=? AND status='uncertain'",
    )
      .bind(String(input.id))
      .first<Job>();
    if (
      !job ||
      (Date.now() - job.created_at > 23 * 60 * 60 * 1000 &&
        !JSON.parse(job.checkpoint).deploymentId)
    )
      throw new HttpError(
        409,
        "Check this deployment in GoDaddy before starting another update. Its safe retry window has expired or it already progressed.",
        "UPDATE_CHANGED",
      );
    const checkpoint = JSON.parse(job.checkpoint) as Checkpoint;
    const connected = await connection(env);
    if (
      checkpoint.provider !== "godaddy" ||
      connected?.appId !== checkpoint.appId
    )
      throw new HttpError(
        409,
        "Reconnect this app before continuing.",
        "UPDATER_NOT_CONNECTED",
      );
    checkpoint.nextAttemptAt = 0;
    await saveJob(
      env,
      job,
      checkpoint.deploymentId
        ? "verifying"
        : checkpoint.importId
          ? "deploying"
          : "building",
      checkpoint,
    );
    await auditStatement(env.CATALOG, actor, "updates.continued", job.id).run();
  } else if (path.endsWith("/resolve")) {
    if (input.confirmedStopped !== true || typeof input.id !== "string")
      throw new HttpError(
        400,
        "Check that the deployment is finished or stopped in GoDaddy first.",
        "CONFIRMATION_REQUIRED",
      );
    const result = await env.CATALOG.prepare(
      "UPDATE software_updates SET status='failed',message='The owner checked GoDaddy and closed this deployment record.',updated_at=? WHERE id=? AND status='uncertain'",
    )
      .bind(Date.now(), input.id)
      .run();
    if (!result.meta.changes)
      throw new HttpError(
        409,
        "This update has progressed. Refresh its status.",
        "UPDATE_CHANGED",
      );
    await auditStatement(
      env.CATALOG,
      actor,
      "updates.resolved",
      input.id,
    ).run();
  } else throw new HttpError(404, "Update action not found.", "NOT_FOUND");
  return Response.json(await godaddyUpdateStatus(env));
}
/** One durable step per tick. The process may be replaced during publish. */
export async function maintainGoDaddyUpdates(env: NativeEnv) {
  if (
    !env.NODE_UPDATES_ENABLED ||
    env.HOSTING_PLATFORM !== "godaddy" ||
    env.GODADDY_VARIANT === "PREVIEW"
  )
    return;
  const job = await env.CATALOG.prepare(
    "SELECT * FROM software_updates WHERE status IN ('queued','building','deploying','verifying') LIMIT 1",
  ).first<Job>();
  if (!job) {
    if (
      await env.CATALOG.prepare(
        "SELECT id FROM software_updates WHERE status='uncertain' LIMIT 1",
      ).first()
    )
      return;
    const config = await settings(env);
    if ((config.checked_at ?? 0) < Date.now() - 86400000)
      await checkReleases(env);
    const latest = await settings(env);
    if (
      !latest.automatic_security ||
      !latest.hook_ciphertext ||
      latest.check_error ||
      !latest.available_release
    )
      return;
    const candidate = parseRelease(JSON.parse(latest.available_release));
    if (
      !candidate.security ||
      candidate.version.split(".").slice(0, 2).join(".") !==
        currentRelease.version.split(".").slice(0, 2).join(".") ||
      incompatibility(candidate) ||
      compareVersions(candidate.version, currentRelease.version) <= 0
    )
      return;
    if (
      await env.CATALOG.prepare(
        "SELECT id FROM software_updates WHERE version=? LIMIT 1",
      )
        .bind(candidate.version)
        .first()
    )
      return;
    await queue(env, candidate, null);
    return;
  }
  const checkpoint = JSON.parse(job.checkpoint) as Checkpoint;
  if (
    checkpoint.provider !== "godaddy" ||
    (checkpoint.nextAttemptAt ?? 0) > Date.now()
  )
    return;
  if (
    !checkpoint.deploymentId &&
    Date.now() - job.created_at > 23 * 60 * 60 * 1000
  ) {
    await saveJob(
      env,
      job,
      "uncertain",
      checkpoint,
      "This update needs a check in GoDaddy before retrying; its safe retry window has expired.",
    );
    return;
  }
  try {
    const connected = await connection(env);
    if (!connected || connected.appId !== checkpoint.appId)
      throw new ProviderError(401);
    const path = `/apps/${identifier(connected.appId)}`;
    const target = parseRelease(JSON.parse(job.release));
    if (!checkpoint.package) {
      checkpoint.package = await packageMetadata(target);
      await saveJob(env, job, "building", checkpoint);
      return;
    }
    if (!checkpoint.importId) {
      const bytes = await downloadPackage(checkpoint.package);
      const boundary = `whiteboard-${checkpoint.uploadKey}`;
      const body = new Blob([
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="open-whiteboard-node.zip"\r\nContent-Type: application/zip\r\n\r\n`,
        bytes,
        `\r\n--${boundary}--\r\n`,
      ]);
      const result = await provider(connected, `${path}/imports`, {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Idempotency-Key": checkpoint.uploadKey,
        },
        body,
      });
      checkpoint.importId = identifier(result.importId);
      await saveJob(env, job, "building", checkpoint);
      return;
    }
    if (!checkpoint.deploymentId) {
      const imported = await provider(
        connected,
        `${path}/imports/${identifier(checkpoint.importId)}`,
      );
      if (["FAILED", "CANCELLED"].includes(imported.status)) {
        await saveJob(
          env,
          job,
          "failed",
          checkpoint,
          "GoDaddy could not build this update. Your live whiteboard has not been replaced. Check the app in GoDaddy.",
        );
        return;
      }
      if (imported.status !== "COMPLETED") {
        if (Date.now() - job.created_at > 20 * 60 * 1000)
          await saveJob(
            env,
            job,
            "uncertain",
            checkpoint,
            "GoDaddy is taking longer than expected to prepare this update. Check the app in GoDaddy, then continue the saved operation.",
          );
        return;
      }
      // Persist publication intent before the request can stop this process.
      await saveJob(env, job, "deploying", checkpoint);
      const result = await provider(connected, `${path}/deployments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": checkpoint.publishKey,
        },
        body: "{}",
      });
      checkpoint.deploymentId = identifier(result.deploymentId);
      await saveJob(env, job, "verifying", checkpoint);
      return;
    }
    const deployed = await provider(
      connected,
      `${path}/deployments/${identifier(checkpoint.deploymentId)}`,
    );
    if (["FAILED", "CANCELLED"].includes(deployed.status)) {
      await saveJob(
        env,
        job,
        "failed",
        checkpoint,
        "GoDaddy did not accept this update. Check its deployment and runtime logs before trying again.",
      );
      return;
    }
    if (deployed.status !== "COMPLETED") {
      if (Date.now() - job.created_at > 20 * 60 * 1000)
        await saveJob(
          env,
          job,
          "uncertain",
          checkpoint,
          "GoDaddy is taking longer than expected to publish this update. Check the deployment, then continue to verify the same operation.",
        );
      return;
    }
    if (
      currentRelease.commit !== target.commit ||
      currentRelease.version !== target.version ||
      currentRelease.schema !== target.schema
    ) {
      await saveJob(
        env,
        job,
        Date.now() - job.created_at > 20 * 60 * 1000
          ? "uncertain"
          : "verifying",
        checkpoint,
        "Waiting for the approved version to start. GoDaddy has completed the deployment.",
      );
      return;
    }
    await env.CATALOG.batch([
      env.CATALOG.prepare(
        "UPDATE software_updates SET status='succeeded',message=NULL,updated_at=? WHERE id=? AND status='verifying'",
      ).bind(Date.now(), job.id),
      env.CATALOG.prepare(
        "UPDATE software_update_settings SET active_release=? WHERE id='instance'",
      ).bind(job.release),
      auditStatement(env.CATALOG, null, "updates.verified", job.id, "success", {
        provider: "godaddy",
      }),
    ]);
  } catch (error) {
    if (error instanceof PackageError) {
      await saveJob(
        env,
        job,
        "failed",
        checkpoint,
        "The release package could not be verified. Your live whiteboard has not been replaced.",
      );
      return;
    }
    const authorization =
      error instanceof ProviderError && [401, 403].includes(error.status);
    const rejected =
      error instanceof ProviderError && [400, 404, 422].includes(error.status);
    const retryWindowElapsed = Date.now() - job.created_at > 20 * 60 * 1000;
    checkpoint.nextAttemptAt = Date.now() + 60_000;
    await saveJob(
      env,
      job,
      authorization || rejected || retryWindowElapsed ? "uncertain" : job.status,
      checkpoint,
      authorization
        ? "The GoDaddy update token expired or needs permission. Reconnect updates, then continue this deployment."
        : rejected
          ? "GoDaddy rejected this update request. Check the saved deployment before continuing."
          : retryWindowElapsed
            ? "GoDaddy has been unreachable for this update. Check the saved deployment, then continue when the connection recovers."
            : "The update is paused while the connection recovers. The same operation will be retried safely.",
    );
  }
}

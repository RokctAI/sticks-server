// Content keys on a docker move (Paramount thread; coordinator 11-22). Upstream encrypts each space's content with
// data keys kept in space_keys, wrapped (AES-256-GCM) by a master key derived from the docker's content_key
// (ENCRYPTION_KEY). Each docker has its own content_key, and a shared docker's key must never be copied (it would
// open every other tenant's content). So the move re-wraps only the moving tenant's space keys:
//   export: unwrap with the source docker's master key, wrap with the one-off move key (masterKeyId "sticks-move");
//   import: unwrap with the move key, wrap with the target docker's master key (masterKeyId "env").
// No plain data key is written to the export file. The derivation and wrap format copy upstream's LocalKeyProvider
// and masterKeysFromEnv (packages/db/src/content-keys.ts) for the derived "env" key; a space key wrapped by any
// other master key (ENCRYPTION_MASTER_KEYS or a key manager) is refused rather than moved unreadable.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export const ENV_MASTER_KEY_ID = "env";
export const MOVE_KEY_ID = "sticks-move";

export type SpaceKeyRow = { spaceId: string; version: number; masterKeyId: string; wrappedKey: string } & Record<string, unknown>;

/** Upstream's derived master key: HKDF-SHA256 of ENCRYPTION_KEY, salt "rakazo", info "rakazo/content-master-key/v1". */
export function masterKeyFromContentKey(contentKey: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(contentKey.trim(), "utf8"), Buffer.from("rakazo"), "rakazo/content-master-key/v1", 32));
}

/** The move key file's text, stretched to 32 bytes for its own purpose. */
export function masterKeyFromMoveKey(moveKey: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(moveKey.trim(), "utf8"), Buffer.from("sticks"), "sticks/move/space-key/v1", 32));
}

function aad(spaceId: string, version: number): Buffer {
  return Buffer.from(`rakazo/space-key/v1\0${spaceId}\0${version}`);
}

export function wrapDataKey(dataKey: Buffer, master: Buffer, spaceId: string, version: number): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", master, iv);
  cipher.setAAD(aad(spaceId, version));
  const enc = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  return Buffer.concat([iv, enc, cipher.getAuthTag()]).toString("base64url");
}

export function unwrapDataKey(wrapped: string, master: Buffer, spaceId: string, version: number): Buffer {
  const body = Buffer.from(wrapped, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", master, body.subarray(0, 12));
  decipher.setAAD(aad(spaceId, version));
  decipher.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([decipher.update(body.subarray(12, body.length - 16)), decipher.final()]);
}

/** Export side: source master key → move key. */
export function rewrapForMove(row: SpaceKeyRow, contentKey: string, moveKey: string): SpaceKeyRow {
  if (row.masterKeyId !== ENV_MASTER_KEY_ID)
    throw new Error(`space key ${row.spaceId} v${row.version} is wrapped by master key "${row.masterKeyId}"; only "env" can be moved`);
  const dataKey = unwrapDataKey(row.wrappedKey, masterKeyFromContentKey(contentKey), row.spaceId, row.version);
  return { ...row, masterKeyId: MOVE_KEY_ID, wrappedKey: wrapDataKey(dataKey, masterKeyFromMoveKey(moveKey), row.spaceId, row.version) };
}

/** Import side: move key → target master key. Rows not wrapped for a move are returned as they are. */
export function rewrapFromMove(row: SpaceKeyRow, contentKey: string, moveKey: string): SpaceKeyRow {
  if (row.masterKeyId !== MOVE_KEY_ID) return row;
  const dataKey = unwrapDataKey(row.wrappedKey, masterKeyFromMoveKey(moveKey), row.spaceId, row.version);
  return { ...row, masterKeyId: ENV_MASTER_KEY_ID, wrappedKey: wrapDataKey(dataKey, masterKeyFromContentKey(contentKey), row.spaceId, row.version) };
}

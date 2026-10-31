import type * as Electron from "electron";

type MicrophoneAccessStatus = ReturnType<Electron.SystemPreferences["getMediaAccessStatus"]>;

export type MediaPermissionSystemPreferences = {
  getMediaAccessStatus: (mediaType: "microphone") => MicrophoneAccessStatus;
  askForMediaAccess: (mediaType: "microphone") => Promise<boolean>;
};

export type MediaPermissionSession = Pick<
  Electron.Session,
  "setPermissionRequestHandler" | "setPermissionCheckHandler"
>;

export type MediaPermissionOptions = {
  readonly platform: NodeJS.Platform;
  readonly appOrigins: readonly string[];
  readonly systemPreferences: MediaPermissionSystemPreferences;
};

/**
 * Custom schemes serialize their URL origin as "null", so compare scheme and
 * host instead of relying on URL.origin.
 */
function normalizePermissionOrigin(rawOrigin: string | null | undefined): string | null {
  if (!rawOrigin) return null;
  try {
    const url = new URL(rawOrigin);
    if (url.host === "") return null;
    return url.origin === "null" ? `${url.protocol}//${url.host}` : url.origin;
  } catch {
    return null;
  }
}

function firstUsableOrigin(...candidates: readonly (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    const normalized = normalizePermissionOrigin(candidate);
    if (normalized !== null) return normalized;
  }
  return null;
}

export function isAllowedMicrophonePermission(
  origin: string | null | undefined,
  permission: string,
  mediaTypes: readonly string[] | undefined,
  appOrigins: readonly string[],
): boolean {
  if (permission !== "media") return false;
  const types = mediaTypes ?? [];
  if (!types.includes("audio") || types.includes("video")) return false;
  const requestOrigin = normalizePermissionOrigin(origin);
  if (requestOrigin === null) return false;
  return appOrigins.some((appOrigin) => normalizePermissionOrigin(appOrigin) === requestOrigin);
}

function installPermissionRequestHandler(
  session: MediaPermissionSession,
  options: MediaPermissionOptions,
): void {
  session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const mediaTypes = "mediaTypes" in details ? details.mediaTypes : undefined;
    const origin = firstUsableOrigin(
      "securityOrigin" in details ? details.securityOrigin : undefined,
      details.requestingUrl,
    );
    if (!isAllowedMicrophonePermission(origin, permission, mediaTypes, options.appOrigins)) {
      callback(false);
      return;
    }
    if (options.platform !== "darwin") {
      callback(true);
      return;
    }
    const status = options.systemPreferences.getMediaAccessStatus("microphone");
    if (status === "granted") {
      callback(true);
      return;
    }
    if (status !== "not-determined") {
      callback(false);
      return;
    }
    void options.systemPreferences.askForMediaAccess("microphone").then(
      (granted) => callback(granted),
      () => callback(false),
    );
  });
}

function installPermissionCheckHandler(
  session: MediaPermissionSession,
  options: MediaPermissionOptions,
): void {
  session.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    const mediaTypes = details.mediaType === undefined ? undefined : [details.mediaType];
    const origin = firstUsableOrigin(
      details.securityOrigin,
      details.requestingUrl,
      requestingOrigin,
    );
    if (!isAllowedMicrophonePermission(origin, permission, mediaTypes, options.appOrigins)) {
      return false;
    }
    // Force Chromium through the request handler while macOS has not asked yet.
    return (
      options.platform !== "darwin" ||
      options.systemPreferences.getMediaAccessStatus("microphone") === "granted"
    );
  });
}

export function installMediaPermissionHandlers(
  session: MediaPermissionSession,
  options: MediaPermissionOptions,
): void {
  installPermissionRequestHandler(session, options);
  installPermissionCheckHandler(session, options);
}

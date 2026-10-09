/**
 * The native half of the page bridge (bridge-script.ts is the page half):
 * share sheet, saving downloads, printing and location.
 */
import { File, Paths } from "expo-file-system";
import * as Location from "expo-location";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { Platform, Share, type ShareContent } from "react-native";

/** What the page sent, after the token and origin checks in App.tsx. */
export interface BridgeMessage {
  type: string;
  id?: number;
  [key: string]: unknown;
}

export interface BridgeError {
  name?: string;
  code?: number;
  message: string;
}

/** Sends a message to the page: `window.__gokesariApp.receive(message)`. */
export type SendToPage = (message: Record<string, unknown>) => void;

/* ------------------------------------------------------------------ share */

export async function share(message: BridgeMessage): Promise<void> {
  const title = typeof message.title === "string" ? message.title : "";
  const text = typeof message.text === "string" ? message.text : "";
  const url = typeof message.url === "string" ? message.url : "";
  // Android's share intent has no separate URL field.
  const body = Platform.OS === "android" ? [text, url].filter(Boolean).join(" ") : text;
  const content: ShareContent =
    Platform.OS === "ios" && url ? { title, url, ...(body ? { message: body } : {}) } : { title, message: body || title };
  const result = await Share.share(content, { dialogTitle: title || undefined, subject: title || undefined });
  if (result.action === Share.dismissedAction) {
    throw { name: "AbortError", message: "Share cancelled." } satisfies BridgeError;
  }
}

/* -------------------------------------------------------------- downloads */

/** A safe file name for the cache directory: no path separators or control characters. */
export function safeFileName(name: unknown): string {
  const cleaned = String(name ?? "")
    .replace(/[/\\?%*:|"<>\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return cleaned || "download";
}

/** Writes a file the page fetched and opens the share sheet ("Save to Files", WhatsApp, Print…). */
export async function saveFile(message: BridgeMessage): Promise<void> {
  if (typeof message.base64 !== "string") throw { message: "Nothing to save." } satisfies BridgeError;
  const mimeType = typeof message.mimeType === "string" ? message.mimeType : "application/octet-stream";
  const file = new File(Paths.cache, safeFileName(message.filename));
  file.create({ overwrite: true });
  file.write(message.base64, { encoding: "base64" });
  await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: file.name });
}

/* ------------------------------------------------------------------ print */

export async function print(message: BridgeMessage): Promise<void> {
  if (typeof message.html !== "string") return;
  try {
    await Print.printAsync({ html: message.html });
  } catch {
    // Closing the print dialog without printing rejects on some devices; it is not an error.
  }
}

/* --------------------------------------------------------------- location */

interface GeoOptions {
  enableHighAccuracy: boolean;
  timeout: number | null;
  maximumAge: number;
}

const PERMISSION_DENIED = 1;
const POSITION_UNAVAILABLE = 2;
const TIMEOUT = 3;

function geoOptions(raw: unknown): GeoOptions {
  const options = (raw ?? {}) as Partial<GeoOptions>;
  return {
    enableHighAccuracy: Boolean(options.enableHighAccuracy),
    timeout: typeof options.timeout === "number" && options.timeout >= 0 ? options.timeout : null,
    maximumAge: typeof options.maximumAge === "number" && options.maximumAge > 0 ? options.maximumAge : 0,
  };
}

function toFix(location: Location.LocationObject) {
  const { coords } = location;
  return {
    latitude: coords.latitude,
    longitude: coords.longitude,
    accuracy: coords.accuracy,
    altitude: coords.altitude,
    altitudeAccuracy: coords.altitudeAccuracy,
    heading: coords.heading,
    speed: coords.speed,
    timestamp: location.timestamp,
  };
}

/** Asks once (the OS remembers the answer); a refusal is the web's PERMISSION_DENIED. */
async function ensureLocationPermission(): Promise<void> {
  let permission = await Location.getForegroundPermissionsAsync();
  if (!permission.granted && permission.canAskAgain) permission = await Location.requestForegroundPermissionsAsync();
  if (!permission.granted) {
    throw { code: PERMISSION_DENIED, message: "Location permission was not given." } satisfies BridgeError;
  }
}

function accuracyFor(options: GeoOptions): Location.LocationAccuracy {
  return options.enableHighAccuracy ? Location.LocationAccuracy.High : Location.LocationAccuracy.Balanced;
}

export async function currentPosition(message: BridgeMessage) {
  const options = geoOptions(message.options);
  await ensureLocationPermission();
  if (options.maximumAge > 0) {
    const recent = await Location.getLastKnownPositionAsync({ maxAge: options.maximumAge }).catch(() => null);
    if (recent) return toFix(recent);
  }
  // Like the browser's, the timeout starts once permission is settled.
  const fix = Location.getCurrentPositionAsync({ accuracy: accuracyFor(options) });
  const timeout =
    options.timeout === null
      ? null
      : new Promise<never>((_, reject) =>
          setTimeout(() => reject({ code: TIMEOUT, message: "Timed out getting your location." }), options.timeout ?? 0),
        );
  try {
    return toFix(await (timeout ? Promise.race([fix, timeout]) : fix));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as BridgeError).code === TIMEOUT) throw error;
    throw {
      code: POSITION_UNAVAILABLE,
      message: "Your location is not available. Check that location is switched on.",
    } satisfies BridgeError;
  }
}

/** Location watches started by the current page, by the page's watch id. */
export class LocationWatches {
  private subscriptions = new Map<number, Promise<Location.LocationSubscription | null>>();

  constructor(private readonly send: SendToPage) {}

  start(watchId: number, rawOptions: unknown): void {
    if (this.subscriptions.has(watchId)) return;
    const options = geoOptions(rawOptions);
    const subscription = ensureLocationPermission()
      .then(() =>
        Location.watchPositionAsync(
          { accuracy: accuracyFor(options), timeInterval: 5_000, distanceInterval: 0 },
          (location) => {
            if (this.subscriptions.has(watchId)) this.send({ type: "position", watchId, fix: toFix(location) });
          },
          (reason) => {
            if (this.subscriptions.has(watchId)) {
              this.send({ type: "position", watchId, error: { code: POSITION_UNAVAILABLE, message: String(reason) } });
            }
          },
        ),
      )
      .catch((error: BridgeError) => {
        if (this.subscriptions.has(watchId)) {
          this.send({
            type: "position",
            watchId,
            error: { code: error?.code ?? POSITION_UNAVAILABLE, message: error?.message ?? "Location unavailable." },
          });
        }
        return null;
      });
    this.subscriptions.set(watchId, subscription);
  }

  stop(watchId: number): void {
    const subscription = this.subscriptions.get(watchId);
    this.subscriptions.delete(watchId);
    void subscription?.then((s) => s?.remove());
  }

  stopAll(): void {
    for (const watchId of [...this.subscriptions.keys()]) this.stop(watchId);
  }
}

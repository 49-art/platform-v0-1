/** Installable app plumbing: service worker registration and the browser's install prompt. */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

export function initPwa() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    listeners.forEach((l) => l());
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    listeners.forEach((l) => l());
  });
  if ("serviceWorker" in navigator && location.protocol === "https:" || location.hostname === "localhost") {
    window.addEventListener("load", () => {
      navigator.serviceWorker?.register("/sw.js").catch(() => { /* the app still works without it */ });
    });
  }
}

export const isInstalled = () => window.matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone === true;
export const canPrompt = () => !!deferred;
export function onInstallChange(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Returns true if the browser's own install dialog was shown. Otherwise the caller sends people to /install. */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  await deferred.prompt();
  await deferred.userChoice.catch(() => null);
  deferred = null;
  listeners.forEach((l) => l());
  return true;
}

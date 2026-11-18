import { useSyncExternalStore } from "react";

/** Minimal client-side router: "/" and "/project/:id". */
export type Route = { name: "home" } | { name: "project"; id: string } | { name: "notFound" };

export function parseRoute(pathname: string): Route {
  if (pathname === "/" || pathname === "") return { name: "home" };
  const m = /^\/project\/([0-9A-HJKMNP-TV-Z]{26})\/?$/.exec(pathname);
  if (m?.[1]) return { name: "project", id: m[1] };
  return { name: "notFound" };
}

const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  window.addEventListener("popstate", fn);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("popstate", fn);
  };
}

export function navigate(to: string) {
  if (to === window.location.pathname) return;
  window.history.pushState(null, "", to);
  listeners.forEach((l) => l());
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

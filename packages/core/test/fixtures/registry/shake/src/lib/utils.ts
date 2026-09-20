"use client";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { Ref, RefCallback } from "react";
import { trim } from "./format.js";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// matches a single trailing slash
const TRAILING_SLASH = /\/$/;

function normalize(url: string) {
  return url.replace(TRAILING_SLASH, "");
}

/**
 * Whether `url` is the current page.
 */
export function isActive(url: string, pathname: string) {
  return normalize(url) === normalize(pathname);
}

export function mergeRefs<T>(...refs: Ref<T>[]): RefCallback<T> {
  return (value) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(value);
      else if (ref) ref.current = value;
    }
  };
}

export function label(text: string) {
  return trim(text);
}

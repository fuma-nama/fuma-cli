import type { Awaitable } from "@/types";
import type { Component, File } from "../schema";

export interface IOInterface {
  onWarn: (message: string) => void;
  confirmFileOverride: (options: { path: string }) => Awaitable<boolean>;
  onFileDownloaded: (options: { path: string; file: File; component: Component }) => void;
}

export function defaultIO(): IOInterface {
  return {
    onWarn(message) {
      console.warn(message);
    },
    confirmFileOverride() {
      return true;
    },
    onFileDownloaded() {},
  };
}

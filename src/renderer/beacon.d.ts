// window.beacon, as exposed by the preload bridge.
import type { BeaconApi } from "../main/bridge.ts";

declare global {
  interface Window {
    beacon: BeaconApi;
  }
}

export {};

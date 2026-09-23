import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldEnableProviderAvailabilityLoginEntryGuard,
  shouldShowRootStartupLoading,
} from "../src/lib/rootStartupGate.js";

test("LinkAgent allows an unconfigured, signed-out user into the workspace", () => {
  assert.equal(shouldEnableProviderAvailabilityLoginEntryGuard(), false);
  assert.equal(
    shouldShowRootStartupLoading({
      isDesktop: true,
      welcomeScreenOpen: false,
      isResolvingStartupAuthState: false,
      isResolvingProviderStartupState: false,
      isRestoring: false,
      isBootstrappingInitialWorkspace: false,
    }),
    false,
  );
});

test("local workspace restoration still completes before rendering the desktop", () => {
  assert.equal(
    shouldShowRootStartupLoading({
      isDesktop: true,
      welcomeScreenOpen: false,
      isResolvingStartupAuthState: false,
      isResolvingProviderStartupState: false,
      isRestoring: true,
      isBootstrappingInitialWorkspace: false,
    }),
    true,
  );
});

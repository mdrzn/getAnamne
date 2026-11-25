// Build/runtime config, shared by the service worker and extension pages.
//
// DEV: when true, the service worker logs capture progress and keeps the last raw
//   payload per platform, and the Diagnostics view offers buttons to copy it.
//   Keep it false for the public store build.
(function (root) {
  root.ANAMNE_CONFIG = {
    DEV: false,
  };
})(typeof self !== "undefined" ? self : this);

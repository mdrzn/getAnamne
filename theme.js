// Resolve theme before first paint: saved choice (localStorage, shared by every
// extension page) or the OS setting by default. The popup toggle writes the choice.
// Loaded as a file in <head> because MV3's CSP blocks inline scripts.
(function () {
  try {
    var t = localStorage.getItem("anamne-theme");
    if (t !== "light" && t !== "dark") t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", t);
  } catch (e) {}
})();

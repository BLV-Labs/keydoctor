// Sets html[data-theme] before the first paint: the saved choice, else the system setting. Classic script so it
// runs before the stylesheets apply (CSP allows 'self' scripts).
(function () {
  var t = null;
  try {
    t = localStorage.getItem("kd.theme");
  } catch (e) {
    t = null;
  }
  if (t !== "light" && t !== "dark") {
    t = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.documentElement.setAttribute("data-theme", t);
})();

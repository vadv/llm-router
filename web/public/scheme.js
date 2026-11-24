// Set the color scheme before the first paint, from the value the theme
// toggle stores. The page's CSP allows no inline script, so this is a file.
try {
  var stored = localStorage.getItem("llm-router.scheme");
  if (stored === "light" || stored === "dark")
    document.documentElement.setAttribute("data-mantine-color-scheme", stored);
} catch (error) {
  // Storage can be unavailable; the app then starts in its default scheme.
}

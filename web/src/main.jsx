import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
// Shared styles first, so a page's own stylesheet (imported by the page) comes after them in the cascade.
import "./styles/tokens.css";
import "./styles/app.css";
import { devRoutes } from "./gallery.jsx";
import { routes } from "./routes.jsx";
import { THEME } from "./shell.jsx";

const theme = localStorage.getItem(THEME);
document.documentElement.classList.toggle("dark", theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);

const router = createBrowserRouter([...devRoutes, ...routes]);

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);

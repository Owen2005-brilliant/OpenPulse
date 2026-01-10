import { useEffect, useMemo, useState } from "react";
import Dashboard from "./pages/Dashboard";
import Home from "./pages/Home";
import { AnimatePresence, motion } from "framer-motion";

function parseHash() {
  const raw = window.location.hash.replace(/^#/, "");
  const [pathPart, queryPart] = raw.split("?");
  const path = (pathPart || "/").startsWith("/") ? (pathPart || "/") : `/${pathPart || ""}`;
  const params = new URLSearchParams(queryPart || "");
  const repo = params.get("repo") || "";
  return { path, repo };
}

export default function App() {
  const [hashState, setHashState] = useState(() => parseHash());

  useEffect(() => {
    const onChange = () => setHashState(parseHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const route = useMemo(() => {
    if (hashState.path === "/dashboard") return { name: "dashboard" as const, repo: hashState.repo };
    return { name: "home" as const, repo: hashState.repo };
  }, [hashState.path, hashState.repo]);

  return (
    <AnimatePresence mode="wait">
      {route.name === "dashboard" ? (
        <motion.div
          key="dashboard"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.24, ease: "easeOut" }}
        >
          <Dashboard initialRepo={route.repo} />
        </motion.div>
      ) : (
        <motion.div
          key="home"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.24, ease: "easeOut" }}
        >
          <Home />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

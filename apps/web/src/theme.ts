import { useState } from "react";

// Light, dark or follow the system. The choice is a per-browser
// convenience kept in localStorage and applied as html[data-theme].

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "wakewright.theme";

export function storedTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(choice: ThemeChoice) {
  if (choice === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
}

export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState(storedTheme);
  return [
    choice,
    (next) => {
      setChoice(next);
      applyTheme(next);
      try {
        if (next === "system") localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, next);
      } catch {
        // Storage blocked: the choice lasts for this page only.
      }
    },
  ];
}

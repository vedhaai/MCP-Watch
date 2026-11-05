import { createContext, useContext } from "react";
import type { Meta, Project, RuleInfo, User } from "./types";

export interface AppState {
  user: User;
  meta: Meta;
  rules: Record<string, RuleInfo>;
  projects: Project[] | undefined;
  refreshProjects: () => void;
  signOut: () => void;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside AppContext");
  return ctx;
}

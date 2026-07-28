import { MaterialKind } from "@/api/types";
import { IconName } from "@/components/ui";
import { MaterialMode } from "./modePolicy";

export function materialIcon(kind: MaterialKind): IconName {
  switch (kind) {
    case "diagram":
      return "diagram";
    case "quiz":
      return "quiz";
    case "flashcards":
      return "flashcards";
    case "note":
      return "write";
    default:
      return "workspaces";
  }
}

export const MATERIALMODE_ICON: Record<MaterialMode, IconName> = {
  edit: "write",
  suggestion: "suggestionEdit",
  view: "view",
};

export const MATERIALMODE_LABEL: Record<MaterialMode, string> = {
  edit: "Edit",
  suggestion: "Suggestion",
  view: "View",
};

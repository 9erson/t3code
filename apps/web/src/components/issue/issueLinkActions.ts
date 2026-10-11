import { readLocalApi } from "~/localApi";
import { toastManager } from "../ui/toast";

export async function openIssueOnGitHub(url: string): Promise<void> {
  try {
    await readLocalApi()?.shell.openExternal(url);
  } catch {
    toastManager.add({ type: "error", title: "Could not open the issue" });
  }
}

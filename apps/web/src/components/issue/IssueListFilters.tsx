import { ListFilterIcon } from "lucide-react";
import type { EnvironmentId, ProjectId, IssueListSort } from "@t3tools/contracts";
import { Button } from "../ui/button";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuCheckboxItem,
  MenuItem,
  MenuSeparator,
} from "../ui/menu";
import type { IssueListPreferences, IssueListPreferencePatch } from "./issueListPreferences";

export const ISSUE_SORT_LABELS: Record<IssueListSort, string> = {
  updated: "Updated",
  newest: "Newest",
  oldest: "Oldest",
  comments: "Most commented",
};

export function IssueListFilters({
  value,
  onChange,
  projects,
  environments,
  hosts,
  authors,
  labels,
}: {
  value: IssueListPreferences;
  onChange: (patch: IssueListPreferencePatch) => void;
  projects: ReadonlyArray<{ id: ProjectId; title: string; environmentId: EnvironmentId }>;
  environments: ReadonlyArray<{ environmentId: EnvironmentId; label: string }>;
  hosts: ReadonlyArray<string>;
  authors: ReadonlyArray<string>;
  labels: ReadonlyArray<string>;
}) {
  const active = !!(
    value.host ||
    value.projectId ||
    value.environmentId ||
    value.author ||
    value.labels?.length ||
    value.issueInvolvement !== "all"
  );
  return (
    <Menu>
      <MenuTrigger render={<Button variant={active ? "secondary" : "outline"} size="sm" />}>
        <ListFilterIcon /> Filters
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuSub>
          <MenuSubTrigger>Involvement</MenuSubTrigger>
          <MenuSubPopup>
            <MenuRadioGroup
              value={value.issueInvolvement}
              onValueChange={(next) =>
                onChange({ issueInvolvement: next as IssueListPreferences["issueInvolvement"] })
              }
            >
              {(
                [
                  ["all", "Everyone"],
                  ["assigned", "Assigned to you"],
                  ["authored", "Created by you"],
                  ["others", "Others"],
                ] as const
              ).map(([key, label]) => (
                <MenuRadioItem key={key} value={key}>
                  {label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
        <MenuSub>
          <MenuSubTrigger>Environment</MenuSubTrigger>
          <MenuSubPopup>
            <MenuRadioGroup
              value={value.environmentId ?? ""}
              onValueChange={(next) =>
                onChange({
                  environmentId: next ? (next as EnvironmentId) : undefined,
                  projectId: undefined,
                })
              }
            >
              <MenuRadioItem value="">All environments</MenuRadioItem>
              {environments.map((environment) => (
                <MenuRadioItem key={environment.environmentId} value={environment.environmentId}>
                  {environment.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
        <MenuSub>
          <MenuSubTrigger>Project</MenuSubTrigger>
          <MenuSubPopup>
            <MenuRadioGroup
              value={value.projectId ? JSON.stringify([value.environmentId, value.projectId]) : ""}
              onValueChange={(next) => {
                if (!next) return onChange({ projectId: undefined });
                const [environmentId, projectId] = JSON.parse(next) as [EnvironmentId, ProjectId];
                onChange({ environmentId, projectId });
              }}
            >
              <MenuRadioItem value="">All projects</MenuRadioItem>
              {projects
                .filter(
                  (project) =>
                    !value.environmentId || project.environmentId === value.environmentId,
                )
                .map((project) => (
                  <MenuRadioItem
                    key={`${project.environmentId}:${project.id}`}
                    value={JSON.stringify([project.environmentId, project.id])}
                  >
                    {project.title}
                  </MenuRadioItem>
                ))}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
        <MenuSub>
          <MenuSubTrigger>Host{value.host ? ` · ${value.host}` : ""}</MenuSubTrigger>
          <MenuSubPopup>
            <MenuRadioGroup
              value={value.host ?? ""}
              onValueChange={(next) => onChange({ host: next || undefined })}
            >
              <MenuRadioItem value="">All hosts</MenuRadioItem>
              {[...new Set([...hosts, ...(value.host ? [value.host] : [])])].map((host) => (
                <MenuRadioItem key={host} value={host}>
                  {host}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
        <MenuSub>
          <MenuSubTrigger>Author{value.author ? ` · ${value.author}` : ""}</MenuSubTrigger>
          <MenuSubPopup>
            <MenuRadioGroup
              value={value.author ?? ""}
              onValueChange={(next) => onChange({ author: next || undefined })}
            >
              <MenuRadioItem value="">All authors</MenuRadioItem>
              {[...new Set([...authors, ...(value.author ? [value.author] : [])])].map((author) => (
                <MenuRadioItem key={author} value={author}>
                  {author}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
        <MenuSub>
          <MenuSubTrigger>
            Labels{value.labels?.length ? ` · ${value.labels.length}` : ""}
          </MenuSubTrigger>
          <MenuSubPopup>
            {[...new Set([...labels, ...(value.labels ?? [])])].map((label) => (
              <MenuCheckboxItem
                key={label}
                checked={value.labels?.includes(label) ?? false}
                disabled={!value.labels?.includes(label) && (value.labels?.length ?? 0) >= 10}
                onCheckedChange={(checked) =>
                  onChange({
                    labels: checked
                      ? [...(value.labels ?? []), label]
                      : value.labels?.filter((current) => current !== label),
                  })
                }
              >
                {label}
              </MenuCheckboxItem>
            ))}
            {labels.length === 0 ? (
              <MenuItem disabled>No labels in the loaded issues</MenuItem>
            ) : null}
          </MenuSubPopup>
        </MenuSub>
        <MenuSeparator />
        <MenuItem
          onClick={() =>
            onChange({
              issueInvolvement: "all",
              environmentId: undefined,
              projectId: undefined,
              host: undefined,
              author: undefined,
              labels: undefined,
            })
          }
        >
          Clear filters
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

export function IssueListSortMenu({
  value,
  onChange,
}: {
  value: IssueListSort;
  onChange: (sort: IssueListSort) => void;
}) {
  return (
    <Menu>
      <MenuTrigger render={<Button variant="outline" size="sm" />}>
        Sort: {ISSUE_SORT_LABELS[value]}
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuRadioGroup value={value} onValueChange={(next) => onChange(next as IssueListSort)}>
          {Object.entries(ISSUE_SORT_LABELS).map(([sort, label]) => (
            <MenuRadioItem key={sort} value={sort}>
              {label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

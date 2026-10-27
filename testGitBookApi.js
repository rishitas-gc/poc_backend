
require("dotenv").config();

const Diff = require("diff");

const BASE_URL = "https://api.gitbook.com/v1";

async function gitbookGet(endpoint) {
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${process.env.GITBOOK_API_TOKEN}`,
      Accept: "application/json",
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `GitBook API ${response.status}: ${text}`
    );
  }

  return JSON.parse(text);
}


async function getPage(spaceId, revisionId, pageId) {
  return gitbookGet(
    `/spaces/${encodeURIComponent(spaceId)}` +
    `/revisions/${encodeURIComponent(revisionId)}` +
    `/page/${encodeURIComponent(pageId)}?format=markdown`
  );
}


async function main() {
  const spaceId = process.env.GITBOOK_SPACE_ID;
  const revisionId = process.env.GITBOOK_REVISION_ID;

  if (!spaceId || !revisionId || !process.env.GITBOOK_API_TOKEN) {
    throw new Error("Check GITBOOK_SPACE_ID, GITBOOK_REVISION_ID and GITBOOK_API_TOKEN in .env");
  }

  // Get the current revision and its parent.
  const revision = await gitbookGet(
    `/spaces/${encodeURIComponent(spaceId)}` +
    `/revisions/${encodeURIComponent(revisionId)}`
  );

  const previousRevisionId = revision.parents?.[0];

  if (!previousRevisionId) {
    console.log("No previous revision exists to compare.");
    return;
  }

  // Identify the pages changed in this revision.
  const result = await gitbookGet(
    `/spaces/${encodeURIComponent(spaceId)}` +
    `/revisions/${encodeURIComponent(revisionId)}/changes?limit=100`
  );

  console.log("\nRevision:", revisionId);
  console.log("Previous revision:", previousRevisionId);

  for (const change of result.changes || []) {
    if (!change.page?.id) continue;

    console.log("\n====================================");
    console.log("Change type:", change.type);
    console.log("Page:", change.page.title);
    console.log("====================================");

    if (change.type === "page_created") {
      console.log("A new page was created.");
    }

    if (change.type === "page_deleted") {
      console.log("A page was deleted.");
    }

    if (change.type !== "page_edited") continue;

    const pageId = change.page.id;

    const [oldPage, newPage] = await Promise.all([
      getPage(spaceId, previousRevisionId, pageId),
      getPage(spaceId, revisionId, pageId),
    ]);

    const oldMarkdown = oldPage.markdown ?? "";
    const newMarkdown = newPage.markdown ?? "";

    if (oldMarkdown === newMarkdown) {
      console.log(
        "Markdown is identical, or the API did not return Markdown."
      );
      console.log("Old response keys:", Object.keys(oldPage));
      console.log("New response keys:", Object.keys(newPage));
      continue;
    }

    const changes = Diff.diffLines(oldMarkdown, newMarkdown);

    console.log("\nEXACT TEXT CHANGES:\n");

    for (const part of changes) {
      const prefix = part.added
        ? "+ "
        : part.removed
          ? "- "
          : "  ";

      if (part.added || part.removed) {
        for (const line of part.value.split("\n")) {
          if (line !== "") {
            console.log(prefix + line);
          }
        }
      }
    }
  }

  if (result.more > 0) {
    console.log(
      "\nWarning: More changes exist than were returned. " +
      "Fetch additional results to inspect every change."
    );
  }
}

main().catch((error) => {
  console.error("Failed:", error.message);
});

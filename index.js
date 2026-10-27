
require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const GITBOOK_API = "https://api.gitbook.com/v1";

// Store received events in memory for the POC.
const events = [];
let nextEventId = 1;

// Make authenticated requests to GitBook.
async function gitbookGet(endpoint) {
  if (!process.env.GITBOOK_API_TOKEN) {
    throw new Error("GITBOOK_API_TOKEN is missing from .env");
  }

  const response = await fetch(`${GITBOOK_API}${endpoint}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${process.env.GITBOOK_API_TOKEN}`,
      Accept: "application/json",
    },
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `GitBook API returned ${response.status}: ${responseText}`
    );
  }

  return JSON.parse(responseText);
}

// Fetch the actual Markdown for a page in a specific revision.
async function fetchPageMarkdown(spaceId, revisionId, pageId) {
  const endpoint =
    `/spaces/${encodeURIComponent(spaceId)}` +
    `/revisions/${encodeURIComponent(revisionId)}` +
    `/page/${encodeURIComponent(pageId)}` +
    `?format=markdown`;

  return gitbookGet(endpoint);
}


function getAddedLines(oldMarkdown, newMarkdown) {
  const oldLines = oldMarkdown.split("\n");
  const newLines = newMarkdown.split("\n");

  // Find lines in the new version that aren't in the old version.
  // This is a simple line-based comparison, not a full Git diff.
  const oldSet = new Set(oldLines);

  return newLines.filter(
    (line) => line.trim() !== "" && !oldSet.has(line)
  );
}


// Fetch changes and retrieve the content of each created or edited page.

async function processRevision(spaceId, revisionId) {
  const revision = await gitbookGet(
    `/spaces/${encodeURIComponent(spaceId)}` +
    `/revisions/${encodeURIComponent(revisionId)}`
  );

  const parentRevisionId = revision.parents?.[0];

  if (!parentRevisionId) {
    console.log("No parent revision available for comparison.");
    return;
  }

  const changes = await gitbookGet(
    `/spaces/${encodeURIComponent(spaceId)}` +
    `/revisions/${encodeURIComponent(revisionId)}/changes?limit=100`
  );

  for (const change of changes.changes || []) {
    if (
      !change.page?.id ||
      !["page_created", "page_edited"].includes(change.type)
    ) {
      continue;
    }

    const pageId = change.page.id;

    const currentPage = await gitbookGet(
      `/spaces/${encodeURIComponent(spaceId)}` +
      `/revisions/${encodeURIComponent(revisionId)}` +
      `/page/${encodeURIComponent(pageId)}?format=markdown`
    );

    let oldMarkdown = "";

    if (change.type === "page_edited") {
      try {
        const oldPage = await gitbookGet(
          `/spaces/${encodeURIComponent(spaceId)}` +
          `/revisions/${encodeURIComponent(parentRevisionId)}` +
          `/page/${encodeURIComponent(pageId)}?format=markdown`
        );

        oldMarkdown = oldPage.markdown || "";
      } catch (error) {
        console.error("Could not fetch previous page:", error.message);
      }
    }

    const newMarkdown = currentPage.markdown || "";
    const addedContent = getAddedLines(oldMarkdown, newMarkdown);

    const notification = {
      title: currentPage.title || change.page.title || "GitBook updated",
      pageId,
      changeType: change.type,
      content: addedContent.length
        ? addedContent.join("\n")
        : "No new non-empty lines detected.",
      timestamp: new Date().toISOString(),
    };

    console.log("\nNew content:", notification.content);

    io.emit("gitbook-update", notification);
  }
}


// Health check.
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Receive GitBook webhook events.
app.post("/webhook", (req, res) => {
  const payload = req.body || {};

  const event = {
    id: nextEventId++,
    eventType:
      req.headers["x-gitbook-event"] ||
      payload.type ||
      payload.event ||
      "unknown",
    receivedAt: new Date().toISOString(),
    headers: req.headers,
    payload,
  };

  events.push(event);

  console.log("\n========== GITBOOK WEBHOOK ==========");
  console.log(JSON.stringify(event, null, 2));

  // Respond promptly to GitBook before making API requests.
  res.status(200).json({
    received: true,
    eventId: event.id,
  });

  if (event.eventType !== "space_content_updated") {
    console.log("Webhook received; no content fetch for this event type.");
    return;
  }

  const spaceId = payload.spaceId;
  const revisionId = payload.revisionId;

  if (!spaceId || !revisionId) {
    console.error("Webhook is missing spaceId or revisionId.");
    return;
  }

  processRevision(spaceId, revisionId).catch((error) => {
    console.error("Failed to process GitBook revision:", error.message);
  });
});

// Optional endpoints to inspect events received by this POC.
app.get("/events", (req, res) => {
  res.json(events);
});

app.get("/events/:id", (req, res) => {
  const event = events.find(
    (item) => item.id === Number(req.params.id)
  );

  if (!event) {
    return res.status(404).json({ error: "Event not found" });
  }

  res.json(event);
});

// Browser connection status.
io.on("connection", (socket) => {
  console.log("Browser connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("Browser disconnected:", socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

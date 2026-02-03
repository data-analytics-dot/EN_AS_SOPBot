import pkg from "@slack/bolt";
const { App } = pkg;
import dotenv from "dotenv";
import axios from "axios";
import OpenAI from "openai";
import fs from "fs/promises";
import path from "path";

dotenv.config();

// --- Persistent session setup ---
const SESSIONS_FILE = process.env.SESSIONS_FILE || path.join(process.cwd(), "sessions.json");
const SAVE_DELAY_MS = 500;
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS) || 1000 * 60 * 60; // 1 hour
const CODA_TABLE_ID_LOGS = process.env.CODA_TABLE_ID_LOGS;
const CODA_DOC_ID_LOGS = process.env.CODA_DOC_ID_LOGS;
const CODA_API_TOKEN = process.env.CODA_API_TOKEN;
const CODA_TABLE_ID_PHASES = process.env.CODA_TABLE_ID_PHASES;
const PHASE_NAME_COLUMN_ID = process.env.PHASE_NAME_COLUMN_ID;
const PHASE_START_COLUMN_ID = process.env.PHASE_START_COLUMN_ID;
const PHASE_END_COLUMN_ID = process.env.PHASE_END_COLUMN_ID;


async function logSopUsageToCoda(client, payload) {
  try {

    const userName = payload.userName || await getSlackUserName(client, payload.userId);

    // 🚀 Fetch phase info
    const phases = await fetchPhases();
    const activePhase = getActivePhase(phases);

    const phaseName = activePhase
      ? activePhase.values[PHASE_NAME_COLUMN_ID]
      : null;

    const res = await fetch(
      `https://coda.io/apis/v1/docs/${CODA_DOC_ID_LOGS}/tables/${CODA_TABLE_ID_LOGS}/rows`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CODA_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          rows: [
            {
              cells: [
                { column: "c-oZXdS3AAj5", value: userName },
                { column: "c-IwS9YVVcIq", value: payload.userId },
                { column: "c-RNSEENcCdA", value: payload.channel },
                { column: "c-vJpPj2lNsj", value: String(payload.threadTs) },
                { column: "c-dgNIZbOVZQ", value: payload.question },
                { column: "c-F8uEMuDPA-", value: payload.sopTitle ?? "" },
                { column: "c-sF9gP8NODB", value: payload.stepFound ? "Yes" : "No"},
                { column: "c-ZqQoPmZ3M0", value: payload.status },
                { column: "c-y669WSSbMO", value: payload.gptResponse ?? "" },
                { column: "c-awpUarmk0l", value: phaseName },
                { column: "c-PW0T6e6Kg5", value: new Date().toISOString() },
              ],
            },
          ],
        }),
      }
    );
    if (!res.ok) {
          console.error("❌ Coda log failed:", res.status, await res.text());
          return null;
        }

        const data = await res.json();
        return data.rows?.[0]?.id ?? null;
  } catch (err) {
    console.error("❌ Failed to log SOP usage to Coda", err);
  }
}

async function fetchPhases() {
  const res = await fetch(
    `https://coda.io/apis/v1/docs/${CODA_DOC_ID_LOGS}/tables/${CODA_TABLE_ID_PHASES}/rows`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${CODA_API_TOKEN}`,
      },
    }
  );

  if (!res.ok) {
    console.error("❌ Failed to fetch phases:", res.status, await res.text());
    return [];
  }

  const data = await res.json();
  return data.items || [];
}
function getActivePhase(phases) {
  const now = new Date();

  const parseDate = (d) => (d ? new Date(d) : null);

  // Sort by start date so latest start date wins if overlap
  phases.sort((a, b) => {
    const aStart = parseDate(a.values[PHASE_START_COLUMN_ID]);
    const bStart = parseDate(b.values[PHASE_START_COLUMN_ID]);
    return aStart - bStart;
  });

  for (const phase of phases) {
    const startDate = parseDate(phase.values[PHASE_START_COLUMN_ID]);
    const endDate = parseDate(phase.values[PHASE_END_COLUMN_ID]);

    if (!startDate) continue;

    // If endDate is null, it's ongoing
    if (!endDate) {
      if (now >= startDate) return phase;
    } else {
      if (now >= startDate && now <= endDate) return phase;
    }
  }

  return null;
}



// --- 🧠 Memory for per-user, per-thread SOP step tracking ---
function getUserContext(userId, thread_ts) {
  if (!userSessions[userId]) userSessions[userId] = {};
  if (!userSessions[userId][thread_ts]) {
    userSessions[userId][thread_ts] = {
      state: "idle", 
      lastSOP: null,
      lastStepNumber: null,
      awaitingConfirmation: false,
      timestamp: Date.now(),
      activeSOPs: [],
    };
  }
  return userSessions[userId][thread_ts];
}

function setUserContext(userId, threadTs, updates) {
  const key = `${userId}:${threadTs}`;
  const prev = userContexts[key] || {};

  userContexts[key] = {
    ...prev,
    ...updates,
    timestamp: Date.now(),
  };
}


function resetUserContext(userId, thread_ts) {
  if (userSessions[userId]) {
    delete userSessions[userId][thread_ts];
    scheduleSaveSessions();
  }
}



let userSessions = {};
let _saveTimeout = null;

// Load saved sessions (ignore expired)
async function loadSessions() {
  try {
    const raw = await fs.readFile(SESSIONS_FILE, "utf8");
    const data = JSON.parse(raw);
    const now = Date.now();
    for (const id of Object.keys(data)) {
      const s = data[id];
      if (s && s.timestamp && now - s.timestamp > SESSION_TTL_MS) {
        delete data[id];
      }
    }
    userSessions = data;
    console.log("✅ Sessions loaded from", SESSIONS_FILE);
  } catch (err) {
    if (err.code === "ENOENT") console.log("No previous sessions file — starting fresh");
    else console.error("Error loading sessions:", err);
    userSessions = {};
  }
}

// Save sessions to disk (atomic)
async function saveSessionsNow() {
  try {
    const tmp = SESSIONS_FILE + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(userSessions, null, 2), "utf8");
    await fs.rename(tmp, SESSIONS_FILE);
  } catch (err) {
    console.error("Error saving sessions:", err);
  }
}

// Debounce writes
function scheduleSaveSessions() {
  if (_saveTimeout) clearTimeout(_saveTimeout);
  _saveTimeout = setTimeout(() => {
    _saveTimeout = null;
    saveSessionsNow();
  }, SAVE_DELAY_MS);
}

// function setSession(userId, sessionObj) {
//   userSessions[userId] = { ...sessionObj, timestamp: Date.now() };
//   scheduleSaveSessions();
// }

// function clearSession(userId) {
//   if (userSessions[userId]) {
//     delete userSessions[userId];
//     scheduleSaveSessions();
//   }
// }

// --- Init Slack + OpenAI ---

const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --- Helper: fetch SOPs from Coda (with pagination) ---
async function fetchSOPs() {
  const baseUrl = `https://coda.io/apis/v1/docs/${process.env.CODA_DOC_ID}/tables/${process.env.CODA_TABLE_ID}/rows?useColumnNames=true`;
  const headers = { Authorization: `Bearer ${process.env.CODA_API_TOKEN}` };
  let url = baseUrl;
  let allRows = [];

  while (url) {
    const res = await axios.get(url, { headers });
    const data = res.data;

    allRows.push(...(data.items || []));
    url = data.nextPageLink || null;
  }

  const sops = allRows.map((r) => {
    const v = r.values || {};
    return {
      title: v.Title ?? "Untitled SOP",
      sop: v.Content ?? "",
      link: v["SOP Traceable Link"] ?? "",
      status: v.Status ?? "",
      author: v.Author ?? "",
      tagsBot: v["Tags Bot Result"] ?? "",
      tagsManual: v["keywords"] ?? "",

    };
  });

  console.log(`✅ Loaded ${sops.length} SOPs from Coda`);
  return sops;
}

// --- Helper: parse SOP into steps ---
function parseSteps(sopText) {
  const lines = sopText.split("\n");
  let currentStep = "";
  let stepContent = [];
  const steps = [];

  for (const line of lines) {
    const stepHeaderMatch = line.match(/^##\s*Step\s*\d+/i);
    if (stepHeaderMatch) {
      if (stepContent.length > 0) {
        steps.push({ step: currentStep, content: stepContent.join("\n") });
      }
      currentStep = line;
      stepContent = [];
    } else {
      stepContent.push(line);
    }
  }

  if (stepContent.length > 0) {
    steps.push({ step: currentStep, content: stepContent.join("\n") });
  }

  return steps;
}

function normalizeWord(w) {
  if (w.endsWith("ing")) return w.slice(0, -3);
  if (w.endsWith("ed")) return w.slice(0, -2);
  if (w.endsWith("es")) return w.slice(0, -2);
  if (w.endsWith("s")) return w.slice(0, -1);
  return w;
}


// --- Helper: filter relevant SOPs ---
function filterRelevantSOPs(sops, query) {
  const STOPWORDS = new Set([
    "how","to","the","a","an","for","of","on","in","is","are",
    "do","does","did","i","we","you","what","when","where","why"
  ]);


  const q = query.toLowerCase().replace(/[^\w\s]/g, "").trim();
  console.log(`\n🔍 Filtering SOPs for query: "${query}"`);

  const scored = sops.map((s) => {
    const title = (s.title || "").toLowerCase();
    const content = (s.sop || "").toLowerCase();
    let score = 0;
    const tagsRaw = [
      ...(Array.isArray(s.tagsBot) ? s.tagsBot : [s.tagsBot]),
      ...(Array.isArray(s.tagsManual) ? s.tagsManual : [s.tagsManual]),
    ];


    const tags = tagsRaw
      .flatMap((t) =>
        typeof t === "string"
          ? t.toLowerCase().split(/[,;|]/)
          : []
      )
      .map((t) => t.trim())
      .filter(Boolean);

    // remove duplicates
    const uniqueTags = [...new Set(tags)];



    const queryWords = q
    .split(/\s+/)
    .map(normalizeWord)
    .filter(w => w && !STOPWORDS.has(w));

    const titleWords = title
    .split(/\s+/)
    .map(normalizeWord)
    .filter(Boolean);

       
    const hasTitleHit = queryWords.some(w =>
      titleWords.some(tw => tw === w || tw.includes(w))
    );

    const hasExactTagHit = uniqueTags.some(tag =>
      queryWords.includes(tag)
    );

    if (!hasTitleHit && !hasExactTagHit) {
      return { ...s, score: 0 };
    }

    let matchCount = 0;
    for (const w of queryWords) {
      if (titleWords.some((tw) => tw.includes(w))) matchCount++;
    }

    score += matchCount * 25;


    let contentMatchCount = 0;
    for (const w of queryWords) {
      if (content.includes(w)) contentMatchCount++;
    }
    score += Math.min(contentMatchCount, 2) * 2;



    let tagMatch = 0;
    for (const w of queryWords) {
      for (const tag of uniqueTags) {
        if (tag === w) {
          tagMatch += 3;       // exact match = strong
        } else if (tag.startsWith(w) || w.startsWith(tag)) {
          tagMatch += 0.5;
        }
      }
    }
    score += tagMatch * 10;




    return { ...s, score };
  });

  const sorted = scored.sort((a, b) => b.score - a.score);
  const filtered = sorted.filter((s) => s.score > 0);
  



  const top = filtered.length > 0 ? filtered.slice(0, 3) : sorted.slice(0, 2);
  if (filtered.length === 0) {
    console.log("⚠️ No relevant SOP found");
    return [];
  }

  if (filtered.length === 0) {
    console.log("⚠️ No relevant SOP found");
    return [];
  }

  console.log(`✅ Top match: "${filtered[0].title}" (score ${filtered[0].score})`);
  return filtered.slice(0, 3);

}

async function getSlackUserName(client, userId) {
  try {
    const res = await client.users.info({ user: userId });
    if (res.ok) {
      // Try display_name first, fallback to real_name
      return res.user.profile.display_name || res.user.real_name || userId;
    }
    return userId; // fallback if API fails
  } catch (err) {
    console.error("❌ Failed to get Slack user name:", err);
    return userId;
  }
}


// --- Handle app mention ---

slackApp.event("app_mention", async ({ event, client }) => {
  const userId = event.user;
  const query = event.text.replace(/<@[^>]+>/, "").trim();
  const thread_ts = event.thread_ts || event.ts;

  // ⏳ Expire stale context for this user + thread
  const ctx = getUserContext(userId, thread_ts);
 if (ctx?.rowId && Date.now() - ctx.timestamp > SESSION_TTL_MS) {
    // allow feedback window
  } else if (Date.now() - ctx.timestamp > SESSION_TTL_MS) {
    resetUserContext(userId, thread_ts);
  }


  const session = userSessions[userId] || {};
  console.log(`User asked: ${query}`);

  // --- Retrieve or initialize user context for this thread ---
  const context = getUserContext(userId, thread_ts);

  setUserContext(userId, thread_ts, {
    state: "active",
  });

  const lowerText = query.toLowerCase();

  // 🧭 Reset context
  if (lowerText.includes("start over") || lowerText.includes("reset")) {
    resetUserContext(userId, thread_ts);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts,
      text: "Got it — starting fresh! What SOP do you want to ask about?",
    });
    return;
  }

  // ⏭️ Next step
  if (context.lastSOP && lowerText.includes("next step")) {
    context.lastStepNumber = (context.lastStepNumber || 1) + 1;
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts,
      text: `Next step for *${context.lastSOP}* is Step ${context.lastStepNumber}.`,
    });
    setUserContext(userId, thread_ts, context);
    return;
  }

  // ⏮️ Previous step
  if (context.lastSOP && lowerText.includes("previous step")) {
    context.lastStepNumber = Math.max(1, (context.lastStepNumber || 2) - 1);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts,
      text: `Previous step for *${context.lastSOP}* is Step ${context.lastStepNumber}.`,
    });
    setUserContext(userId, thread_ts, context);
    return;
  }

  // ❓ Ask which step this is
  if (context.lastSOP && lowerText.includes("what step")) {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts,
      text: `Based on your last question, this is Step ${context.lastStepNumber || 1} from *${context.lastSOP}*.`,
    });
    return;
  }

  // --- Fetch or reuse SOPs ---
  let topSops;
  let isFollowUp = false;

  if (session?.activeSOPs && session.thread_ts === thread_ts) {
    console.log("💬 Follow-up question detected — reusing previous SOPs");
    topSops = session.activeSOPs;
    isFollowUp = true;
  } else {
    const sops = await fetchSOPs();
    topSops = filterRelevantSOPs(sops, query);
  }

  if (topSops.length === 0) {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts,
      text: "I couldn’t find an SOP that matches your question.",
    });

    await logSopUsageToCoda(client, {
      userId: event.user,
      channel: event.channel,
      threadTs: thread_ts,
      question: query,
      sopTitle: null,
      stepFound: false,
      status: "No SOP",
      gptResponse: null,
    });

    return;
  }

  // --- Keep only top 3 SOPs ---
  topSops = topSops.slice(0, 3);

  // --- Filter deprecated SOPs ---
  const liveSOPs = topSops.filter(
    (s) => !(s.status || "").toLowerCase().includes("deprecated")
  );

  if (liveSOPs.length === 0) {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts,
      text: `:warning: All top SOP matches are deprecated. Please check the SOP library for newer versions.`,
    });

    await logSopUsageToCoda(client, {
      userId,
      channel: event.channel,
      threadTs: thread_ts,
      question: query,
      sopTitle: null,
      stepFound: false,
      status: "Deprecated SOP",
      gptResponse: null,
    });

    return;
  }

  topSops = liveSOPs.slice(0, 3);

  // --- Build context for GPT from top 3 SOPs ---
  let statusNote = "";
  const sopContexts = topSops
    .map((s) => {
      const steps = parseSteps(s.sop)
        .map((step) => `${step.step}\n${step.content}`)
        .join("\n\n");
      return `Title: ${s.title}\nLink: <${s.link}|${s.title}>\n${steps}`;
    })
    .join("\n\n---\n\n");

  // --- If follow-up, prepend context about previous SOP ---
  let followUpNote = "";
  if (isFollowUp && topSops.length > 0) {
    followUpNote = `\nThe user is asking a follow-up question about the same SOP titled "${topSops[0].title}". Use only this SOP to answer.\n\n`;
  }

  // --- GPT Prompt ---
  const prompt = `You are a helpful support assistant for SOPs. Use the SOPs below as your knowledge base.

${followUpNote}
Rules:
1. First, you MUST choose ONE SOP that best answers the user question.
2. Then, find the SINGLE most relevant step (or sub-steps) inside that SOP, make sure it is relevant to the question asked and include the step number in the message.
3. Answer ONLY from that step. Do NOT include unrelated steps, summaries, or introductions.
4. Paraphrase concisely in instructional style, second person ("you"), with clear action verbs.
5. After explaining the step, include any relevant follow-through guidance:
   - 💡 Tips that help execute the step more efficiently or correctly
   - ⚠️ Warnings or cautions if there are common mistakes, risks, or edge cases
   - 📝 Notes for important context or clarifications
   Formatting rules:
   - Insert a blank line between different insight types
   Only include items that are directly relevant to the step. Do not force all types.
6. End with: "For more details and related links: <SOP URL|SOP Title>". Slack only supports <URL|Title> format. Always use this.
7. If no SOP or step matches, respond: "I couldn’t find an SOP that matches your question."

User question: ${query}

Here are all the SOPs:
${sopContexts}`;

  const gptRes = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
  });

  const answer = gptRes.choices[0].message?.content ?? "No answer.";

  const NO_SOP_RESPONSE = "I couldn’t find an SOP that matches your question.";
  const isNoSop = answer.trim() === NO_SOP_RESPONSE;

  // --- Extract chosen SOP from GPT response ---
  const chosenSOP = answer.match(/<[^|>]+\|([^>]+)>/)?.[1]?.trim() ?? null;

  const finalText =
    answer.trim() === NO_SOP_RESPONSE
      ? NO_SOP_RESPONSE
      : `${answer}\n\n${statusNote}`;

  await client.chat.postMessage({
    channel: event.channel,
    thread_ts,
    text: finalText,
  });

  const rowId = await logSopUsageToCoda(client, {
    userId: userId,
    channel: event.channel,
    threadTs: thread_ts,
    question: query,
    sopTitle: chosenSOP,
    stepFound: !isNoSop,
    status: isNoSop ? "No SOP" : "Answered",
    gptResponse: isNoSop ? null : answer,
  });


  if (isNoSop) {
    resetUserContext(userId, thread_ts);
    return;
  }

  setUserContext(userId, thread_ts, {
    lastSOP: chosenSOP,
    lastStepNumber: 1,
    activeSOPs: topSops,
    rowId, 
  });
});

slackApp.event("message", async ({ event, client }) => {
  if (event.subtype === "bot_message") return;
  if (!event.thread_ts) return;

   // 🚫 CRITICAL: ignore app mentions here
  if (event.text?.includes(`<@${process.env.SLACK_BOT_USER_ID}>`)) {
    return;
  }

  const userId = event.user;
  const threadId = event.thread_ts;

    // ⏳ Expire stale context for this user + thread
  let ctx = getUserContext(userId, threadId);
  if (!ctx || Date.now() - ctx.timestamp > SESSION_TTL_MS) {
    resetUserContext(userId, threadId);
    ctx = getUserContext(userId, threadId); // refresh
  }


  const lowerText = (event.text || "").toLowerCase();

  // --- Resume ---
  if (lowerText === "resume") {
    if (ctx.state === "paused") {
      setUserContext(userId, threadId, { state: "active" });
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadId,
        text: `🔄 Resumed. We were on *${ctx.lastSOP ?? "your SOP"}*.`,
      });
    } else {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadId,
        text: "Your session is already active. You can continue asking questions.",
      });
    }
    return;
  }

  // --- Pause / end commands ---
    const pauseCommands = ["done", "resolved"];
    if (pauseCommands.some(cmd => lowerText.includes(cmd))) {
    setUserContext(userId, threadId, { state: "paused" });

    // 🔄 re-read context AFTER update
    const updatedCtx = getUserContext(userId, threadId);

    if (!updatedCtx?.rowId) {
      console.warn("⚠️ No rowId found for helpfulness logging", updatedCtx);
    }

    await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadId,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "✅ Got it — I’ll step back.\n\n*Was this helpful?*"
              }
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "👍 Yes" },
                  style: "primary",
                  value: JSON.stringify({
                    rowId: updatedCtx.rowId,
                    helpful: "Yes"
                  }),
                  action_id: "helpful_yes"
                },
                {
                  type: "button",
                  text: { type: "plain_text", text: "👎 No" },
                  style: "danger",
                  value: JSON.stringify({
                    rowId: updatedCtx.rowId,
                    helpful: "No"
                  }),
                  action_id: "helpful_no"
                }
              ]
            }
          ]
        });


    return;
  }




    // 🚫 Ignore unless explicitly active
  if (ctx.state !== "active") return;
  if (!ctx.activeSOPs?.length) return;


  const activeSOP = ctx.activeSOPs[0];
  const query = event.text.trim();

  console.log("🔥 Follow-up in thread detected:", query);

  const sopContexts = `
Title: ${activeSOP.title}
Link: <${activeSOP.link}|${activeSOP.title}>

${parseSteps(activeSOP.sop)
    .map(s => `${s.step}\n${s.content}`)
    .join("\n\n")}
`;

  const prompt = `You are a helpful support assistant for SOPs.
The user is asking a follow-up question about: "${activeSOP.title}".

Use ONLY this SOP content. Answer strictly using the most relevant step.

User question: ${query}

SOP Content:
${sopContexts}
`;

  const gptRes = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
  });

  const answer = gptRes.choices[0].message?.content ?? "No answer.";
  const NO_SOP_RESPONSE = "I couldn’t find an SOP that matches your question.";

  await client.chat.postMessage({
    channel: event.channel,
    thread_ts: threadId,
    text: answer,
  });

  await logSopUsageToCoda(client, {
      userId: userId,
      channel: event.channel,
      threadTs: threadId,
      question: query,
      sopTitle: answer === NO_SOP_RESPONSE ? null : activeSOP.title,
      stepFound: answer === NO_SOP_RESPONSE ? false : true,
      status: answer === NO_SOP_RESPONSE ? "No SOP" : "Follow-up Answer",
      gptResponse: answer
  });

});

async function pickBestLiveSOP(query, deprecatedSOP, liveSOPs) {
    const prompt = `
  User question:
  "${query}"

  Deprecated SOP:
  "${deprecatedSOP.title}"

  Live SOP options:
  ${liveSOPs.map((s, i) => `${i + 1}. ${s.title}`).join("\n")}

  Which ONE live SOP best answers the user's question?

  Rules:
  - Respond with ONLY the number (1, 2, 3, etc)
  - No explanation
  `;

    const res = await openai.chat.completions.create({
      model: "gpt-4",
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    });

    const idx = parseInt(res.choices[0].message.content.trim(), 10);
    return liveSOPs[idx - 1] ?? liveSOPs[0];
}

async function logHelpfulToCoda({ rowId, helpful }) {
  if (!rowId) return;

  try {
    const updateRes = await fetch(
      `https://coda.io/apis/v1/docs/${CODA_DOC_ID_LOGS}/tables/${CODA_TABLE_ID_LOGS}/rows/${rowId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${CODA_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          cells: [{ column: "c-W1btQ6Urg3", value: helpful }],
        }),
      }
    );

    if (!updateRes.ok) {
      console.error("❌ Coda update failed:", updateRes.status, await updateRes.text());
    }
  } catch (err) {
    console.error("❌ Failed to log helpfulness", err);
  }
}




// --- Handle yes/no replies in thread ---
// slackApp.event("message", async ({ event, client }) => {
//   // Ignore bot messages or messages not in a thread
//   if (event.subtype === "bot_message" || !event.thread_ts) return;

//   const userId = event.user;
//   const session = userSessions[userId];
//   const text = (event.text || "").trim().toLowerCase();

//   // Only respond if the user has an active confirmation session in this thread
//   if (!session?.awaitingConfirmation || session.thread_ts !== event.thread_ts) return;

//   if (["yes", "yep", "yeah"].includes(text)) {
//     await client.chat.postMessage({
//       channel: event.channel,
//       thread_ts: event.thread_ts,
//       text: "Glad I could help! You can view or search this SOP and others directly here: <https://coda.io/d/SOP-Database_dRB4PLkqlNM|SOP Library>. 🔍",
//     });
//     clearSession(userId);
//   } else if (["no", "nope", "nah"].includes(text)) {
//     await client.chat.postMessage({
//       channel: event.channel,
//       thread_ts: event.thread_ts,
//       text: "Alright, go ahead and ask your next question. 🙂",
//     });
//     clearSession(userId);
//   }
// });

// --- Start Slack App ---
(async () => {
  await loadSessions();
  await slackApp.start();
  console.log("⚡ SOP Bot is running!");
})();

slackApp.action(/helpful_.*/, async ({ ack, body, client }) => {
  await ack();

  const action = body.actions[0];
  const payload = JSON.parse(action.value);
  const { rowId, helpful } = payload;

  if (!rowId) {
    console.error("❌ Missing rowId in helpful action", payload);
    return;
  }

  console.log("🟢 Helpful click received:", { rowId, helpful });

  await logHelpfulToCoda({ rowId, helpful });

  // Optional UX: acknowledge vote without removing history
  await client.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    text: `🙏 Thanks! You marked this as *${helpful}*.`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🙏 Thanks! You marked this as *${helpful}*.`
        }
      }
    ]
  });

});

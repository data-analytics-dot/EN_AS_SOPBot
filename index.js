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
                { column: "c-sF9gP8NODB", value: payload.stepFound ? "Yes" : "No" },
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

    const json = await res.json();
    console.log("🟦 Coda response:", JSON.stringify(json, null, 2));

    // Extract rowId from addedRowIds
    const rowId = json.addedRowIds?.[0];

    console.log("🟦 Final rowId used:", rowId);

    // ✅ Add a tiny delay to ensure row is ready in Coda
    await new Promise(resolve => setTimeout(resolve, 150));

    return rowId;


  } catch (err) {
    console.error("❌ Failed to log SOP usage to Coda", err);
    return null;
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

function setUserContext(userId, thread_ts, data) {
  if (!userSessions[userId]) userSessions[userId] = {};
  userSessions[userId][thread_ts] = {
    ...userSessions[userId][thread_ts],
    ...data,
    timestamp: Date.now(),
  };
  scheduleSaveSessions();
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
  



  const top = filtered.length > 0 ? filtered.slice(0, 5) : sorted.slice(0, 2);
  if (filtered.length === 0) {
    console.log("⚠️ No relevant SOP found");
    return [];
  }

  if (filtered.length === 0) {
    console.log("⚠️ No relevant SOP found");
    return [];
  }

  console.log(`✅ Top match: "${filtered[0].title}" (score ${filtered[0].score})`);
  return filtered.slice(0, 5);

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
  resetUserContext(userId, thread_ts);
  let ctx = {}; 

  if (!ctx || Date.now() - ctx.timestamp > SESSION_TTL_MS) {
    resetUserContext(userId, thread_ts);
    ctx = getUserContext(userId, thread_ts); // refresh
  }

  console.log(`User asked: ${query}`);


  const lowerText = query.toLowerCase();

  // 🔄 Resume conversation
  if (lowerText === "resume") {
    const ctx = getUserContext(userId, thread_ts);
    if (ctx.state === "paused") {
      setUserContext(userId, thread_ts, { state: "active" });
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts,
        text: `🔄 Resumed. We were on *${ctx.lastSOP ?? "your SOP"}*.`,
      });
    }
    return;
  }

  // --- Fetch or reuse SOPs ---
  let topSops;
  let isFollowUp = false;

  // 🔒 FIX #1: thread-level SOP lock
  if (ctx?.activeSOPs?.length) {
    console.log("🔒 Follow-up detected — using locked SOP");
    topSops = ctx.activeSOPs;
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

  Important: 
- If TWO or more SOPs are relevant to the user's question, do NOT answer immediately. Instead, identify the relevant SOPs and ask the user for clarification, starting with the first SOP's title.  
- If exactly ONE SOP is clearly relevant, proceed to answer using that SOP and follow the Rules below.  
- If no SOP is relevant, respond: "I couldn’t find an SOP that matches your question."

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
   - 🔢 Include any computations, formulas, or numeric examples exactly as stated in the SOP step if relevant to the question
   - 📎 Include any forms, templates, links, or tools mentioned in the SOP that are relevant to the question, formatted as Slack hyperlinks: <URL|Title>
6. Formatting rules:
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

   if (answer.toLowerCase().includes("are you perhaps asking about") || topSops.length > 1) {
    // Ask user for clarification
    const first = topSops[0];
    const firstTitle = first.steps?.[0]?.step ?? first.title;

    setUserContext(userId, thread_ts, {
      state: "awaiting_disambiguation",
      sopCandidates: topSops,
      sopIndex: 0,
      originalQuery: query,
      timestamp: Date.now()
    });

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts,
      text: `Are you perhaps asking about *${firstTitle}*?`
    });
    return; // STOP here — wait for user YES/NO
  }

  // --- Extract chosen SOP from GPT response ---
  const chosenSOP = answer.match(/<[^|>]+\|([^>]+)>/)?.[1]?.trim() ?? topSops[0].title;
  
  const relatedSOPs = topSops
  .filter(s => s.title !== chosenSOP)
  .slice(0, 2); // optional: max 2 related SOPs

  let relatedText = "";
  if (relatedSOPs.length > 0) {
    relatedText = "\n\n*SOPs you might want to check:*\n";
    relatedText += relatedSOPs
      .map(s => `• <${s.link}|${s.title}>`)
      .join("\n");
  }

  const finalText =
  answer.trim() === NO_SOP_RESPONSE
    ? NO_SOP_RESPONSE
    : `${answer}\n\n${statusNote}${relatedText}`;


  await client.chat.postMessage({
    channel: event.channel,
    thread_ts,
    text: finalText,
  });

  await logSopUsageToCoda(client, {
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

  // Re-order topSops so the chosen one is first
  const validatedSOPObject = topSops.find(s => s.title === chosenSOP);

  // If GPT chose it, that is now our ONLY active SOP for this thread
  const finalLockedSOPs =  topSops.find(s => s.title === chosenSOP) ? [topSops.find(s => s.title === chosenSOP)] : [topSops[0]];

  setUserContext(userId, thread_ts, {
    ...ctx,
    state: "active",
    lastSOP: chosenSOP,
    lastStepNumber: 1,
    activeSOPs: finalLockedSOPs, // 🔒 This locks it for the "message" event!
    timestamp: Date.now()
  });

});

slackApp.event("message", async ({ event, client }) => {
  if (event.subtype === "bot_message") return;
  if (!event.thread_ts) return;

  const botUserId = (await client.auth.test()).user_id;
  if (event.text?.includes(`<@${botUserId}>`)) {
    console.log("🔄 Bot mentioned — routing to app_mention handler, skipping follow-up.");
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


  const lowerText = (event.text || "").toLowerCase().trim();

  // --- Resume ---
  if (lowerText === "resume") {
    if (ctx.state === "paused") {
      // 🔥 FIX: Spread the existing 'ctx' so we keep the SOP details!
      setUserContext(userId, threadId, { 
        ...ctx,      // 🔑 Preserve SOP data
        state: "active" 
      });
      
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadId,
        text: `🔄 Resumed. We were on *${ctx.lastSOP ?? "your SOP"}*.`,
      });
    }
    return;
  }

    // --- Pause / end commands ---

    
    const pauseCommands = ["done", "resolved"];
  if (pauseCommands.includes(lowerText)) {
    // 🔥 FIX: Spread the existing context (ctx) so we don't lose the SOP info!
    setUserContext(userId, threadId, { 
      ...ctx,      // 🔑 Preserve SOP data
      state: "paused" 
    });

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadId,
      text: "✅ Got it — I’ll step back. Say *resume* if you need more help.",
    });

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadId,
      text: "Was this helpful?",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Was this helpful?"
          }
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Yes" },
              style: "primary",
              // 🔥 CHANGE: Send channel and ts instead of rowId
              value: JSON.stringify({ channel: event.channel, ts: event.ts }),
              action_id: "helpful_yes"
            },
            {
              type: "button",
              text: { type: "plain_text", text: "No" },
              style: "danger",
              //CHANGE: Send channel and ts instead of rowId
              value: JSON.stringify({ channel: event.channel, ts: event.ts }),
              action_id: "helpful_no"
            },
            {
              type: "button",
              text: { type: "plain_text", text: ":raising_hand: Ask KM for help" },
              value: JSON.stringify({ channel: event.channel, ts: event.ts }),
              action_id: "helpful_ask_km" // New ID
            }
          ]
        }
      ]
    });
    return;
  }

  if (ctx.state === "awaiting_disambiguation" && ctx.sopCandidates?.length) {
    const userAnswer = lowerText;
    let nextIndex = ctx.sopIndex || 0;

    if (userAnswer === "yes") {
      // User confirmed the SOP
      const confirmedSOP = ctx.sopCandidates[nextIndex];
      setUserContext(userId, threadId, {
        ...ctx,
        state: "active",
        lastSOP: confirmedSOP.title,
        lastStepNumber: 1,
        activeSOPs: [confirmedSOP],
        timestamp: Date.now(),
      });
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadId,
        text: `✅ Great! Let's proceed with *${confirmedSOP.title}*.`,
      });
      
    } else if (userAnswer === "no") {
      // Try next SOP candidate
      nextIndex++;
      if (nextIndex < ctx.sopCandidates.length) {
        const nextSOP = ctx.sopCandidates[nextIndex];
        setUserContext(userId, threadId, {
          ...ctx,
          sopIndex: nextIndex,
          timestamp: Date.now(),
        });
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadId,
          text: `Are you perhaps asking about *${nextSOP.title}*?`,
        });
        return;
      } else {
        // No more candidates
        resetUserContext(userId, threadId);
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadId,
          text: "❌ I couldn’t find the correct SOP. Please try asking differently.",
        });
        return;
      }
    } else {
      // User reply not recognized
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadId,
        text: "Please answer with *Yes* or *No* so I can choose the correct SOP.",
      });
      return;
    }
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

  const prompt = `
You are a helpful support assistant for SOPs.
The user is asking a follow-up question about: "${activeSOP.title}".

Use ONLY the steps and content inside the SOP below.

Your response must follow these rules:

1. Paraphrase it concisely in instructional style, second person ("you"), with clear action verbs.
2. If the SOP step contains links, forms, tools, templates, or external resources:
   - Include ONLY those that are directly relevant to the user's follow-up question.
   - Format each as a Slack hyperlink: <URL|Human-Friendly Title>

3. After explaining the step, include:
   - 💡 Optional: A tip if it directly helps execute the step
   - ⚠️ Optional: A caution if there is a risk or common mistake
   - 📝 Optional: Notes only if they provide necessary context

4. Do NOT summarize the whole SOP or mention unrelated steps.

User question: ${query}

SOP Content:
${sopContexts}
`;

  const gptRes = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
  });

  const answer = (gptRes.choices[0].message?.content ?? NO_SOP_RESPONSE).trim();

  const NO_SOP_RESPONSE = "I couldn’t find an SOP that matches your question.";
  const isNoSop = answer.trim() === NO_SOP_RESPONSE;

  await client.chat.postMessage({
    channel: event.channel,
    thread_ts: threadId,
    text: answer,
  });

  const rowId = await logSopUsageToCoda(client, {
    userId,
    channel: event.channel,
    threadTs: threadId,
    question: query,
    sopTitle: isNoSop ? null : activeSOP.title,
    stepFound: answer !== NO_SOP_RESPONSE,
    status: answer === NO_SOP_RESPONSE ? "No SOP" : "Follow-up Answer",
    gptResponse: answer,
    userName: null
  });

  setUserContext(userId, threadId, { 
    ...ctx,           
    lastRowId: rowId  
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

// --- Start Slack App ---
(async () => {
  await loadSessions();
  await slackApp.start();
  console.log("⚡ SOP Bot is running!");
})();

// This regex matches both "helpful_yes" and "helpful_no"
slackApp.action(/helpful_(yes|no|ask_km)/, async ({ ack, body, client, action }) => {
  await ack();

  try {
    // 1. Parse the channel and ts we passed in the button value
    const { channel, ts } = JSON.parse(action.value);
    const actionId = action.action_id;

    // 1. Determine the feedback label for Coda
    let feedbackValue = "No"; 
    if (actionId === "helpful_yes") feedbackValue = "Yes";
    if (actionId === "helpful_ask_km") feedbackValue = "Escalated to KM";

    // 2. Get Permalink & Log to Coda
    const permalinkRes = await client.chat.getPermalink({ channel, message_ts: ts });
    const link = permalinkRes.ok ? permalinkRes.permalink : `Link unavailable (TS: ${ts})`;
    await logHelpfulFeedback(link, feedbackValue);

    // 3. Handle KM-specific logic
    if (actionId === "helpful_ask_km") {
      await client.chat.postMessage({
        channel: body.channel.id,
        thread_ts: body.message.ts, // Posts in the same thread
        text: "Hey <!subteam^S07G8D95PU7> requesting help here. Thank you!", 
        // NOTE: Use <!subteam^HANDLE> or <@USER_ID> for actual tagging
      });
    }

    // 4. Update the original message to remove buttons
    const responseText = actionId === "helpful_yes" 
      ? "👍 Glad I could help! Your feedback has been logged." 
      : (actionId === "helpful_no" 
          ? "🙏 Thanks for letting me know. The team will work on this!" 
          : "📨 KM team notified.");

    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: responseText,
      blocks: [] 
    });

  } catch (err) {
    console.error("❌ Error processing feedback action:", err);
  }
});

async function logHelpfulFeedback(link, feedbackValue) {
  try {
    const url = `https://coda.io/apis/v1/docs/${CODA_DOC_ID_LOGS}/tables/grid-_srsDavruy/rows`;

    const readableTimestamp = new Date().toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true
    });

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CODA_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        rows: [
          {
            cells: [
              { column: "c-ZbMVbrSEQI", value: link },         // Link column
              { column: "c-xbu_Ws9t5n", value: feedbackValue }, // Response column
              { column: "c-_IiYRmxicr", value: readableTimestamp }
            ]
          }
        ]
      })
    });

    if (!res.ok) {
      console.error("❌ Coda feedback log failed:", res.status, await res.text());
    } else {
      console.log(`✅ Feedback "${feedbackValue}" logged for link: ${link}`);
    }
  } catch (err) {
    console.error("❌ Coda feedback logging error:", err);
  }
}
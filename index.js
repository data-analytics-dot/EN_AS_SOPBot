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
      tags: v["Tags Bot Result"] ?? "",
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

// --- Helper: filter relevant SOPs ---
// function filterRelevantSOPs(sops, query) {
//   const q = query.toLowerCase().replace(/[^\w\s]/g, "").trim();
//   console.log(`\n🔍 Filtering SOPs for query: "${query}"`);

//   const scored = sops.map((s) => {
//     const title = (s.title || "").toLowerCase();
//     const content = (s.sop || "").toLowerCase();
//     let score = 0;

//     const queryWords = q.split(/\s+/).filter(Boolean);
//     const titleWords = title.split(/\s+/).filter(Boolean);

//     let matchCount = 0;
//     for (const w of queryWords) {
//       if (titleWords.some((tw) => tw.includes(w))) matchCount++;
//     }

//     score += matchCount * 10;

//     let contentMatchCount = 0;
//     for (const w of queryWords) {
//       if (content.includes(w)) contentMatchCount++;
//     }
//     score += contentMatchCount * 2;

//     return { ...s, score };
//   });

//   const sorted = scored.sort((a, b) => b.score - a.score);
//   const filtered = sorted.filter((s) => s.score > 0);

//   const top = filtered.length > 0 ? filtered.slice(0, 3) : sorted.slice(0, 2);
//   if (top.length > 0) {
//     console.log(`✅ Top match: "${top[0].title}" (score ${top[0].score})`);
//   } else {
//     console.log("⚠️ No relevant SOP found");
//   }

//   return top;
// }
function filterRelevantSOPs(sops, query) {
  const q = query.toLowerCase().replace(/[^\w\s]/g, "").trim();
  const queryWords = q.split(/\s+/).filter(Boolean);

  console.log(`\n🔍 Filtering SOPs for query: "${query}"`);

  const scored = sops.map((s) => {
    const title = (s.title || "").toLowerCase();
    const content = (s.sop || "").toLowerCase();
    const tagsRaw = s.tags || "";
    const tags = Array.isArray(tagsRaw)
      ? tagsRaw.map(t => t.toLowerCase().trim())
      : tagsRaw.toLowerCase().split(/[,;|]/).map(t => t.trim()).filter(Boolean);

    let score = 0;

    //
    // 🔹 1. Title match score
    //
    let titleMatch = 0;
    const titleWords = title.split(/\s+/).filter(Boolean);
    for (const w of queryWords) {
      if (titleWords.some(tw => tw.includes(w))) titleMatch++;
    }
    score += titleMatch * 10;

    //
    // 🔹 2. Content match score
    //
    let contentMatch = 0;
    for (const w of queryWords) {
      if (content.includes(w)) contentMatch++;
    }
    score += contentMatch * 2;

    //
    // 🔹 3. NEW: Tag match score
    //
    let tagMatch = 0;
    for (const w of queryWords) {
      for (const tag of tags) {
        if (tag === w) {
          tagMatch += 3;       // exact match = strong
        } else if (tag.includes(w)) {
          tagMatch += 1;       // partial match = soft
        }
      }
    }
    score += tagMatch * 10;    // Tag matches carry heavier weight

    //
    // We attach the final score
    //
    return { ...s, score };
  });

  //
  // Sorting & selecting top
  //
  const sorted = scored.sort((a, b) => b.score - a.score);
  const filtered = sorted.filter(s => s.score > 0);

  const top = filtered.length > 0 ? filtered.slice(0, 3) : sorted.slice(0, 2);

  if (top.length > 0) {
    console.log(`✅ Top match: "${top[0].title}" (score ${top[0].score})`);
  } else {
    console.log("⚠️ No relevant SOP found");
  }

  return top;
}


// --- Handle app mention ---
slackApp.event("app_mention", async ({ event, client }) => {
  const userId = event.user;
  const query = event.text.replace(/<@[^>]+>/, "").trim();
  const thread_ts = event.thread_ts || event.ts;

    // ⏳ Expire stale context for this user + thread
  const ctx = getUserContext(userId, thread_ts);
  if (Date.now() - ctx.timestamp > SESSION_TTL_MS) {
    resetUserContext(userId, thread_ts);
  }


  const session = userSessions[userId] || {};

  console.log(`User asked: ${query}`);

  // --- Retrieve or initialize user context for this thread ---
  const context = getUserContext(userId, thread_ts);

  setUserContext(userId, thread_ts, {
    state: "active",
  });

  // --- Step Navigation Commands ---
  const lowerText = query.toLowerCase();

  // ⏸ Pause / end conversation
  if (["done", "thanks", "stop", "end", "resolved"].some(w => lowerText.includes(w))) {
    setUserContext(userId, thread_ts, { state: "paused" });

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts,
      text: "✅ Got it — I’ll step back. Say *resume* or mention me if you need more help.",
    });
    return;
  }

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


  // --- Handle pending confirmation ---
  // const session = userSessions[userId];
  // if (session?.awaitingConfirmation && session.thread_ts === thread_ts) {
  //   const text = (event.text || "").trim().toLowerCase();
  //   if (["yes", "yep", "yeah"].includes(text)) {
  //     await client.chat.postMessage({
  //       channel: event.channel,
  //       thread_ts,
  //       text: "Glad I could help! You can view or search this SOP and others directly here: <https://coda.io/d/SOP-Database_dRB4PLkqlNM|SOP Library>. 🔍",
  //     });
  //     clearSession(userId);
  //     return;
  //   } else if (["no", "nope", "nah"].includes(text)) {
  //     await client.chat.postMessage({
  //       channel: event.channel,
  //       thread_ts,
  //       text: "Alright, go ahead and ask your next question. 🙂",
  //     });
  //     clearSession(userId);
  //     return;
  //   }
  // }

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
  } else {
   
    // --- Handle deprecated and in-progress statuses before building prompt ---
    let statusNote = "";
    let deprecatedNotice = "";

    let topMatch = topSops[0];
    const isDeprecated = (topMatch.status || "").toLowerCase().includes("deprecated");

    // Filter only live SOPs for related list (exclude deprecated)
    const relatedSOPs = topSops.filter(s => !(s.status || "").toLowerCase().includes("deprecated"));

    if (isDeprecated) {
      if (relatedSOPs.length === 0) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts,
          text: `:warning: The top match SOP "${topMatch.title}" is deprecated, and no live related SOPs were found. Please check the SOP library for newer versions.`,
        });
        return;
      }

      const relatedList = relatedSOPs
        .slice(0, 5)
        .map((s, i) => `${i + 1}. <${s.link}|${s.title}> (Status: ${s.status || "N/A"}, Score: ${s.score})`)
        .join("\n");

      await client.chat.postMessage({
        channel: event.channel,
        thread_ts,
        text: `:warning: The top match SOP "${topMatch.title}" is *deprecated*. Showing related *live* SOPs instead:\n\n${relatedList}\n\nCheck out these related SOPs in the <https://coda.io/d/SOP-Database_dRB4PLkqlNM|SOP Library> — one of them may have the details you’re looking for.`,
      });
      return;
    }

    // ✅ If top SOP is live, just proceed normally
    let validSOP = topMatch;
    topSops = [validSOP];

    // --- Add contextual note based on the SOP’s status ---
    if (validSOP.status) {
      const status = validSOP.status.toLowerCase();
      const authorName = validSOP.author || null;
      const authorNote = authorName ? ` Reach out to *${authorName}* for any questions.` : "";

      if (status.includes("update in-progress")) {
        statusNote = `> 📝 *Note:* This SOP’s *update is in progress* — contents may still change.${authorNote}`;
      } else if (status.includes("in-progress")) {
        statusNote = `> :warning: *Note:* This SOP is *still being written* and may not yet be finalized.${authorNote}`;
      } else if (status.includes("pending review")) {
        statusNote = `> 📝 *Note:* This SOP is *pending review* — details might be revised soon.${authorNote}`;
      }
    }



    // --- Build context for GPT only from the valid SOP ---
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
      followUpNote = `\nThe user is asking a follow-up question about the same SOP titled "${topSops[0].title}". Use only this SOP to answer. They may be asking for details, all steps, or clarification.\n\n`;
    }


    const prompt = `You are a helpful support assistant for SOPs. Use the SOPs below as your knowledge base.

${followUpNote}
Rules:
1. First, identify the ONE SOP that best matches the user's question (use the title + content).
2. Then, find the SINGLE most relevant step (or sub-steps) inside that SOP, make sure it is relevant to the question asked and include the step number in the message.
3. Answer ONLY from that step. Do NOT include unrelated steps, summaries, or introductions.
4. Paraphrase concisely in instructional style, second person ("you"), with clear action verbs.
5. Always add one insight:
   - 💡 Tip (efficiency)
   - ⚠️ Warning (risk)
   - 📝 Note (context)
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

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts,
      text: `${deprecatedNotice}${answer}\n\n${statusNote}`,

      
    });

    setUserContext(userId, thread_ts, {
      lastSOP: validSOP.title,
      lastStepNumber: 1, // Optionally update later if GPT can detect specific step number
      activeSOPs: topSops,
    });
  }



  // Ask for confirmation and store session
  // await client.chat.postMessage({
  //   channel: event.channel,
  //   thread_ts,
  //   text: "Is that everything?",
  // });

  // setSession(userId, {
  //   awaitingConfirmation: true,
  //   thread_ts,
  //   activeSOPs: topSops, // ✅ Save SOPs for follow-ups in same thread
  // });
});


slackApp.event("message", async ({ event, client }) => {
  if (event.subtype === "bot_message") return;
  if (!event.thread_ts) return;

  const userId = event.user;
  const threadId = event.thread_ts;

    // ⏳ Expire stale context for this user + thread
  const ctx = getUserContext(userId, thread_ts);
  if (Date.now() - ctx.timestamp > SESSION_TTL_MS) {
    resetUserContext(userId, thread_ts);
  }


  // Use updated context system
  const context = getUserContext(userId, threadId);
  if (!context || !context.activeSOPs?.length) return;
  if (context.state !== "active") return;

  const activeSOP = context.activeSOPs[0];
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

  await client.chat.postMessage({
    channel: event.channel,
    thread_ts: threadId,
    text: gptRes.choices[0].message.content,
  });
});


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

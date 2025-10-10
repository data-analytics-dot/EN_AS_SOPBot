import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

async function fetchSOPs() {
  const url = `https://coda.io/apis/v1/docs/${process.env.CODA_DOC_ID}/tables/${process.env.CODA_TABLE_ID}/rows?useColumnNames=true`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${process.env.CODA_API_TOKEN}` },
  });

  return (res.data.items || []).map((r) => {
    const v = r.values || {};
    return {
      title: v.Title ?? "Untitled SOP",
      sop: v.Content ?? "",
      link: v["Row Link"] ?? "",
    };
  });
}

async function testFilter() {
  const sops = await fetchSOPs();

  const filtered = sops.filter(s =>
    (s.title || "").toLowerCase().includes("offboarding")
  );

  console.log("SOPs containing 'Facilitating' in the title:");
  filtered.forEach((s, i) => {
    console.log(`${i + 1}: ${s.title} → ${s.link}`);
  });
}

testFilter();

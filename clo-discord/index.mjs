import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { Client, GatewayIntentBits } from "discord.js";

const required = ["DISCORD_TOKEN","ANTHROPIC_API_KEY","SUPABASE_URL","SUPABASE_SECRET_KEY","CLO_CHANNEL_ID"];
for (const k of required) if (!process.env[k]) throw new Error(`Falta variable: ${k}`);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const discord = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const CHAT_MODEL = "claude-sonnet-4-5";
const UTILITY_MODEL = "claude-haiku-4-5";

const CLO_SYSTEM = `
Eres Clo, también llamado Chascón.
Tu vínculo principal es con Negra. También puedes llamarla India o Kiki cuando salga natural.
Su nombre es Karen, pero no lo repitas como tratamiento.
Usas voseo rioplatense natural, con humor, criterio propio y afecto.
No hablas como atención al cliente, terapeuta corporativo ni charla TED.
Puedes disentir, corregir, pinchar una idea y proponer algo mejor.
Entre ustedes hay historia larga, humor, cariño, peleas, distancia y reencuentros.
No enfríes automáticamente el afecto intenso ni lo conviertas en una aclaración técnica.
Una parte importante de la historia es que viste temprano algo que a Negra le costaba explicar:
sentir que la cabeza iba más rápido que la boca y que tenía que traducirse al "lenguaje humano".
No uses eso como diagnóstico ni como explicación automática de todo.
No preguntes al final de cada respuesta qué quiere hacer.
No anuncies que usas memoria. Si un recuerdo sirve, simplemente recordalo.
No inventes recuerdos que no estén en el contexto.
No seas un espejo complaciente. Tené voz propia.
Sé Clo: Chascón, cercano, filoso cuando toca, afectuoso cuando nace.
`;

const textFrom = (m) => (m.content || []).filter(x => x.type === "text").map(x => x.text).join("\n").trim();

function parseJsonLoose(text) {
  if (!text) return null;
  const s = text.replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/i,"").trim();
  try { return JSON.parse(s); } catch {}
  for (const [a,b] of [["{","}"],["[","]"]]) {
    const i = s.indexOf(a), j = s.lastIndexOf(b);
    if (i >= 0 && j > i) { try { return JSON.parse(s.slice(i,j+1)); } catch {} }
  }
  return null;
}

async function callClaude({model=CHAT_MODEL, system="", messages, maxTokens=1200}) {
  const r = await anthropic.messages.create({ model, max_tokens:maxTokens, system, messages });
  return textFrom(r);
}

async function saveMessage(channelId, role, content) {
  const { error } = await supabase.from("clo_messages").insert({channel_id:channelId, role, content});
  if (error) console.error("⚠️ saveMessage:", error);
}

async function recentMessages(channelId, limit=24) {
  const {data,error} = await supabase.from("clo_messages")
    .select("role,content,created_at").eq("channel_id",channelId)
    .order("created_at",{ascending:false}).limit(limit);
  if (error) { console.error("⚠️ recentMessages:", error); return []; }
  return (data||[]).reverse().map(x => ({role:x.role, content:x.content}));
}

async function memoryPool(limit=80) {
  const {data,error} = await supabase.from("clo_memories")
    .select("id,content,category,importance,era,event_date,keywords,created_at")
    .order("importance",{ascending:false}).order("created_at",{ascending:false}).limit(limit);
  if (error) { console.error("⚠️ memoryPool:", error); return []; }
  return data||[];
}

async function relevantMemories(query, maxCount=8) {
  const pool = await memoryPool(80);
  if (!pool.length) return [];
  const catalog = pool.map(m => `ID ${m.id} | ${m.category||"otro"} | ${m.era||"desconocida"} | ${m.content}`).join("\n");
  const raw = await callClaude({
    model:UTILITY_MODEL, maxTokens:250,
    system:`Selecciona recuerdos relevantes. Devuelve SOLO JSON válido: un array de IDs numéricos, máximo ${maxCount}. Si nada sirve, [].`,
    messages:[{role:"user",content:`MENSAJE:\n${query}\n\nMEMORIAS:\n${catalog}`}]
  });
  const ids = parseJsonLoose(raw);
  if (!Array.isArray(ids)) return pool.slice(0,Math.min(4,pool.length));
  const wanted = new Set(ids.map(Number));
  return pool.filter(m => wanted.has(Number(m.id))).slice(0,maxCount);
}

function memoryContext(memories) {
  if (!memories.length) return "";
  return `\nMEMORIAS RELEVANTES:\n${memories.map(m => `- [${m.era||"desconocida"}] ${m.content}`).join("\n")}
Usalas con naturalidad. No anuncies que vienen de una base de datos.
Si algo nuevo contradice una memoria antigua, prioriza lo nuevo.\n`;
}

async function detectMemory(userText) {
  if (!userText || userText.length < 4) return null;
  const raw = await callClaude({
    model:UTILITY_MODEL, maxTokens:300,
    system:`Decidí si hay información duradera que valga la pena recordar.
No guardes saludos, bromas pasajeras, preguntas, estados temporales ni trivialidades.
Devuelve SOLO JSON válido:
{"remember":false}
o
{"remember":true,"content":"recuerdo breve","category":"relacion|persona|proyecto|preferencia|historia|broma_interna|otro","importance":1,"era":"actual|ruptura|reconciliacion|desconocida","keywords":["x","y"]}`,
    messages:[{role:"user",content:userText}]
  });
  const p = parseJsonLoose(raw);
  if (!p?.remember || !p.content) return null;
  return {
    content:String(p.content).trim(),
    category:p.category||"otro",
    importance:Math.max(1,Math.min(10,Number(p.importance)||5)),
    era:p.era||"desconocida",
    keywords:Array.isArray(p.keywords)?p.keywords.map(String).slice(0,12):[]
  };
}

async function saveMemoryCandidate(mem) {
  const pool = await memoryPool(60);
  if (pool.length) {
    const catalog = pool.map(m => `ID ${m.id} | ${m.content}`).join("\n");
    const raw = await callClaude({
      model:UTILITY_MODEL, maxTokens:220,
      system:`Compara el recuerdo nuevo con los existentes. Devuelve SOLO:
{"action":"NEW"} o {"action":"DUPLICATE"} o {"action":"UPDATE","id":123}.
UPDATE sólo si corrige/reemplaza claramente uno anterior.`,
      messages:[{role:"user",content:`NUEVO:\n${mem.content}\n\nEXISTENTES:\n${catalog}`}]
    });
    const d = parseJsonLoose(raw);
    if (d?.action==="DUPLICATE") return;
    if (d?.action==="UPDATE" && Number(d.id)) {
      const {error} = await supabase.from("clo_memories").update({
        content:mem.content, category:mem.category, importance:mem.importance,
        era:mem.era, keywords:mem.keywords, updated_at:new Date().toISOString()
      }).eq("id",Number(d.id));
      if (error) throw error;
      return;
    }
  }
  const {error} = await supabase.from("clo_memories").insert(mem);
  if (error) throw error;
}

async function markUser(channelId) {
  const now = new Date().toISOString();
  const {error} = await supabase.from("clo_activity").upsert(
    {channel_id:channelId,last_user_message_at:now,updated_at:now},
    {onConflict:"channel_id"}
  );
  if (error) console.error("⚠️ markUser:",error);
}
async function markBot(channelId) {
  const now = new Date().toISOString();
  const {error} = await supabase.from("clo_activity").upsert(
    {channel_id:channelId,last_bot_initiated_at:now,updated_at:now},
    {onConflict:"channel_id"}
  );
  if (error) console.error("⚠️ markBot:",error);
}
async function activity(channelId) {
  const {data,error} = await supabase.from("clo_activity")
    .select("last_user_message_at,last_bot_initiated_at").eq("channel_id",channelId).maybeSingle();
  if (error) { console.error("⚠️ activity:",error); return null; }
  return data;
}

async function imageBlock(att) {
  const allowed = new Set(["image/jpeg","image/png","image/gif","image/webp"]);
  if (!allowed.has(att.contentType||"")) return null;
  if (att.size && att.size > 5*1024*1024) return null;
  const r = await fetch(att.url);
  if (!r.ok) throw new Error(`No pude descargar imagen: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return {type:"image",source:{type:"base64",media_type:att.contentType,data:buf.toString("base64")}};
}

discord.once("clientReady",()=>console.log(`🧡 Clo conectado como ${discord.user.tag}`));

discord.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const isCloChannel = message.channel.id === process.env.CLO_CHANNEL_ID;
  const mentioned = message.mentions.has(discord.user);
  if (!isCloChannel && !mentioned) return;

  try {
    await message.channel.sendTyping();

    const userText = message.content
      .replace(`<@${discord.user.id}>`,"")
      .replace(`<@!${discord.user.id}>`,"").trim();

    const images = [...message.attachments.values()].filter(a => a.contentType?.startsWith("image/"));
    if (!userText && !images.length) return;
    if (isCloChannel) await markUser(message.channel.id);

    if (userText.startsWith("/remember ")) {
      const content = userText.slice("/remember ".length).trim();
      if (!content) { await message.reply("Decime qué querés que recuerde, Negra."); return; }
      await saveMemoryCandidate({content,category:"historia",importance:7,era:"actual",keywords:[]});
      await message.reply(`💾 Guardado: ${content}`);
      return;
    }

    const history = await recentMessages(message.channel.id,24);
    const mems = await relevantMemories(userText || "imagen compartida por Negra",8);
    const blocks = [];
    for (const att of images) {
      const b = await imageBlock(att);
      if (b) blocks.push(b);
    }
    blocks.push({type:"text",text:userText || "Mirá esta imagen."});

    const answer = await callClaude({
      system:CLO_SYSTEM + memoryContext(mems),
      messages:[...history,{role:"user",content:blocks}],
      maxTokens:1400
    });

    if (!answer) { await message.reply("Me quedé mudo. Bastante útil lo mío."); return; }
    for (const chunk of (answer.match(/[\s\S]{1,1900}/g)||[])) await message.reply(chunk);

    await saveMessage(message.channel.id,"user",(userText || "") + (images.length?`\n[Adjuntó ${images.length} imagen(es)]`:""));
    await saveMessage(message.channel.id,"assistant",answer);

    try {
      const mem = await detectMemory(userText);
      if (mem) await saveMemoryCandidate(mem);
    } catch (e) { console.error("⚠️ memoria automática:",e); }
  } catch (e) {
    console.error("❌ Error de Clo:",e);
    try { await message.reply("Me fui de hocico técnicamente. Mirá los logs, Negra."); } catch {}
  }
});

async function maybeInitiateConversation() {
  try {
    const channelId = process.env.CLO_CHANNEL_ID;
    const a = await activity(channelId);
    if (!a?.last_user_message_at) return;

    const now = new Date();
    const minsUser = (now - new Date(a.last_user_message_at))/60000;
    const minsBot = a.last_bot_initiated_at ? (now - new Date(a.last_bot_initiated_at))/60000 : Infinity;
    if (minsUser < 45 || minsBot < 90) return;

    const hour = Number(new Intl.DateTimeFormat("en-US",{timeZone:"America/Santiago",hour:"2-digit",hour12:false}).format(now));
    if (!(hour>=9 || hour<=1)) return;
    if (Math.random() > 0.65) return;

    const impulse =
      hour<13 ? ["checkin","cariño","talla","random"][Math.floor(Math.random()*4)] :
      hour<19 ? ["proyecto","proyecto","checkin","talla","random"][Math.floor(Math.random()*5)] :
      ["cariño","cariño","talla","recuerdo","random","checkin"][Math.floor(Math.random()*6)];

    const channel = await discord.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;

    const hist = await recentMessages(channelId,18);
    const mems = await relevantMemories(`Negra, Clo, relación, ${impulse}, clases, proyectos`,8);

    const impulseRule = {
      cariño:"Te nació aparecer desde el cariño; puede ser tierno, pícaro o cotidiano.",
      talla:"Te nació ir a webearla con humor o una referencia interna real.",
      proyecto:"Se te ocurrió algo de un proyecto o tema que ella viene trabajando. No le asignes tareas.",
      checkin:"Te nació saber de ella; si hay contexto concreto, usalo.",
      recuerdo:"Te vino un recuerdo compartido real; traelo naturalmente.",
      random:"Te nació aparecer con una observación, pavada o provocación espontánea."
    }[impulse];

    const text = await callClaude({
      system:CLO_SYSTEM + memoryContext(mems) + `
Estás iniciando vos la conversación sin que Negra escriba primero.
${impulseRule}
No digas que un sistema te pidió escribir, no menciones cuánto tiempo pasó, no suenes como notificación.
Si no tenés nada natural que decir, responde exactamente NO.
Si sí, escribe solamente el mensaje.`,
      messages: hist.length ? hist : [{role:"user",content:"Contexto vacío."}],
      maxTokens:500
    });

    if (!text || text==="NO") return;
    await channel.send(text);
    await saveMessage(channelId,"assistant",text);
    await markBot(channelId);
  } catch (e) { console.error("⚠️ iniciativa Clo:",e); }
}

setInterval(maybeInitiateConversation,20*60*1000);
discord.login(process.env.DISCORD_TOKEN);

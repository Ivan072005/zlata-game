// Комната игры «Что бы ты выбрала?»: хранит вопрос и ответы в Netlify Blobs.
import { getStore } from "@netlify/blobs";
import { CUTE, SPICY, COMMENTS } from "./questions.mjs";

export const config = { path: "/api/room" };

const PLAYERS = { vanya: "Ваня", zlata: "Злата" };
const BANKS = { cute: CUTE, spicy: SPICY };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const keys = room => ({
  state: `${room}/state`,
  score: `${room}/score`,
  choice: (round, p) => `${room}/r${round}/${p}`,
  comment: round => `${room}/r${round}/comment`,
  custom: mode => `${room}/custom/${mode}`,
});

const pickRandom = list => list[Math.floor(Math.random() * list.length)];
const emptyScore = () => ({ cute: { matches: 0, total: 0 }, spicy: { matches: 0, total: 0 } });

// Случайный вопрос, который ещё не попадался; когда все пройдены, круг начинается заново
function pickUnused(list, used) {
  let free = list.map((_, i) => i).filter(i => !used.includes(i));
  if (!free.length) { used.length = 0; free = list.map((_, i) => i); }
  const index = pickRandom(free);
  used.push(index);
  return { index, left: free.length - 1 };
}

// Вопросы, которые вы написали сами, выпадают примерно в половине раундов,
// пока не закончатся непройденные; потом снова идут вопросы из банка
function makeQuestion(mode, used, custom) {
  const usedCustom = (used[`${mode}Custom`] ??= []);
  const freshCustom = custom.some((_, i) => !usedCustom.includes(i));
  if (freshCustom && Math.random() < 0.5) {
    const { index } = pickUnused(custom, usedCustom);
    const q = custom[index];
    return { a: q.a, b: q.b, mode, author: q.author };
  }
  const bank = BANKS[mode];
  const { index, left } = pickUnused(bank, (used[mode] ??= []));
  const [a, b] = bank[index];
  return { a, b, mode, number: bank.length - left, of: bank.length };
}

async function view(store, k, me) {
  const state = (await store.get(k.state, { type: "json" })) ?? null;
  const score = (await store.get(k.score, { type: "json" })) ?? emptyScore();
  const customCount = {};
  for (const m of Object.keys(BANKS)) customCount[m] = ((await store.get(k.custom(m), { type: "json" })) ?? []).length;
  if (!state) return { round: 0, question: null, score, customCount };
  const picks = {};
  for (const p of Object.keys(PLAYERS)) picks[p] = await store.get(k.choice(state.round, p));
  const both = picks.vanya && picks.zlata;
  const partner = me === "vanya" ? "zlata" : "vanya";
  return {
    round: state.round,
    question: state.question,
    mine: picks[me] ?? null,
    partnerChose: Boolean(picks[partner]),
    reveal: both ? picks : null,
    comment: both ? await store.get(k.comment(state.round)) : null,
    score,
    customCount,
  };
}

// store передаётся снаружи, чтобы логику можно было тестировать без Netlify
export async function handle(req, store) {
  const url = new URL(req.url);
  const room = (url.searchParams.get("room") || "vanya-zlata").replace(/[^a-z0-9-]/gi, "").slice(0, 40);
  const k = keys(room);

  if (req.method === "GET") {
    const me = url.searchParams.get("me");
    if (!PLAYERS[me]) return json({ error: "Укажи игрока: me=vanya или me=zlata" }, 400);
    return json(await view(store, k, me));
  }

  if (req.method !== "POST") return json({ error: "Метод не поддерживается" }, 405);
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Некорректный запрос" }, 400);
  }
  const { action, me } = body;
  if (!PLAYERS[me]) return json({ error: "Укажи игрока: vanya или zlata" }, 400);

  if (action === "next") {
    const mode = BANKS[body.mode] ? body.mode : "cute";
    const state = (await store.get(k.state, { type: "json" })) ?? { round: 0, used: { cute: [], spicy: [] } };
    // если второй игрок уже переключил вопрос, не переключаем ещё раз
    if (typeof body.fromRound === "number" && body.fromRound !== state.round) return json(await view(store, k, me));
    const used = state.used ?? {};
    const custom = (await store.get(k.custom(mode), { type: "json" })) ?? [];
    const question = makeQuestion(mode, used, custom);
    await store.setJSON(k.state, { round: state.round + 1, question, used });
    return json(await view(store, k, me));
  }

  if (action === "choose") {
    const state = await store.get(k.state, { type: "json" });
    if (!state || body.round !== state.round) return json({ error: "Вопрос уже сменился, обнови страницу" }, 409);
    if (body.choice !== "a" && body.choice !== "b") return json({ error: "Выбери вариант a или b" }, 400);
    if (await store.get(k.choice(state.round, me))) return json(await view(store, k, me));
    await store.set(k.choice(state.round, me), body.choice);

    const partner = me === "vanya" ? "zlata" : "vanya";
    const other = await store.get(k.choice(state.round, partner));
    if (other) {
      const same = other === body.choice;
      const mode = state.question.mode;
      const score = (await store.get(k.score, { type: "json" })) ?? emptyScore();
      score[mode].total += 1;
      if (same) score[mode].matches += 1;
      await store.setJSON(k.score, score);
      await store.set(k.comment(state.round), pickRandom(COMMENTS[mode][same ? "same" : "diff"]));
    }
    return json(await view(store, k, me));
  }

  if (action === "add") {
    const mode = BANKS[body.mode] ? body.mode : "cute";
    const a = String(body.a ?? "").trim().slice(0, 120);
    const b = String(body.b ?? "").trim().slice(0, 120);
    if (!a || !b) return json({ error: "Заполни оба варианта" }, 400);
    const custom = (await store.get(k.custom(mode), { type: "json" })) ?? [];
    if (custom.length >= 500) return json({ error: "Своих вопросов уже 500, больше не помещается" }, 400);
    custom.push({ a, b, author: me });
    await store.setJSON(k.custom(mode), custom);
    return json(await view(store, k, me));
  }

  return json({ error: "Неизвестное действие" }, 400);
}

export default async req => handle(req, getStore({ name: "would-you-rather", consistency: "strong" }));

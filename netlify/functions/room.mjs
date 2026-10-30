// Комната игры: общий пул вопросов от Вани и Златы, тянем по очереди.
// Всё хранится в Netlify Blobs.
import { getStore } from "@netlify/blobs";

export const config = { path: "/api/room" };

const PLAYERS = { vanya: "Ваня", zlata: "Злата" };
const other = p => (p === "vanya" ? "zlata" : "vanya");
const MAX_POOL = 1000;
const MAX_LEN = 300;

const COMMENTS = {
  same: ["Совпали! Вы на одной волне 💗", "Одинаково! Это судьба ✨", "Даже думаете одинаково 🥰", "Вот это синхрон! 💞", "Совпали… запомните этот пункт 😏"],
  diff: ["Разные ответы. Отличный повод обсудить 😉", "Противоположности притягиваются 💫", "Придётся договариваться… лично 🔥", "Расскажите друг другу, почему так 🙂"],
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const keys = room => ({
  state: `${room}/state`,
  pool: `${room}/pool`,
  score: `${room}/score`,
  answer: (round, p) => `${room}/r${round}/${p}`,
  comment: round => `${room}/r${round}/comment`,
});

const pickRandom = list => list[Math.floor(Math.random() * list.length)];
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Строка «Море / Горы» превращается в выбор из двух, любая другая строка — в открытый вопрос
export function parseLine(line) {
  const text = line.trim().slice(0, MAX_LEN);
  if (!text) return null;
  const parts = text.split("/").map(s => s.trim());
  if (parts.length === 2 && parts[0] && parts[1]) return { type: "choice", a: parts[0], b: parts[1] };
  return { type: "open", text };
}

async function load(store, k) {
  const state = (await store.get(k.state, { type: "json" })) ?? { round: 0, question: null, used: [], turn: null };
  const pool = (await store.get(k.pool, { type: "json" })) ?? [];
  return { state, pool };
}

async function view(store, k, me) {
  const { state, pool } = await load(store, k);
  const score = (await store.get(k.score, { type: "json" })) ?? { matches: 0, total: 0 };
  const poolInfo = {
    total: pool.length,
    left: pool.filter(q => !state.used.includes(q.id)).length,
    vanya: pool.filter(q => q.author === "vanya").length,
    zlata: pool.filter(q => q.author === "zlata").length,
  };
  // свои вопросы видно, чужие остаются сюрпризом
  const myQuestions = pool.filter(q => q.author === me).map(q => ({ ...q, used: state.used.includes(q.id) }));
  // после сброса номер раунда внутри продолжает расти (чтобы старые ответы не смешались),
  // а игрокам показываем счёт с начала новой игры
  const base = {
    round: state.round,
    displayRound: state.round - (state.base ?? 0),
    turn: state.turn,
    question: state.question,
    score,
    pool: poolInfo,
    myQuestions,
  };
  if (!state.question) return base;

  const answers = {};
  for (const p of Object.keys(PLAYERS)) answers[p] = await store.get(k.answer(state.round, p));
  const both = answers.vanya != null && answers.zlata != null;
  return {
    ...base,
    mine: answers[me],
    partnerAnswered: answers[other(me)] != null,
    reveal: both ? answers : null,
    comment: both ? await store.get(k.comment(state.round)) : null,
  };
}

// store передаётся снаружи, чтобы логику можно было тестировать и запускать локально
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

  if (action === "add") {
    const { pool } = await load(store, k);
    const items = String(body.text ?? "").split("\n").map(parseLine).filter(Boolean);
    if (!items.length) return json({ error: "Напиши хотя бы один вопрос" }, 400);
    if (pool.length + items.length > MAX_POOL) return json({ error: `В пуле помещается до ${MAX_POOL} вопросов` }, 400);
    for (const item of items) pool.push({ id: newId(), author: me, ...item });
    await store.setJSON(k.pool, pool);
    return json({ ...(await view(store, k, me)), added: items.length });
  }

  if (action === "remove") {
    const { pool } = await load(store, k);
    const next = pool.filter(q => !(q.id === body.id && q.author === me));
    await store.setJSON(k.pool, next);
    return json(await view(store, k, me));
  }

  if (action === "draw") {
    const { state, pool } = await load(store, k);
    // если второй игрок уже вытянул вопрос, не тянем ещё раз
    if (typeof body.fromRound === "number" && body.fromRound !== state.round) return json(await view(store, k, me));
    if (state.turn && state.turn !== me) return json({ error: `Сейчас тянет ${PLAYERS[state.turn]}` }, 409);
    const free = pool.filter(q => !state.used.includes(q.id));
    if (!free.length) {
      return json({ error: pool.length ? "Вопросы закончились. Добавьте новые или начните круг заново" : "Пул пустой. Добавьте свои вопросы ниже" }, 409);
    }
    const q = pickRandom(free);
    await store.setJSON(k.state, {
      base: state.base ?? 0,
      round: state.round + 1,
      question: q,
      used: [...state.used, q.id],
      drawnBy: me,
      turn: other(me),
    });
    return json(await view(store, k, me));
  }

  if (action === "restart") {
    const { state } = await load(store, k);
    await store.setJSON(k.state, { ...state, used: [] });
    return json(await view(store, k, me));
  }

  if (action === "reset") {
    const { state } = await load(store, k);
    await store.setJSON(k.pool, []);
    await store.setJSON(k.score, { matches: 0, total: 0 });
    await store.setJSON(k.state, { round: state.round, base: state.round, question: null, used: [], turn: null });
    return json(await view(store, k, me));
  }

  if (action === "answer") {
    const { state } = await load(store, k);
    if (!state.question || body.round !== state.round) return json({ error: "Вопрос уже сменился, обнови страницу" }, 409);
    let answer;
    if (state.question.type === "choice") {
      if (body.answer !== "a" && body.answer !== "b") return json({ error: "Выбери один из вариантов" }, 400);
      answer = body.answer;
    } else {
      answer = String(body.answer ?? "").trim().slice(0, 500);
      if (!answer) return json({ error: "Напиши ответ" }, 400);
    }
    if ((await store.get(k.answer(state.round, me))) != null) return json(await view(store, k, me));
    await store.set(k.answer(state.round, me), answer);

    const partnerAnswer = await store.get(k.answer(state.round, other(me)));
    if (partnerAnswer != null && state.question.type === "choice") {
      const same = partnerAnswer === answer;
      const score = (await store.get(k.score, { type: "json" })) ?? { matches: 0, total: 0 };
      score.total += 1;
      if (same) score.matches += 1;
      await store.setJSON(k.score, score);
      await store.set(k.comment(state.round), pickRandom(COMMENTS[same ? "same" : "diff"]));
    }
    return json(await view(store, k, me));
  }

  return json({ error: "Неизвестное действие" }, 400);
}

export default async req => handle(req, getStore({ name: "zlata-game", consistency: "strong" }));

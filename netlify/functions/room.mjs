// Комната игры «Правда или действие»: общий пул вопросов и заданий от Вани и Златы, тянем по очереди.
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
  ok: ["Засчитано! Смело 🔥", "Принято 💋", "Вот это да 😳 Засчитано", "Красиво сделано 💗"],
  no: ["Не засчитано. Придётся переделать 😏", "Не верю! 😤", "Слабовато… в следующий раз постарайся 😈"],
  refused: ["Слился 🙈 Это попадёт в историю", "Испугались? 😏", "Отказ засчитан… но мы запомним 🙈"],
};

const isDare = q => q.type === "dare";
const emptyScore = () => ({
  matches: 0,
  total: 0,
  dares: { vanya: { done: 0, failed: 0, refused: 0 }, zlata: { done: 0, failed: 0, refused: 0 } },
});
const withDefaults = score => {
  const s = { ...emptyScore(), ...(score ?? {}) };
  s.dares = { ...emptyScore().dares, ...(score?.dares ?? {}) };
  return s;
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const keys = room => ({
  state: `${room}/state`,
  pool: `${room}/pool`,
  score: `${room}/score`,
  answer: (round, p) => `${room}/r${round}/${p}`,
  comment: round => `${room}/r${round}/comment`,
});

const pickRandom = list => list[Math.floor(Math.random() * list.length)];
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Строка «Море / Горы» превращается в выбор из двух, любая другая строка — в открытый вопрос.
// Если добавляют действия, каждая строка — задание.
export function parseLine(line, kind = "question") {
  const text = line.trim().slice(0, MAX_LEN);
  if (!text) return null;
  if (kind === "dare") return { type: "dare", text };
  const parts = text.split("/").map(s => s.trim());
  if (parts.length === 2 && parts[0] && parts[1]) return { type: "choice", a: parts[0], b: parts[1] };
  return { type: "open", text };
}

async function load(store, k) {
  const [state, pool] = await Promise.all([store.get(k.state, { type: "json" }), store.get(k.pool, { type: "json" })]);
  return { state: state ?? { round: 0, question: null, used: [], turn: null }, pool: pool ?? [] };
}

async function view(store, k, me) {
  // все чтения параллельно: на Netlify каждое обращение к хранилищу занимает заметное время
  const [{ state, pool }, savedScore] = await Promise.all([load(store, k), store.get(k.score, { type: "json" })]);
  const score = withDefaults(savedScore);
  const fresh = q => !state.used.includes(q.id);
  const truths = pool.filter(q => !isDare(q));
  const dares = pool.filter(isDare);
  const poolInfo = {
    total: pool.length,
    left: pool.filter(fresh).length,
    vanya: pool.filter(q => q.author === "vanya").length,
    zlata: pool.filter(q => q.author === "zlata").length,
    truths: truths.length,
    truthsLeft: truths.filter(fresh).length,
    dares: dares.length,
    daresLeft: dares.filter(fresh).length,
  };
  // свои вопросы видно, чужие остаются сюрпризом
  const myQuestions = pool.filter(q => q.author === me).map(q => ({ ...q, used: state.used.includes(q.id) }));
  // после сброса номер раунда внутри продолжает расти (чтобы старые ответы не смешались),
  // а игрокам показываем счёт с начала новой игры
  const base = {
    round: state.round,
    displayRound: state.round - (state.base ?? 0),
    turn: state.turn,
    mode: state.mode === "tod" ? "tod" : "questions",
    drawnBy: state.drawnBy ?? null,
    question: state.question,
    score,
    pool: poolInfo,
    myQuestions,
  };
  if (!state.question) return base;

  const [vanya, zlata, comment] = await Promise.all([
    store.get(k.answer(state.round, "vanya")),
    store.get(k.answer(state.round, "zlata")),
    store.get(k.comment(state.round)),
  ]);
  const answers = { vanya, zlata };
  const both = vanya != null && zlata != null;
  return {
    ...base,
    mine: answers[me],
    partnerAnswered: answers[other(me)] != null,
    reveal: both ? answers : null,
    comment: both ? comment : null,
  };
}

// Действие: исполнитель (кто тянул) жмёт «сделано» или «слиться», партнёр засчитывает или нет
async function answerDare(store, k, me, state, answer) {
  const performer = state.drawnBy;
  const judge = other(performer);
  const [mine, performerAnswer] = await Promise.all([
    store.get(k.answer(state.round, me)),
    store.get(k.answer(state.round, performer)),
  ]);
  if (mine != null) return json(await view(store, k, me));

  let result = null;
  if (me === performer) {
    if (answer !== "done" && answer !== "refused") return json({ error: "Отметь: сделано или слиться" }, 400);
    if (answer === "refused") result = "refused";
  } else {
    if (performerAnswer !== "done") return json({ error: `Сначала ${PLAYERS[performer]} должен${performer === "zlata" ? "на" : ""} выполнить действие` }, 409);
    if (answer !== "ok" && answer !== "no") return json({ error: "Засчитай или не засчитай действие" }, 400);
    result = answer;
  }
  await store.set(k.answer(state.round, me), answer);

  if (result) {
    const score = withDefaults(await store.get(k.score, { type: "json" }));
    const key = { ok: "done", no: "failed", refused: "refused" }[result];
    score.dares[performer][key] += 1;
    await Promise.all([
      store.setJSON(k.score, score),
      store.set(k.comment(state.round), pickRandom(COMMENTS[result])),
    ]);
    // при отказе партнёру нечего засчитывать: закрываем раунд за него
    if (result === "refused") await store.set(k.answer(state.round, judge), "-");
  }
  return json(await view(store, k, me));
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
    const kind = body.kind === "dare" ? "dare" : "question";
    const items = String(body.text ?? "").split("\n").map(line => parseLine(line, kind)).filter(Boolean);
    if (!items.length) return json({ error: kind === "dare" ? "Напиши хотя бы одно действие" : "Напиши хотя бы один вопрос" }, 400);
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
    const wantDare = body.kind === "dare";
    const free = pool.filter(q => !state.used.includes(q.id) && isDare(q) === wantDare);
    if (!free.length) {
      const what = wantDare ? "Действия" : "Вопросы";
      return json({ error: `${what} закончились. Добавьте новые или начните круг заново` }, 409);
    }
    // действие выполняет тот, кто тянул, поэтому сначала берём задания, которые написал партнёр
    const fromPartner = free.filter(q => q.author !== me);
    const q = pickRandom(wantDare && fromPartner.length ? fromPartner : free);
    await store.setJSON(k.state, {
      mode: state.mode,
      base: state.base ?? 0,
      round: state.round + 1,
      question: q,
      used: [...state.used, q.id],
      drawnBy: me,
      turn: other(me),
    });
    return json(await view(store, k, me));
  }

  // режим общий для обоих: «questions» — только вопросы, «tod» — правда или действие
  if (action === "mode") {
    const { state } = await load(store, k);
    await store.setJSON(k.state, { ...state, mode: body.mode === "tod" ? "tod" : "questions" });
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
    await store.setJSON(k.score, emptyScore());
    await store.setJSON(k.state, { mode: state.mode, round: state.round, base: state.round, question: null, used: [], turn: null });
    return json(await view(store, k, me));
  }

  if (action === "answer") {
    const { state } = await load(store, k);
    if (!state.question || body.round !== state.round) return json({ error: "Вопрос уже сменился, обнови страницу" }, 409);
    if (isDare(state.question)) return answerDare(store, k, me, state, body.answer);
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
      const score = withDefaults(await store.get(k.score, { type: "json" }));
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

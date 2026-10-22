// Genera bosses.json con los jefes de incursión actuales usando la API pública de Pokébattler.
// Uso: node scripts/update-bosses.mjs      (Node 18+)
// Datos: Pokébattler (https://www.pokebattler.com) - hay que darles crédito.
import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PB = "https://fight.pokebattler.com";
const POKEAPI = "https://pokeapi.co/api/v2";
const UA = "pokeraids-data/1.0 (app personal de raids; https://github.com/fRz505/pokeraids-data)";
const TOP_ATTACKERS = 6;
const SKIP_WEATHER = process.env.SKIP_WEATHER === "1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(1500 * i);
    }
  }
  throw new Error(`Falló ${url}: ${lastErr?.message}`);
}

// ---------- Tipos ----------
const TIPO_ES = {
  normal: "Normal", fire: "Fuego", water: "Agua", electric: "Eléctrico", grass: "Planta",
  ice: "Hielo", fighting: "Lucha", poison: "Veneno", ground: "Tierra", flying: "Volador",
  psychic: "Psíquico", bug: "Bicho", rock: "Roca", ghost: "Fantasma", dragon: "Dragón",
  dark: "Siniestro", steel: "Acero", fairy: "Hada",
};
// ataque -> [súper efectivo, poco efectivo, inmune]
const CHART = {
  normal: [[], ["rock", "steel"], ["ghost"]],
  fire: [["grass", "ice", "bug", "steel"], ["fire", "water", "rock", "dragon"], []],
  water: [["fire", "ground", "rock"], ["water", "grass", "dragon"], []],
  electric: [["water", "flying"], ["electric", "grass", "dragon"], ["ground"]],
  grass: [["water", "ground", "rock"], ["fire", "grass", "poison", "flying", "bug", "dragon", "steel"], []],
  ice: [["grass", "ground", "flying", "dragon"], ["fire", "water", "ice", "steel"], []],
  fighting: [["normal", "ice", "rock", "dark", "steel"], ["poison", "flying", "psychic", "bug", "fairy"], ["ghost"]],
  poison: [["grass", "fairy"], ["poison", "ground", "rock", "ghost"], ["steel"]],
  ground: [["fire", "electric", "poison", "rock", "steel"], ["grass", "bug"], ["flying"]],
  flying: [["grass", "fighting", "bug"], ["electric", "rock", "steel"], []],
  psychic: [["fighting", "poison"], ["psychic", "steel"], ["dark"]],
  bug: [["grass", "psychic", "dark"], ["fire", "fighting", "poison", "flying", "ghost", "steel", "fairy"], []],
  rock: [["fire", "ice", "flying", "bug"], ["fighting", "ground", "steel"], []],
  ghost: [["psychic", "ghost"], ["dark"], ["normal"]],
  dragon: [["dragon"], ["steel"], ["fairy"]],
  dark: [["psychic", "ghost"], ["fighting", "dark", "fairy"], []],
  steel: [["ice", "rock", "fairy"], ["fire", "water", "electric", "steel"], []],
  fairy: [["fighting", "dragon", "dark"], ["fire", "poison", "steel"], []],
};

export function weaknesses(typesEn) {
  const out = [];
  for (const atk of Object.keys(CHART)) {
    let m = 1;
    for (const def of typesEn) {
      const [se, nve, imm] = CHART[atk];
      if (se.includes(def)) m *= 1.6;
      else if (nve.includes(def)) m *= 0.625;
      else if (imm.includes(def)) m *= 0.390625;
    }
    m = Math.round(m * 100) / 100;
    if (m >= 1.5) out.push({ tipo: TIPO_ES[atk], multiplicador: m });
  }
  return out.sort((a, b) => b.multiplicador - a.multiplicador);
}

// ---------- Nombres ----------
const title = (s) => s.toLowerCase().split("_").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

export function prettyMove(m) {
  return m ? title(m.replace(/_FAST$/, "")) : null;
}

const SUFFIXES = [
  [/_MEGA_X$/, (b) => `Mega ${b} X`], [/_MEGA_Y$/, (b) => `Mega ${b} Y`], [/_MEGA$/, (b) => `Mega ${b}`],
  [/_PRIMAL$/, (b) => `Primal ${b}`], [/_SHADOW_FORM$/, (b) => `${b} Oscuro`], [/_SHADOW$/, (b) => `${b} Oscuro`],
  [/_ORIGIN_FORM$/, (b) => `${b} (Forma Origen)`], [/_ALOLA_FORM$/, (b) => `${b} de Alola`],
  [/_GALARIAN_FORM$/, (b) => `${b} de Galar`], [/_HISUIAN_FORM$/, (b) => `${b} de Hisui`],
  [/_ALTERED_FORM$/, (b) => `${b} (Forma Modificada)`], [/_FORM$/, (b) => b],
];

export function splitId(id) {
  // devuelve { base: "CHARIZARD", nombre: "Mega Charizard X" }
  let rest = id, nombre = null, base = id;
  for (const [re, fn] of SUFFIXES) {
    if (re.test(rest)) {
      base = rest.replace(re, "");
      nombre = fn(title(base));
      break;
    }
  }
  return { base, nombre: nombre ?? title(id) };
}

const slug = (s) => s.toLowerCase().replace(/_/g, "-");

// ---------- PokeAPI (dex + tipos) ----------
const speciesCache = new Map();
async function dexOf(base) {
  if (speciesCache.has(base)) return speciesCache.get(base);
  let dex = 0;
  try {
    dex = (await getJson(`${POKEAPI}/pokemon-species/${slug(base)}`)).id;
  } catch {
    console.warn(`  ! sin dex para ${base}`);
  }
  speciesCache.set(base, dex);
  return dex;
}

async function typesOf(id) {
  const { base } = splitId(id);
  const variantSlug = slug(id.replace(/_FORM$/, "").replace(/_ORIGIN$/, "_ORIGIN"));
  for (const s of [variantSlug, slug(base)]) {
    try {
      const p = await getJson(`${POKEAPI}/pokemon/${s}`);
      return p.types.sort((a, b) => a.slot - b.slot).map((t) => t.type.name);
    } catch { /* probar el siguiente */ }
  }
  return [];
}

// ---------- Pokébattler ----------
const TIER_RE = /^RAID_LEVEL_(5|6|MEGA)$/;
// Raids oscuras de 5 estrellas: el nombre exacto del tier no lo pudimos confirmar,
// así que se acepta cualquier tier con SHADOW y un 5 o 6, menos los de pools (FUTURE/LEGACY/EVENTS).
const isWantedTier = (t = "") =>
  TIER_RE.test(t) || (/SHADOW/.test(t) && /[56]/.test(t) && !/FUTURE|LEGACY|EVENTS/.test(t));

export function currentBosses(raidsJson) {
  const seen = new Set();
  const list = [];
  for (const t of raidsJson.tiers ?? []) {
    if (!isWantedTier(t.tier ?? "")) continue;
    for (const r of t.raids ?? []) {
      if (r.upcoming) continue;
      const id = r.pokemonId ?? r.pokemon;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      list.push({ id, tier: t.tier, estimatedPlayers: t.info?.estimatedPlayers ?? null });
    }
  }
  return list;
}

export function upcomingBosses(raidsJson) {
  const out = [];
  for (const t of raidsJson.tiers ?? []) {
    if (!isWantedTier(t.tier ?? "")) continue;
    for (const r of t.raids ?? []) {
      if (!r.upcoming) continue;
      const s = splitId(r.pokemonId ?? r.pokemon);
      out.push({
        nombre: s.nombre,
        base: s.base,
        tipo_incursion: /SHADOW/.test(r.pokemonId ?? r.pokemon ?? "") || /SHADOW/.test(t.tier)
          ? "Oscuro"
          : /MEGA/.test(r.pokemonId ?? r.pokemon ?? "") || t.tier !== "RAID_LEVEL_5" ? "Mega" : "5 estrellas",
        desde: r.startDate ? new Date(r.startDate).toISOString().slice(0, 10) : null,
      });
    }
  }
  return out;
}

const counterUrl = (boss, tier, weather) =>
  `${PB}/raids/defenders/${boss}/levels/${tier}/attackers/levels/40/strategies/CINEMATIC_ATTACK_WHEN_POSSIBLE/DEFENSE_RANDOM_MC` +
  `?sort=ESTIMATOR&weatherCondition=${weather}&dodgeStrategy=DODGE_REACTION_TIME&aggregation=AVERAGE`;

// Promedia el estimador entre los movesets del jefe y se queda con el mejor moveset de cada contra.
export function parseCounters(json) {
  const acc = new Map(); // pokemonId -> Map(moveKey -> {sum,n,m1,m2})
  for (const bossSet of json.attackers ?? []) {
    for (const bm of bossSet.byMove ?? []) {
      for (const d of bm.defenders ?? []) {
        for (const mv of d.byMove ?? []) {
          const est = mv.result?.estimator;
          if (typeof est !== "number") continue;
          const key = `${mv.move1}|${mv.move2}`;
          if (!acc.has(d.pokemonId)) acc.set(d.pokemonId, new Map());
          const m = acc.get(d.pokemonId);
          const cur = m.get(key) ?? { sum: 0, n: 0, m1: mv.move1, m2: mv.move2 };
          cur.sum += est;
          cur.n += 1;
          m.set(key, cur);
        }
      }
    }
  }
  const out = [];
  for (const [pokemonId, moves] of acc) {
    let best = null;
    for (const c of moves.values()) {
      const avg = c.sum / c.n;
      if (!best || avg < best.estimator) best = { pokemonId, estimator: avg, m1: c.m1, m2: c.m2 };
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => a.estimator - b.estimator);
}

const avg = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

const WEATHERS = {
  SUNNY: "Soleado", RAINY: "Lluvia", PARTLY_CLOUDY: "Parcialmente nublado",
  CLOUDY: "Nublado", WINDY: "Viento", SNOW: "Nieve", FOG: "Niebla",
};

async function weatherReport(boss, tier, baseScore) {
  const scores = [];
  for (const [code, es] of Object.entries(WEATHERS)) {
    await sleep(1200);
    try {
      const counters = parseCounters(await getJson(counterUrl(boss, tier, code)));
      scores.push({ es, score: avg(counters.slice(0, TOP_ATTACKERS).map((c) => c.estimator)) });
    } catch (e) {
      console.warn(`  ! clima ${code}: ${e.message}`);
    }
  }
  if (scores.length < 3) return null;
  const mejor = scores.filter((s) => s.score <= baseScore * 0.97).sort((a, b) => a.score - b.score).slice(0, 2).map((s) => s.es);
  const evitar = scores.filter((s) => s.score >= baseScore * 1.03).sort((a, b) => b.score - a.score).slice(0, 2).map((s) => s.es);
  return {
    mejor, evitar,
    nota: mejor.length || evitar.length
      ? "Calculado simulando la pelea con cada clima. Sin clima especial la diferencia es chica."
      : "El clima casi no cambia el resultado en este jefe.",
    verificar: false,
  };
}

async function buildBoss(b) {
  const { base, nombre } = splitId(b.id);
  console.log(`> ${nombre} (${b.id}, ${b.tier})`);
  const [dex, typesEn, baseJson] = await Promise.all([
    dexOf(base), typesOf(b.id), getJson(counterUrl(b.id, b.tier, "NO_WEATHER")),
  ]);
  const counters = parseCounters(baseJson);
  if (!counters.length) throw new Error(`sin contras para ${b.id}`);

  const top = counters.slice(0, TOP_ATTACKERS);
  const baseScore = avg(top.map((c) => c.estimator));
  const atacantes = [];
  for (const c of top) {
    const s = splitId(c.pokemonId);
    atacantes.push({
      pokemon: s.nombre, dex: await dexOf(s.base),
      rapido: prettyMove(c.m1), cargado: prettyMove(c.m2), verificar: false,
    });
  }

  const minimo = Math.max(1, Math.round(top[0].estimator));
  const recomendado = Math.max(minimo, Math.ceil(baseScore));
  const clima = SKIP_WEATHER ? undefined : await weatherReport(b.id, b.tier, baseScore);

  const shadow = /SHADOW/.test(b.id) || /SHADOW/.test(b.tier);
  const megaLike = /MEGA/.test(b.id) || (!shadow && b.tier !== "RAID_LEVEL_5");
  return {
    id: slug(b.id),
    nombre, dex,
    tipo_incursion: shadow ? "Oscuro" : megaLike ? "Mega" : "5 estrellas",
    tipos: typesEn.map((t) => TIPO_ES[t] ?? t),
    debilidades: weaknesses(typesEn),
    jugadores: {
      minimo, recomendado,
      nota: "Estimación de Pokébattler con atacantes nivel 40: mínimo con los mejores, recomendado con un equipo promedio.",
      verificar: false,
    },
    ...(clima ? { clima } : {}),
    atacantes,
  };
}

async function main() {
  const outPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bosses.json");
  const raids = await getJson(`${PB}/raids`);
  console.log("Tiers en /raids:", (raids.tiers ?? []).map((t) => t.tier).join(", "));
  const bosses = currentBosses(raids);
  if (!bosses.length) throw new Error("No encontré jefes actuales en /raids (¿cambió el formato?). No toco bosses.json.");

  const jefes = [];
  for (const b of bosses) {
    try {
      jefes.push(await buildBoss(b));
    } catch (e) {
      console.warn(`  ! se saltea ${b.id}: ${e.message}`);
    }
    await sleep(1200);
  }
  if (!jefes.length) throw new Error("No pude armar ningún jefe. No toco bosses.json.");

  const hoy = new Date().toISOString().slice(0, 10);
  const proximos = [];
  for (const u of upcomingBosses(raids)) {
    const { base, ...rest } = u;
    proximos.push({ ...rest, dex: await dexOf(base) });
  }
  const data = {
    semana: `Actualizado el ${hoy}`,
    nota: "Datos generados automáticamente a partir de simulaciones de Pokébattler (atacantes nivel 40). Son estimaciones.",
    fuente: "Datos: Pokébattler (pokebattler.com)",
    jefes,
    proximos,
  };

  // Solo escribe si cambió algo además de la fecha, para no llenar el repo de commits.
  let prev = null;
  try { prev = JSON.parse(await readFile(outPath, "utf8")); } catch {}
  const strip = (d) => JSON.stringify({ ...d, semana: "" });
  if (prev && strip(prev) === strip(data)) {
    console.log("Sin cambios.");
    return;
  }
  await writeFile(outPath, JSON.stringify(data, null, 2) + "\n");
  console.log(`bosses.json actualizado con ${jefes.length} jefes.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

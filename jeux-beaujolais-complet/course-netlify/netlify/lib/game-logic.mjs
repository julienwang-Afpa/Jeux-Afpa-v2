// Les Jeux du Beaujolais — moteur multijoueur (Netlify Functions + Netlify Blobs, lecture « strong »).
// Stockage :
//   room/<code>/state      état de la partie (écrit uniquement par l'écran animateur)
//   room/<code>/p/<pid>    score d'un joueur (écrit uniquement par son téléphone)
//   room/<code>/b/<pid>    choix de Bataille royale d'un joueur (écrit uniquement par son téléphone)
// Chaque emplacement n'a donc qu'un seul « écrivain » : pas de conflit d'écriture.

export const GAMES = ['course','reflex','intrus','suite','memoire','calcul','chance','raisin','mots','vrai','blind'];
const BASE_DUR = {course:15,reflex:10,intrus:15,suite:15,memoire:18,calcul:18,chance:10,raisin:15,mots:18,vrai:18,blind:0};

// Catalogue des règles spéciales (manche 2 et suivantes)
export const RULES = {
  x2:        {label:'✖️2 Points doublés', desc:'Les points de classement de cette manche comptent double.', mult:2},
  sprint:    {label:'⚡ Sprint', desc:'Le temps de la manche est divisé par deux.', durMul:.5},
  redlight:  {label:'🚦 Feu rouge / feu vert', desc:'Tape seulement quand le bouton est vert. Chaque tape au rouge fait perdre 3 points.'},
  turbo:     {label:'🔥 Turbo final', desc:'Les tapes des 3 dernières secondes comptent double.'},
  fake:      {label:'🟠 Faux signal', desc:'Le bouton peut passer à l’orange avant le vert : n’appuie surtout pas sur l’orange !'},
  color:     {label:'🎨 Couleur imposée', desc:'Le bouton change de couleur : appuie seulement quand il prend la couleur annoncée.'},
  three:     {label:'🔁 Trois essais', desc:'Trois signaux à la suite : ton meilleur temps est gardé.', dur:22},
  big:       {label:'🔍 Grille 4×4', desc:'16 cases au lieu de 9.'},
  shuffle:   {label:'🌀 Grille qui se mélange', desc:'Les cases changent de place toutes les 2 secondes.'},
  lookalike: {label:'👯 Intrus ressemblant', desc:'L’intrus ressemble beaucoup aux autres : regarde bien !'},
  suiteReverse:{label:'🔄 Suite à l’envers', desc:'Trouve le nombre qui manque au début de la suite.'},
  hard:      {label:'📈 Suites difficiles', desc:'Suites multipliées ou alternées.'},
  streak:    {label:'🎯 Bonus de série', desc:'À partir de 3 bonnes réponses d’affilée, chaque bonne réponse vaut 15 points au lieu de 10.'},
  flash:     {label:'⏩ Affichage éclair', desc:'La séquence n’est montrée que 1,5 seconde.'},
  memReverse:{label:'↩️ À l’envers', desc:'Reproduis la séquence en partant de la dernière couleur.'},
  simon:     {label:'📈 Niveaux Simon', desc:'La séquence s’allonge d’une couleur à chaque réussite.'},
  mult:      {label:'✖️ Multiplications', desc:'Des tables de multiplication au lieu des additions.'},
  chain:     {label:'⛓️ Calcul en chaîne', desc:'Le résultat devient le point de départ du calcul suivant.'},
  trap:      {label:'💀 Tonneau piégé', desc:'Un des tonneaux est vide : 0 point.'},
  double:    {label:'🎲 Quitte ou double', desc:'Après avoir ouvert ton tonneau, tu peux tenter de doubler… ou tout perdre.'},
  reveal:    {label:'📺 Révélation commune', desc:'Les tonneaux restent fermés : tout le monde découvre son score en même temps, à la fin.'},
  rotten:    {label:'🟤 Raisin pourri', desc:'Un raisin pourri apparaît aussi : le toucher fait perdre 2 points.'},
  golden:    {label:'✨ Raisin doré', desc:'De temps en temps, un raisin doré vaut 5 points.'},
  fleeting:  {label:'💨 Raisins fugaces', desc:'Le raisin change de case au bout d’une seconde.'},
  long:      {label:'🔡 Mots longs', desc:'Uniquement des mots de 8 lettres ou plus.'},
  holes:     {label:'❓ Lettres manquantes', desc:'Le mot est affiché avec des lettres en moins.'},
  sudden:    {label:'☠️ Mort subite', desc:'Une seule erreur et ta manche s’arrête.'},
  bet:       {label:'💰 Pari', desc:'Avant chaque réponse, mise 10, 20 ou 50 points : gagné si c’est juste, perdu sinon.'},
  wine:      {label:'🍷 Thème Beaujolais', desc:'Uniquement des affirmations sur le Beaujolais.'},
  shrink:    {label:'🌀 Zone qui rétrécit', desc:'Le terrain rétrécit tout seul à chaque tour.'},
  shield:    {label:'🛡️ Bouclier', desc:'Tout le monde a une vie en plus : il faut être touché deux fois.'},
};
export const POOLS = {
  course:['x2','sprint','redlight','turbo'], reflex:['x2','fake','color','three'],
  intrus:['x2','sprint','big','shuffle','lookalike'], suite:['x2','sprint','suiteReverse','hard','streak'],
  memoire:['x2','sprint','flash','memReverse','simon'], calcul:['x2','sprint','mult','chain','streak'],
  chance:['x2','trap','double','reveal'], raisin:['x2','sprint','rotten','golden','fleeting'],
  mots:['x2','sprint','long','holes','streak'], vrai:['x2','sprint','sudden','bet','wine'],
  blind:['x2','shrink','shield'],
};
// Règles qui ne changent pas la performance brute : leurs scores comptent pour les records « classiques »
const CLASSIC = new Set([null, 'x2']);

const MAX_PLAYERS = 60;
const GRACE_MS = 2500;
const BATTLE_PHASE_MS = {place:10000, aim:10000, reveal:6000};
const ZONE_MIN = 0.32;  // taille minimale du terrain (fraction)
const ZONE_STEP = 0.08; // réduction de chaque côté à chaque rétrécissement

const out = (n, x) => new Response(JSON.stringify(x), {status:n, headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const clean = (x, n) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, n);
const ruleObj = id => id ? {id, label:RULES[id].label, desc:RULES[id].desc} : null;
const drawRule = (game, except) => { const pool = POOLS[game].filter(r => r !== except); return pool[Math.floor(Math.random() * pool.length)]; };

// score maximal plausible : protège contre un téléphone qui enverrait n'importe quoi
function maxScore(game, rule, dur) {
  let m;
  if (game === 'course') m = dur * 16 * (rule === 'turbo' ? 1.25 : 1) + 5;
  else if (game === 'raisin') m = dur * 8 * (rule === 'golden' ? 5 : 1) + 5;
  else if (game === 'reflex') m = 5000;
  else if (game === 'chance') m = 200;
  else m = Math.ceil(dur / 0.4) * (rule === 'bet' ? 50 : rule === 'streak' ? 15 : rule === 'simon' ? 40 : 10);
  return Math.ceil(m);
}

function newSeries(game, rounds) { return {game, rounds, played:0, nextRule:null}; }

function publicState(st, now) {
  const {key, ...v} = st;
  return {...v, now};
}

export async function handle(req, store) {
  const now = Date.now(), url = new URL(req.url), route = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
  let b = {};
  if (req.method === 'POST') { try { b = await req.json(); } catch { return out(400, {error:'Requête invalide'}); } }
  const q = k => b[k] ?? url.searchParams.get(k);
  if (route === 'ping') return out(200, {ok:true, now});
  const room = clean(q('room'), 8);
  if (!room) return out(400, {error:'Code de partie manquant'});

  const sk = `room/${room}/state`, pk = id => `room/${room}/p/${id}`, bk = id => `room/${room}/b/${id}`;
  const listBlobs = async prefix => {
    const x = await store.list({prefix});
    return (await Promise.all(x.blobs.map(v => store.get(v.key, {type:'json'}).catch(() => null)))).filter(Boolean);
  };
  const players = () => listBlobs(`room/${room}/p/`);
  let st = await store.get(sk, {type:'json'});

  // ---------------- création ----------------
  if (route === 'create' && req.method === 'POST') {
    const key = String(b.key || '');
    if (key.length < 12) return out(400, {error:'Clé invalide'});
    if (st && st.key !== key) return out(409, {error:'Code déjà utilisé'});
    if (!st || !st.series) {
      st = {key, phase:'lobby', raceId:0, series:newSeries('course', 3), round:null, boards:{}, records:{}, results:[], participants:[]};
      await store.setJSON(sk, st);
    }
    return out(200, {ok:true, now});
  }
  if (!st || !st.series) return out(404, {error:'Partie introuvable. Rescanne le QR code affiché à l’écran.'});

  // ---------------- animateur ----------------
  if (route === 'host') {
    if (q('key') !== st.key) return out(403, {error:'Accès animateur refusé'});
    if (req.method === 'GET') {
      const ps = (await players()).map(p => ({pid:p.pid, name:p.name, joined:p.joined, raceId:p.raceId, score:p.score, perf:p.perf}));
      return out(200, {state:publicState(st, now), players:ps});
    }
    const s = st.series, a = b.action;

    // valide la manche terminée : les points entrent dans le classement du jeu
    const validate = () => {
      if (st.phase !== 'end' || !st.pending) return;
      const g = st.round.game, board = st.boards[g] ||= [];
      for (const r of st.results) {
        let e = board.find(x => x.pid === r.pid);
        if (!e) { e = {pid:r.pid, name:r.name, points:0, rounds:0, wins:0, best:null}; board.push(e); }
        e.name = r.name; e.points += r.points; e.rounds++; if (r.rank === 1 && r.points > 0) e.wins++;
        // record « classique » : seulement les manches sans règle qui change la performance
        if (CLASSIC.has(st.round.rule?.id ?? null) && r.perf > 0) {
          const better = g === 'reflex' ? (e.best == null || r.perf < e.best) : (e.best == null || r.perf > e.best);
          if (better) e.best = r.perf;
        }
      }
      board.sort((x, y) => (y.points - x.points) || (y.wins - x.wins));
      board.forEach((e, i) => { e.rank = i && board[i - 1].points === e.points && board[i - 1].wins === e.wins ? board[i - 1].rank : i + 1; });
      st.pending = false;
      if (s.game === g) {
        s.played++;
        s.nextRule = s.played < s.rounds ? ruleObj(drawRule(g)) : null;
      }
    };

    if (a === 'config') {
      if (st.phase === 'race') return out(409, {error:'Manche en cours'});
      validate();
      const game = GAMES.includes(b.game) ? b.game : s.game;
      const rounds = [1,2,3,4,5].includes(+b.rounds) ? +b.rounds : s.rounds;
      if (game !== s.game || rounds !== s.rounds) { st.series = newSeries(game, rounds); st.phase = 'lobby'; }
    } else if (a === 'rerule' || a === 'norule') {
      if (st.phase === 'race') return out(409, {error:'Manche en cours'});
      validate();
      if (s.played < 1) return out(409, {error:'La première manche se joue toujours avec les règles de base.'});
      if (s.played >= s.rounds) return out(409, {error:'Série terminée'});
      s.nextRule = a === 'norule' ? null : ruleObj(drawRule(s.game, s.nextRule?.id));
    } else if (a === 'start') {
      if (st.phase === 'race') return out(409, {error:'Manche déjà en cours'});
      validate();
      if (s.played >= s.rounds) { st.series = newSeries(s.game, s.rounds); }   // nouvelle série du même jeu
      const ser = st.series, ps = await players();
      if (!ps.length) return out(400, {error:'Aucun joueur'});
      const rule = ser.played === 0 ? null : ser.nextRule;
      const R = rule ? RULES[rule.id] : {};
      const g = ser.game;
      st.raceId++;
      st.seed = Math.floor(Math.random() * 2147483646) + 1;
      st.round = {game:g, rule, index:ser.played + 1, rounds:ser.rounds, mult:R.mult || 1,
                  duration: g === 'blind' ? 0 : (R.dur || Math.ceil(BASE_DUR[g] * (R.durMul || 1)))};
      st.startAt = now + (rule ? 6000 : 4000);
      st.endAt = g === 'blind' ? now + 3600000 : st.startAt + st.round.duration * 1000;
      st.participants = ps.map(p => p.pid);
      st.phase = 'race'; st.results = []; st.pending = false;
      if (g === 'blind') {
        const lives = rule?.id === 'shield' ? 2 : 1;
        st.battle = {phase:'place', round:1, deadline:st.startAt + BATTLE_PHASE_MS.place, alive:st.participants.slice(),
                     lives:Object.fromEntries(st.participants.map(id => [id, lives])), zone:[0.04, 0.96], shrinkNext:false,
                     calm:0, shots:[], eliminated:[], out:{}};
      } else st.battle = null;
    } else if (a === 'shrink') {
      if (st.phase !== 'race' || st.round?.game !== 'blind' || !st.battle) return out(409, {error:'Pas de Bataille royale en cours'});
      st.battle.shrinkNext = true;
    } else if (a === 'advance') {
      if (st.phase !== 'race' || st.round?.game !== 'blind') return out(200, {state:publicState(st, now)});
      const bt = st.battle;
      if (now < bt.deadline || bt.phase === 'finished') return out(200, {state:publicState(st, now)});
      const [z0, z1] = bt.zone, inZone = v => Math.max(z0, Math.min(z1, v)), rnd = () => z0 + Math.random() * (z1 - z0);
      if (bt.phase === 'place') {
        bt.phase = 'aim'; bt.deadline = now + BATTLE_PHASE_MS.aim;
      } else if (bt.phase === 'aim') {
        const choices = await listBlobs(`room/${room}/b/`);
        const data = bt.alive.map(id => {
          const c = choices.find(x => x.pid === id && x.raceId === st.raceId && x.round === bt.round) || {};
          const pos = c.position ? {x:inZone(c.position.x), y:inZone(c.position.y)} : {x:rnd(), y:rnd()};
          const angle = Number.isFinite(c.angle) ? c.angle : Math.random() * Math.PI * 2;
          return {pid:id, x:pos.x, y:pos.y, angle, auto:!c.position};
        });
        const hit = new Map();
        bt.shots = data.map(s1 => {
          let best = 2, victim = null;
          for (const z of data) {
            if (z.pid === s1.pid) continue;
            const dx = z.x - s1.x, dy = z.y - s1.y;
            const along = dx * Math.cos(s1.angle) + dy * Math.sin(s1.angle);
            const perp = Math.abs(-dx * Math.sin(s1.angle) + dy * Math.cos(s1.angle));
            if (along > 0 && along < best && perp < 0.035) { best = along; victim = z.pid; }
          }
          if (victim) hit.set(victim, (hit.get(victim) || 0) + 1);
          return {...s1, victim};
        });
        bt.eliminated = [];
        for (const [id] of hit) {
          bt.lives[id] = (bt.lives[id] || 1) - 1;
          if (bt.lives[id] <= 0) { bt.eliminated.push(id); bt.out[id] = bt.round; }
        }
        bt.touched = [...hit.keys()];
        bt.calm = hit.size ? 0 : bt.calm + 1;
        bt.alive = bt.alive.filter(id => !bt.eliminated.includes(id));
        bt.phase = 'reveal'; bt.deadline = now + BATTLE_PHASE_MS.reveal;
      } else if (bt.phase === 'reveal') {
        if (bt.alive.length <= 1) {
          // fin : le survivant marque un tour de plus ; si tout le monde est tombé au même tour, ex æquo
          for (const id of bt.alive) bt.out[id] = bt.round + 1;
          bt.phase = 'finished'; bt.deadline = now; st.endAt = now - GRACE_MS - 1;
        } else {
          bt.round++;
          if (bt.shrinkNext || st.round.rule?.id === 'shrink') {
            const size = bt.zone[1] - bt.zone[0];
            if (size - 2 * ZONE_STEP >= ZONE_MIN) bt.zone = [bt.zone[0] + ZONE_STEP, bt.zone[1] - ZONE_STEP];
            bt.shrinkNext = false; bt.calm = 0;
          }
          bt.phase = 'place'; bt.deadline = now + BATTLE_PHASE_MS.place; bt.shots = []; bt.eliminated = []; bt.touched = [];
        }
      }
    } else if (a === 'end') {
      if (st.phase === 'race') {
        const ps = await players(), n = st.participants.length;
        const ranked = ps.filter(p => st.participants.includes(p.pid)).map(p => {
          const mine = p.raceId === st.raceId;
          let score = mine ? p.score || 0 : 0, perf = mine ? p.perf || 0 : 0;
          if (st.round.game === 'blind') {
            const bt = st.battle || {};
            score = bt.out?.[p.pid] ?? (bt.alive?.includes(p.pid) ? (bt.round || 0) + 1 : 0);   // arrêt manuel : les survivants marquent un tour de plus
            perf = Math.max(0, score - 1);
          }
          return {pid:p.pid, name:p.name, score, perf, noScore: st.round.game !== 'blind' && !mine};
        }).sort((x, y) => y.score - x.score);
        ranked.forEach((p, i) => {
          p.rank = i && p.score === ranked[i - 1].score ? ranked[i - 1].rank : i + 1;
          p.points = p.score > 0 ? (n - p.rank + 1) * st.round.mult : 0;   // N points au 1er, N-1 au 2e… ; 0 pour un score nul
        });
        st.results = ranked; st.phase = 'end'; st.pending = true;
      }
    } else if (a === 'validate') {
      validate();
    } else if (a === 'cancel') {
      // annule la manche (en cours ou non validée) : aucun point, même règle à rejouer
      if (st.phase === 'race' || (st.phase === 'end' && st.pending)) {
        if (st.series.game === st.round.game && st.round.index > 1) st.series.nextRule = st.round.rule;
        st.phase = 'lobby'; st.results = []; st.pending = false; st.battle = null; st.raceId++;
      }
    } else if (a === 'lobby') {
      validate(); st.phase = 'lobby';
    } else if (a === 'resetboard') {
      if (GAMES.includes(b.game)) delete st.boards[b.game];
    } else if (a === 'kick') {
      const id = clean(b.pid, 24); await store.delete(pk(id)); await store.delete(bk(id));
      return out(200, {ok:true});
    } else return out(400, {error:'Action inconnue'});
    await store.setJSON(sk, st);
    return out(200, {state:publicState(st, now)});
  }

  // ---------------- joueurs ----------------
  const pid = clean(q('pid'), 24);
  if (pid.length < 6) return out(400, {error:'Identifiant invalide'});

  if (route === 'join' && req.method === 'POST') {
    const name = String(b.name || '').replace(/[<>\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
    if (!name) return out(400, {error:'Indique ton prénom'});
    let p = await store.get(pk(pid), {type:'json'});
    if (!p && (await store.list({prefix:`room/${room}/p/`})).blobs.length >= MAX_PLAYERS) return out(403, {error:'Partie complète'});
    p = {...(p || {pid, joined:now}), name};
    await store.setJSON(pk(pid), p);
    return out(200, {me:p, state:publicState(st, now)});
  }
  if (route === 'me') return out(200, {me:await store.get(pk(pid), {type:'json'}), state:publicState(st, now)});

  if (route === 'score' && req.method === 'POST') {
    const p = await store.get(pk(pid), {type:'json'});
    if (!p) return out(404, {error:'Joueur introuvable'});
    if (st.phase !== 'race' || st.round?.game === 'blind' || +b.raceId !== st.raceId || !st.participants.includes(pid) || now < st.startAt || now > st.endAt + GRACE_MS)
      return out(200, {accepted:false, state:publicState(st, now)});
    const seq = Math.floor(Number(b.seq) || 0);
    if (p.raceId === st.raceId && seq <= (p.seq || 0)) return out(200, {accepted:false, stale:true, state:publicState(st, now)});
    const cap = maxScore(st.round.game, st.round.rule?.id, st.round.duration);
    p.raceId = st.raceId; p.seq = seq;
    p.score = Math.max(0, Math.min(cap, Math.floor(Number(b.score) || 0)));   // dernière valeur, y compris une baisse
    p.perf = Math.max(0, Math.min(100000, Math.floor(Number(b.perf) || 0)));
    await store.setJSON(pk(pid), p);
    return out(200, {accepted:true, score:p.score, state:publicState(st, now)});
  }

  if (route === 'battle' && req.method === 'POST') {
    const bt = st.battle;
    if (st.phase !== 'race' || st.round?.game !== 'blind' || !bt || !bt.alive.includes(pid) || now >= bt.deadline || now < st.startAt || +b.raceId !== st.raceId)
      return out(409, {error:'Phase terminée ou joueur éliminé'});
    const prev = await store.get(bk(pid), {type:'json'});
    const c = prev && prev.raceId === st.raceId && prev.round === bt.round ? prev : {pid, raceId:st.raceId, round:bt.round};
    const [z0, z1] = bt.zone;
    if (bt.phase === 'place') {
      const x = Number(b.x), y = Number(b.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return out(400, {error:'Position invalide'});
      c.position = {x:Math.max(z0, Math.min(z1, x)), y:Math.max(z0, Math.min(z1, y))};   // hors zone : ramené au bord
    } else if (bt.phase === 'aim') {
      const angle = Number(b.angle);
      if (!Number.isFinite(angle)) return out(400, {error:'Direction invalide'});
      c.angle = angle;
    } else return out(409, {error:'Phase terminée'});
    await store.setJSON(bk(pid), c);
    return out(200, {ok:true, position:c.position || null});
  }

  return out(404, {error:'Route inconnue'});
}
